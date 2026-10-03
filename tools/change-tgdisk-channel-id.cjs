'use strict';

// Offline migration. Never start the application while this command runs.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync, backup } = require('node:sqlite');
const { representationSignature } = require('../server/disk-content-repository');

async function changeContentChannels(db,options,filename) {
    const revisions=db.prepare('SELECT * FROM disk_content_revisions').all();
    const anchors=db.prepare('SELECT * FROM disk_content_anchors').all();
    const files=db.prepare(`SELECT f.id,r.content_id FROM disk_files f LEFT JOIN disk_content_refs r ON r.scope=f.scope AND r.logical_file_id=f.id`).all();
    const previous={};let changed=0;
    for(const file of files){const physical=revisions.find(row=>row.content_id===file.content_id && row.state==='ACTIVE');const old=physical ? String(JSON.parse(physical.payload).channelId || '') : '';previous[old]=(previous[old] || 0)+1;if(physical && old!==options.chatId)changed++;}
    const changedRevisions=revisions.filter(row=>String(JSON.parse(row.payload).channelId || '')!==options.chatId);
    const report={mode:options.apply?'applied':'dry-run',database:filename,totalFiles:files.length,changed,changedContentRevisions:changedRevisions.length,oldChannelIds:previous,targetChatId:options.chatId};
    const keys=new Map();
    for(const row of anchors){const id=`telegram:${options.chatId}:${row.message_id}`;if(keys.has(id) && keys.get(id)!==row.id)throw new Error('目标频道下存在冲突的 Message ID；不会合并来自不同频道的消息');keys.set(id,row.id);}
    if(!options.apply || !changedRevisions.length)return report;
    const backupDir=path.join(options.dataDir,'migration-backups');fs.mkdirSync(backupDir,{recursive:true});
    report.backup=path.join(backupDir,`content-channel-id-${Date.now()}-${crypto.randomUUID()}.sqlite`);await backup(db,report.backup);
    db.exec('BEGIN IMMEDIATE');
    try {
        db.exec('PRAGMA defer_foreign_keys=ON');
        const current=db.prepare('SELECT * FROM disk_content_revisions').all();
        if(JSON.stringify(current)!==JSON.stringify(revisions))throw new Error('备份期间 Content 数据发生变化；请先停止全部服务');
        for(const row of changedRevisions){const physical=JSON.parse(row.payload);physical.channelId=options.chatId;const size=db.prepare('SELECT size FROM disk_contents WHERE id=?').get(row.content_id).size;db.prepare('UPDATE disk_content_revisions SET payload=?,signature=? WHERE content_id=? AND revision=?').run(JSON.stringify(physical),representationSignature({...physical,size}),row.content_id,row.revision);}
        for(const row of anchors){const id=`telegram:${options.chatId}:${row.message_id}`;db.prepare('UPDATE disk_content_parts SET selected_anchor_id=? WHERE selected_anchor_id=?').run(id,row.id);db.prepare('UPDATE disk_content_anchors SET id=?,channel_id=? WHERE id=?').run(id,options.chatId,row.id);}
        for(const row of db.prepare('SELECT id,payload FROM disk_content_cleanup').all()){const value=JSON.parse(row.payload);value.channelId=options.chatId;db.prepare('UPDATE disk_content_cleanup SET payload=? WHERE id=?').run(JSON.stringify(value),row.id);}
        if(db.prepare("SELECT 1 FROM sqlite_master WHERE name='disk_content_caption_jobs'").get())for(const row of db.prepare('SELECT id,payload FROM disk_content_caption_jobs').all()){
            const value=JSON.parse(row.payload);value.channelId=options.chatId;value.caption=value.caption.replace(/^channel_id: .*$/m,'channel_id: '+options.chatId);
            db.prepare('UPDATE disk_content_caption_jobs SET id=?,payload=? WHERE id=?').run(`telegram:${options.chatId}:${value.messageId}`,JSON.stringify(value),row.id);
        }
        if(db.prepare('PRAGMA foreign_key_check').all().length)throw new Error('外键核验失败');
        db.exec('COMMIT');return report;
    }catch(error){if(db.isTransaction)db.exec('ROLLBACK');throw error;}
}

function args(argv, env = process.env) {
    // Keep the CLI's cwd-relative default; an explicit argument takes precedence.
    const result = { dataDir: path.resolve(env.TUNNEL_DATA_DIR || '.tunnel-data'), apply: false, stopped: false };
    const value = (index, flag) => {
        if (!argv[index] || argv[index].startsWith('--')) throw new Error(`${flag} 缺少参数值`);
        return argv[index];
    };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--data-dir') result.dataDir = path.resolve(value(++i, arg));
        else if (arg === '--chat-id') result.chatId = value(++i, arg);
        else if (arg === '--apply') result.apply = true;
        else if (arg === '--service-stopped') result.stopped = true;
        else throw new Error(`未知参数：${arg}`);
    }
    if (!/^-100[1-9]\d{5,}$/.test(String(result.chatId || ''))) throw new Error('--chat-id 必须是 -100 开头的 Telegram 私有频道数字 chat_id');
    if (result.apply && !result.stopped) throw new Error('写入前请停止 Node 服务，并显式传入 --service-stopped');
    return result;
}

