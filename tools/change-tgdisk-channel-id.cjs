'use strict';

// Offline migration. Never start the application while this command runs.
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync, backup } = require('node:sqlite');

function args(argv) {
    const result = { dataDir: path.resolve('.tunnel-data'), apply: false, stopped: false };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--data-dir') result.dataDir = path.resolve(argv[++i] || '');
        else if (arg === '--chat-id') result.chatId = argv[++i];
        else if (arg === '--apply') result.apply = true;
        else if (arg === '--service-stopped') result.stopped = true;
        else throw new Error(`未知参数：${arg}`);
    }
    if (!/^-100[1-9]\d{5,}$/.test(String(result.chatId || ''))) throw new Error('--chat-id 必须是 -100 开头的 Telegram 私有频道数字 chat_id');
    if (result.apply && !result.stopped) throw new Error('写入前请停止 Node 服务，并显式传入 --service-stopped');
    return result;
}

async function main(argv = process.argv.slice(2)) {
    const options = args(argv);
    const filename = path.join(options.dataDir, 'disk.sqlite');
    if (!fs.existsSync(filename)) throw new Error(`找不到网盘 SQLite 数据库：${filename}`);
    const db = new DatabaseSync(filename);
    try {
        db.exec('PRAGMA busy_timeout = 5000');
        const check = db.prepare('PRAGMA integrity_check').get();
        if (check.integrity_check !== 'ok') throw new Error('SQLite 完整性检查失败，已停止迁移');
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
    console.error(`频道 ID 迁移失败：${error.message}`); process.exitCode = 1;
});
module.exports = { main, args };