// Only inspect legacy indexes when SQLite is empty. Old JSON may legitimately
// remain after a successful import, so its presence alone must not block a run.
function inspectLegacyIndexes(dataDir) {
    const indexes = [], warnings = [], names = new Map();
    const failed = Symbol('legacy-read-failed');
    let unconfirmed = false;
    const unsafe = (relative, reason) => {
        unconfirmed = true;
        warnings.push(`${relative}：${reason}；无法确认旧网盘数据`);
    };
    const read = relative => {
        const filename = path.join(dataDir, relative);
        try {
            const stat = fs.lstatSync(filename, { throwIfNoEntry: false });
            if (!stat) return undefined;
            if (!stat.isFile()) { unsafe(relative, '不是普通文件'); return failed; }
            return JSON.parse(fs.readFileSync(filename, 'utf8'));
        } catch (_) { unsafe(relative, '无法读取或不是有效 JSON'); return failed; }
    };
    const index = (relative, scope) => {
        const items = read(relative);
        if (items === undefined) return;
        if (!Array.isArray(items) || items.some(item => !item || typeof item !== 'object' || Array.isArray(item) || !item.id || !item.ownerId || !item.name)) {
            if (items !== failed) unsafe(relative, '文件索引格式无效');
            indexes.push({ path: relative, scope, records: null });
            return;
        }
        indexes.push({ path: relative, scope, records: items.length });
        if (items.length && scope === null) warnings.push(`${relative}：无法从 disk-spaces.json 确定旧分区名称，请先检查分区清单`);
    };
    index('telegram-drive-index.json', '');
    const spaces = read('disk-spaces.json');
    if (spaces !== undefined && spaces !== failed) {
        if (!Array.isArray(spaces) || spaces.some(name => typeof name !== 'string' || !name || name.length > 100 || /[\u0000-\u001f]/.test(name))) unsafe('disk-spaces.json', '分区清单格式无效');
        else for (const name of spaces) names.set(crypto.createHash('sha256').update(name).digest('hex'), name);
    }
    const partitionRoot = path.join(dataDir, 'disk-spaces');
    try {
        const stat = fs.lstatSync(partitionRoot, { throwIfNoEntry: false });
        if (stat && !stat.isDirectory()) unsafe('disk-spaces', '不是普通目录');
        else if (stat) for (const entry of fs.readdirSync(partitionRoot, { withFileTypes: true })) {
            if (entry.isSymbolicLink()) { unsafe(`disk-spaces/${entry.name}`, '符号链接不参与检查'); continue; }
            if (entry.isDirectory()) index(`disk-spaces/${entry.name}/telegram-drive-index.json`, names.get(entry.name) ?? null);
        }
    } catch (_) { unsafe('disk-spaces', '无法读取旧分区目录'); }
    return { indexes, warnings, unconfirmed, totalFiles: indexes.reduce((total, item) => total + (item.records || 0), 0) };
}

async function main(argv = process.argv.slice(2)) {
    const options = args(argv);
    const filename = path.join(options.dataDir, 'disk.sqlite');
    if (!fs.existsSync(filename)) throw new Error(`找不到网盘 SQLite 数据库：${filename}`);
    const db = new DatabaseSync(filename, { readOnly: !options.apply });
    try {
        db.exec('PRAGMA busy_timeout = 5000');
        const check = db.prepare('PRAGMA integrity_check').get();
        if (check.integrity_check !== 'ok') throw new Error('SQLite 完整性检查失败，已停止迁移');
        if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'disk_files'").get())
            throw new Error('指定数据库缺少网盘 disk_files 表；请检查数据目录、disk.sqlite 路径及网盘 SQLite schema，本工具不会创建表');
        if(db.prepare("SELECT 1 FROM sqlite_master WHERE name='disk_content_revisions'").get() && db.prepare('SELECT 1 FROM disk_files LIMIT 1').get())return await changeContentChannels(db,options,filename);
        const rows = db.prepare('SELECT scope,id,payload FROM disk_files ORDER BY scope,id').all();
        const previous = new Map();
        for (const row of rows) {
            const file = JSON.parse(row.payload);
            if (file.id !== row.id) throw new Error(`文件索引 ID 不一致：${row.id}`);
            const old = String(file.channelId || '');
            previous.set(old, (previous.get(old) || 0) + 1);
        }
        const needsChange = file => String(file.channelId || '') !== options.chatId || (file.pendingRemoteCleanup || []).some(item => String(item.channelId || '') !== options.chatId);
        const changed = rows.filter(row => needsChange(JSON.parse(row.payload))).length;
        const report = { mode: options.apply ? 'applied' : 'dry-run', database: filename, totalFiles: rows.length,
            changed, oldChannelIds: Object.fromEntries(previous), targetChatId: options.chatId };
        if (!rows.length) {
            const legacy = inspectLegacyIndexes(options.dataDir);
            report.legacyIndexes = legacy.indexes;
            report.legacyTotalFiles = legacy.totalFiles;
            report.migrationRequired = legacy.totalFiles > 0;
            report.status = legacy.totalFiles ? 'legacy-json-not-imported' : legacy.unconfirmed ? 'legacy-inspection-incomplete' : 'empty';
            report.warnings = legacy.warnings;
            const migration = '确认 --data-dir 与运行服务的 TUNNEL_DATA_DIR 一致；停止所有 Node 服务后，先运行 tools/migrate-tgdisk-json-to-sqlite.cjs 预检，核对结果后再决定执行 --apply，最后重新运行本工具';
            if (legacy.totalFiles || legacy.unconfirmed) {
                report.warnings.unshift(legacy.totalFiles ? `SQLite 文件表为空，但发现 ${legacy.totalFiles} 条旧 JSON 文件记录；尚不能将该结果视为迁移完成` : 'SQLite 文件表为空，且旧索引检查未完成；尚不能认定网盘没有文件');
                report.nextStep = migration;
                if (options.apply) {
                    report.mode = 'blocked';
                    const error = new Error(`${report.warnings[0]}。${migration}`);
                    error.code = legacy.totalFiles ? 'DISK_LEGACY_MIGRATION_REQUIRED' : 'DISK_LEGACY_INSPECTION_INCOMPLETE';
                    error.report = report;
                    throw error;
                }
            } else report.message = '指定 SQLite 文件表为空，未发现非空旧文件索引；无需修改。若预期有文件，请核对运行服务实际使用的数据目录';
        }
        if (!options.apply || !changed) return report;
        const backupDir = path.join(options.dataDir, 'migration-backups');
        fs.mkdirSync(backupDir, { recursive: true });
        const backupFile = path.join(backupDir, `channel-id-${new Date().toISOString().replace(/[:.]/g, '-')}.sqlite`);
        await backup(db, backupFile);
        report.backup = backupFile;
        db.exec('BEGIN IMMEDIATE');
        try {
            const lockedRows = db.prepare('SELECT scope,id,payload FROM disk_files ORDER BY scope,id').all();
            if (lockedRows.length !== rows.length || lockedRows.some((row, index) => row.scope !== rows[index].scope || row.id !== rows[index].id || row.payload !== rows[index].payload))
                throw new Error('备份期间文件索引发生变化；请确认所有服务均已停止');
            const update = db.prepare('UPDATE disk_files SET payload = ? WHERE scope = ? AND id = ? AND payload = ?');
            for (const row of rows) {
                const file = JSON.parse(row.payload);
                if (!needsChange(file)) continue;
                file.channelId = options.chatId;
                if (Array.isArray(file.pendingRemoteCleanup)) file.pendingRemoteCleanup = file.pendingRemoteCleanup.map(item => ({ ...item, channelId: options.chatId }));
                if (update.run(JSON.stringify(file), row.scope, row.id, row.payload).changes !== 1)
                    throw new Error(`文件被并发修改：${row.scope}/${row.id}；请确认服务已停止`);
            }
            const actual = db.prepare("SELECT count(*) AS count FROM disk_files WHERE json_extract(payload, '$.channelId') = ?").get(options.chatId).count;
            if (Number(actual) !== rows.length) throw new Error('事务内核验失败');
            if (db.prepare('PRAGMA foreign_key_check').all().length) throw new Error('SQLite 外键检查失败');
            db.exec('COMMIT');
        } catch (error) { db.exec('ROLLBACK'); throw error; }
        const actual = db.prepare("SELECT count(*) AS count FROM disk_files WHERE json_extract(payload, '$.channelId') = ?").get(options.chatId).count;
        if (Number(actual) !== rows.length) throw new Error('迁移后核验失败；请先保留备份并停止服务排查');
        return report;
    } finally { db.close(); }
}

if (require.main === module) main().then(report => console.log(JSON.stringify(report, null, 2))).catch(error => {
    if (error.report) console.log(JSON.stringify(error.report, null, 2));
    console.error(`频道 ID 迁移失败：${error.message}`); process.exitCode = 1;
});
module.exports = { main, args };
