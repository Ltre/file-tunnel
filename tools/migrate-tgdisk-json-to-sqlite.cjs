'use strict';

// Offline, one-time (and safely repeatable) import of the pre-SQLite disk metadata.
// Run while the Node service is stopped. This script never deletes legacy files.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const { DatabaseSync, backup } = require('node:sqlite');
const { openDiskRepository } = require('../server/disk-repository');
const { createContentRepository,physicalRecord } = require('../server/disk-content-repository');

const ARRAY_FILES = [
    ['disk-space-usage.json', 'space_usage', item => `${item.appId}:${item.userId}:${item.diskSpace}`],
    ['disk-shares.json', 'shares', item => item.id],
    ['disk-operations.json', 'operations', item => item.operation_id],
    ['disk-collaborations.json', 'collaborations', item => item.id]
];
const AUTH_KEYS = [
    ['users', item => item.id], ['apps', item => item.app_id],
    ['backends', item => item.id], ['tokens', item => item.hash]
];
const FILE_KEY = item => item.id;
const DIRECTORY_KEY = item => `${item.ownerId}:${item.path}`;
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const fail = message => { throw new Error(message); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const label = (table, scope) => scope ? `${table}（分区 ${scope}）` : table;
const stripFile=createContentRepository(()=>{throw new Error('Not a database operation');}).strip;
function sameItem(table,left,right) {
    if(table!=='files')return isDeepStrictEqual(left,right);
    if(!left || !right)return false;
    const logical=file=>{const value=stripFile(file);for(const key of ['contentId','logicalContentVersion','contentSha256','__partsHash'])delete value[key];return JSON.parse(JSON.stringify(value));};
    const physical=file=>{const value=physicalRecord(file);return JSON.parse(JSON.stringify({channelId:value.channelId,parts:value.parts,thumbnail:value.thumbnail,mediaIndex:value.mediaIndex}));};
    return isDeepStrictEqual(logical(left),logical(right)) && isDeepStrictEqual(physical(left),physical(right));
}
const CHUNK_VALUE_FIELDS = new Set(['fileId', 'fileUniqueId', 'size', 'updatedAt']);
const USAGE_FIELDS = new Set(['appId', 'userId', 'diskSpace', 'createdAt', 'lastUsedAt']);
function canRetainChunkId(existing, legacy) {
    if (existing?.key !== legacy?.key || !/^[a-f0-9]{64}:[a-f0-9]{64}:(0|[1-9]\d*)$/.test(existing.key)) return false;
    const keySize = Number(existing.key.split(':')[2]);
    if (!Number.isSafeInteger(keySize)) return false;
    return [existing.value, legacy.value].every(value => object(value)
        && Object.keys(value).every(field => CHUNK_VALUE_FIELDS.has(field))
        && typeof value.fileId === 'string' && value.fileId.length > 0
        && (value.fileUniqueId === undefined || typeof value.fileUniqueId === 'string')
        && value.size === keySize
        && (value.updatedAt === undefined || Number.isSafeInteger(value.updatedAt) && value.updatedAt >= 0));
}
function retainedChunkWarnings(report) {
    const count = report.filter(item => item.table === 'chunk_ids').reduce((sum, item) => sum + item.retainedExisting, 0);
    return count ? [`${count} 个分片哈希在旧 JSON 与 SQLite 中对应不同的有效缓存值；保留现有 SQLite 映射，其余旧映射照常导入`] : [];
}
function remapLegacyUsers(groups, repository) {
    const currentUsers = repository.load('users');
    const currentById = new Map(currentUsers.map(user => [String(user.id), user]));
    const userIds = new Map();
    for (const oldUser of groups.find(group => group.table === 'users')?.items || []) {
        const currentAtId = currentById.get(String(oldUser.id));
        if (currentAtId && (currentAtId.provider !== oldUser.provider || currentAtId.telegramId !== oldUser.telegramId))
            fail('旧用户 ID 在 SQLite 中属于不同登录身份；无法安全迁移');
        if (!oldUser.provider || !oldUser.telegramId) continue;
        const matches = currentUsers.filter(user => user.provider === oldUser.provider && user.telegramId === oldUser.telegramId);
        if (matches.length > 1) fail('SQLite 中存在重复登录身份；无法安全映射旧用户');
        if (matches.length === 1 && String(matches[0].id) !== String(oldUser.id)) userIds.set(String(oldUser.id), String(matches[0].id));
    }
    if (!userIds.size) return { groups, mappedUserIds: new Set(), count: 0 };
    const remap = value => {
        if (typeof value === 'string') return userIds.get(value) || value;
        if (Array.isArray(value)) return value.map(remap);
        if (object(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, remap(item)]));
        return value;
    };
    const related = new Set(['files', 'directories', 'users', 'space_usage', 'shares', 'operations', 'collaborations', 'cache_owners']);
    const mappedGroups = groups.map(group => {
        if (!related.has(group.table)) return group;
        const items = group.items.map(remap);
        const seen = new Set();
        for (const item of items) {
            const id = String(group.keyOf(item));
            if (seen.has(id)) fail(`${label(group.table, group.scope)} 在用户身份映射后出现重复标识；无法安全迁移`);
            seen.add(id);
        }
        return { ...group, items };
    });
    return { groups: mappedGroups, mappedUserIds: new Set(userIds.values()), count: userIds.size };
}
function sameMappedUser(existing, legacy, mappedUserIds) {
    return mappedUserIds.has(String(legacy?.id)) && existing?.id === legacy.id
        && Boolean(legacy.provider) && Boolean(legacy.telegramId)
        && existing.provider === legacy.provider && existing.telegramId === legacy.telegramId;
}
function mergeMappedUsage(existing, legacy, mappedUserIds) {
    if (!mappedUserIds.has(String(legacy?.userId)) || !object(existing) || !object(legacy)
        || existing.appId !== legacy.appId || existing.userId !== legacy.userId || existing.diskSpace !== legacy.diskSpace
        || ![existing, legacy].every(value => Object.keys(value).every(key => USAGE_FIELDS.has(key)))) return null;
    const timestamps = [existing.createdAt, legacy.createdAt, existing.lastUsedAt ?? existing.createdAt, legacy.lastUsedAt ?? legacy.createdAt];
    if (!timestamps.every(value => Number.isSafeInteger(value) && value >= 0)) return null;
    return { ...existing, createdAt: Math.min(existing.createdAt, legacy.createdAt),
        lastUsedAt: Math.max(existing.lastUsedAt ?? existing.createdAt, legacy.lastUsedAt ?? legacy.createdAt) };
}

function parseArgs(argv) {
    let dataDir = path.resolve('.tunnel-data'), scratchDir = os.tmpdir(), apply = false;
    for (let index = 0; index < argv.length; index++) {
        const arg = argv[index];
        if (arg === '--data-dir') {
            if (!argv[index + 1]) fail('--data-dir 需要目录路径');
            dataDir = path.resolve(argv[++index]);
        } else if (arg === '--scratch-dir') {
            if (!argv[index + 1]) fail('--scratch-dir 需要目录路径');
            scratchDir = path.resolve(argv[++index]);
        } else if (arg === '--apply') apply = true;
        else if (arg === '--dry-run') apply = false;
        else if (arg === '--help' || arg === '-h') return { help: true };
        else fail(`未知参数：${arg}`);
    }
    return { dataDir, scratchDir, apply };
}

function collectLegacy(dataDir) {
    if (!fs.statSync(dataDir, { throwIfNoEntry: false })?.isDirectory()) fail(`数据目录不存在：${dataDir}`);
    const sources = [];
    const missing = [];
    const groups = [];
    const sourcePath = relative => path.join(dataDir, relative);
    function read(relative, fallback, expected) {
        const filename = sourcePath(relative);
        const stat = fs.lstatSync(filename, { throwIfNoEntry: false });
        if (!stat) { missing.push(relative); return fallback; }
        if (!stat.isFile()) fail(`${relative} 必须是普通文件`);
        const bytes = fs.readFileSync(filename);
        let value;
        try { value = JSON.parse(bytes.toString('utf8')); }
        catch (_) { fail(`${relative} 不是有效 JSON`); }
        if (!expected(value)) fail(`${relative} 的数据结构不符合旧版格式`);
        sources.push({ relative, digest: sha256(bytes) });
        return value;
    }
    function group(table, scope, items, keyOf) {
        if (!items.length) return;
        const seen = new Set();
        for (const item of items) {
            if (!object(item)) fail(`${label(table, scope)} 含无效记录`);
            if (table === 'space_usage' && (!item.appId || !item.userId || typeof item.diskSpace !== 'string')) fail('disk-space-usage.json 含缺失应用、用户或分区的记录');
            if (table === 'shares' && (!item.ownerId || !Array.isArray(item.files) || !Array.isArray(item.directories))) fail('disk-shares.json 含无效分享记录');
            if (table === 'operations' && !item.userId) fail('disk-operations.json 含缺失用户的任务记录');
            if (table === 'collaborations' && (!item.ownerId || !['file', 'directory'].includes(item.kind) || !Array.isArray(item.members) || !Array.isArray(item.invites))) fail('disk-collaborations.json 含无效协同记录');
            const key = keyOf(item);
            if (key === undefined || key === null || String(key) === '' || seen.has(String(key))) fail(`${label(table, scope)} 含缺失或重复的记录标识`);
            seen.add(String(key));
        }
        groups.push({ table, scope, items, keyOf });
    }
    const isArray = Array.isArray;
    const isObject = object;
    const spaces = read('disk-spaces.json', [], value => isArray(value) && value.every(name => typeof name === 'string' && name.length > 0 && name.length <= 100 && !/[\u0000-\u001f]/.test(name)));
    group('spaces', '', [...new Set(spaces)].map(name => ({ name })), item => item.name);

    // A named partition's directory name is the SHA-256 of its display name.
    // An unlisted hash cannot be recovered safely; fail rather than lose it silently.
    const partitionRoot = sourcePath('disk-spaces');
    const listedHashes = new Set(spaces.map(sha256));
    if (fs.existsSync(partitionRoot)) {
        for (const entry of fs.readdirSync(partitionRoot, { withFileTypes: true })) {
            if (!entry.isDirectory() || listedHashes.has(entry.name)) continue;
            const folder = path.join(partitionRoot, entry.name);
            if (['telegram-drive-index.json', 'telegram-drive-directories.json'].some(name => fs.existsSync(path.join(folder, name))))
                fail(`发现未列于 disk-spaces.json 的旧分区目录：${entry.name}`);
        }
    }
    for (const scope of ['', ...new Set(spaces)]) {
        const prefix = scope ? `disk-spaces/${sha256(scope)}/` : '';
        const files = read(prefix + 'telegram-drive-index.json', [], isArray);
        const directories = read(prefix + 'telegram-drive-directories.json', [], isArray);
        for (const file of files) {
            if (!object(file) || !file.id || !file.ownerId || !file.name || (file.parts !== undefined && !isArray(file.parts)))
                fail(`${prefix}telegram-drive-index.json 含无效文件记录`);
        }
        for (const directory of directories) {
            if (!object(directory) || !directory.ownerId || !directory.path || typeof directory.path !== 'string')
                fail(`${prefix}telegram-drive-directories.json 含无效目录记录`);
        }
        group('files', scope, files, FILE_KEY);
        group('directories', scope, directories, DIRECTORY_KEY);
    }
    const auth = read('disk-auth.json', { users: [], apps: [], backends: [], tokens: [] }, value => isObject(value) && AUTH_KEYS.every(([key]) => isArray(value[key])));
    for (const [table, keyOf] of AUTH_KEYS) group(table, '', auth[table], keyOf);
    const secret = sourcePath('disk-secret.key');
    const secretStat = fs.lstatSync(secret, { throwIfNoEntry: false });
    if (AUTH_KEYS.some(([table]) => auth[table].length)) {
        if (!secretStat?.isFile() || secretStat.size !== 32) fail('旧认证数据需要同目录中原有的 32 字节 disk-secret.key；缺失或无效会使登录数据无法恢复');
    }
    if (secretStat?.isFile()) {
        const key = fs.readFileSync(secret);
        sources.push({ relative: 'disk-secret.key', digest: sha256(key) });
        for (const backend of auth.backends) {
            if (typeof backend.encryptedToken !== 'string' || !backend.encryptedToken) fail('disk-auth.json 含缺失加密 Bot 凭据的后端记录');
            try {
                const raw = Buffer.from(backend.encryptedToken, 'base64');
                if (raw.length < 29) throw new Error('encrypted token too short');
                const decipher = crypto.createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
                decipher.setAuthTag(raw.subarray(-16));
                Buffer.concat([decipher.update(raw.subarray(12, -16)), decipher.final()]);
            } catch (_) { fail('disk-secret.key 无法解密旧 Bot 凭据；请恢复与旧 disk-auth.json 配套的密钥'); }
        }
    }
    for (const [filename, table, keyOf] of ARRAY_FILES) group(table, '', read(filename, [], isArray), keyOf);
    const chunk = read('telegram-chunk-file-ids.json', { version: 1, entries: {} }, value => isObject(value) && value.version === 1 && isObject(value.entries));
    group('chunk_ids', '', Object.entries(chunk.entries).map(([key, value]) => ({ key, value })), item => item.key);
    const owners = read('telegram-part-cache/.owners.json', {}, isObject);
    for (const [id, scopes] of Object.entries(owners)) if (!isArray(scopes) || scopes.some(scope => !object(scope) || !scope.userId)) fail('telegram-part-cache/.owners.json 含无效归属记录');
    group('cache_owners', '', Object.entries(owners).map(([id, scopes]) => ({ id, scopes })), item => item.id);
    const placeholders = read('tg-1byte-file.id', {}, isObject);
    for (const entry of Object.values(placeholders)) if (!object(entry) || typeof entry.file_id !== 'string' || !entry.file_id) fail('tg-1byte-file.id 含无效 file_id');
    group('placeholders', '', Object.entries(placeholders).map(([id, entry]) => ({ id, fileId: entry.file_id })), item => item.id);
    if (!sources.some(source => source.relative.endsWith('.json') || source.relative === 'tg-1byte-file.id')) fail('未找到可迁移的旧网盘 JSON 文件');
    return { sources, missing, groups };
}

function prepareChanges(groups, repository, mappedUserIds = new Set()) {
    const changes = [], report = [];
    for (const group of groups) {
        const existing = repository.load(group.table, group.scope);
        const merged = new Map(existing.map(item => [String(group.keyOf(item)), item]));
        let added = 0, same = 0, retainedExisting = 0, updated = 0;
        for (const item of group.items) {
            const id = String(group.keyOf(item));
            if (merged.has(id)) {
                if (sameItem(group.table, merged.get(id), item)) same++;
                else if (group.table === 'chunk_ids' && canRetainChunkId(merged.get(id), item)) retainedExisting++;
                else if (group.table === 'users' && sameMappedUser(merged.get(id), item, mappedUserIds)) retainedExisting++;
                else if (group.table === 'space_usage' && mergeMappedUsage(merged.get(id), item, mappedUserIds)) {
                    const joined = mergeMappedUsage(merged.get(id), item, mappedUserIds);
                    if (isDeepStrictEqual(joined, merged.get(id))) retainedExisting++;
                    else { merged.set(id, joined); updated++; }
                }
                else fail(`${label(group.table, group.scope)} 中有同一标识但内容不同的记录；未覆盖任何数据`);
            } else { merged.set(id, item); added++; }
        }
        report.push({ table: group.table, scope: group.scope, source: group.items.length, added, updated, same, retainedExisting });
        if (added || updated) changes.push({ table: group.table, scope: group.scope, items: [...merged.values()], keyOf: group.keyOf });
    }
    return { changes, report };
}

function verifySources(dataDir, sources) {
    for (const source of sources) {
        const current = fs.readFileSync(path.join(dataDir, source.relative));
        if (sha256(current) !== source.digest) fail(`源文件在预检后发生变化：${source.relative}；请先停止 Node 服务`);
    }
}

function verifyImported(groups, changes, repository, mappedUserIds = new Set()) {
    for (const group of groups) {
        const actual = new Map(repository.load(group.table, group.scope).map(item => [String(group.keyOf(item)), item]));
        for (const item of group.items) if (!sameItem(group.table, actual.get(String(group.keyOf(item))), item)
            && !(group.table === 'chunk_ids' && canRetainChunkId(actual.get(String(group.keyOf(item))), item))
            && !(group.table === 'users' && sameMappedUser(actual.get(String(group.keyOf(item))), item, mappedUserIds))
            && !(group.table === 'space_usage' && isDeepStrictEqual(actual.get(String(group.keyOf(item))),
                mergeMappedUsage(actual.get(String(group.keyOf(item))), item, mappedUserIds))))
            fail(`${label(group.table, group.scope)} 导入核对失败；整个事务将回滚`);
    }
    for (const change of changes) {
        const actual = new Map(repository.load(change.table, change.scope).map(item => [String(change.keyOf(item)), item]));
        if (actual.size !== change.items.length) fail(`${label(change.table, change.scope)} 的原有记录数量不符；整个事务将回滚`);
        for (const item of change.items) if (!sameItem(change.table, actual.get(String(change.keyOf(item))), item))
            fail(`${label(change.table, change.scope)} 的原有记录核对失败；整个事务将回滚`);
    }
    repository.assertIntegrity();
}

function relationshipWarnings(repository) {
    const users = new Set(repository.load('users').map(item => String(item.id)));
    const spaces = repository.load('spaces').map(item => item.name);
    const files = new Map(), directories = new Map();
    for (const space of ['', ...spaces]) {
        const spaceFiles = repository.load('files', space), spaceDirectories = repository.load('directories', space);
        files.set(space, new Set(spaceFiles.map(item => String(item.id))));
        const paths = new Set();
        const addAncestors = (ownerId, folderPath) => {
            const segments = String(folderPath || '').split('/').filter(Boolean);
            for (let index = 1; index <= segments.length; index++) paths.add(`${ownerId}:${segments.slice(0, index).join('/')}`);
        };
        for (const item of spaceDirectories) addAncestors(item.ownerId, item.path);
        for (const item of spaceFiles) addAncestors(item.ownerId, item.folderPath);
        directories.set(space, paths);
    }
    let missingOwners = 0, missingTargets = 0;
    for (const space of ['', ...spaces]) for (const item of repository.load('files', space)) if (!users.has(String(item.ownerId))) missingOwners++;
    for (const item of repository.load('collaborations')) {
        if (item.active === false) continue;
        const scope = String(item.diskSpace || '');
        const exists = item.kind === 'file' ? files.get(scope)?.has(String(item.fileId))
            : directories.get(scope)?.has(`${item.ownerId}:${item.path}`);
        if (!exists) missingTargets++;
    }
    const warnings = [];
    if (missingOwners) warnings.push(`${missingOwners} 个文件的所有者账号在当前库中不存在，请检查旧认证文件是否齐全`);
    if (missingTargets) warnings.push(`${missingTargets} 条启用中的协同记录找不到对应文件或目录，请核对旧索引`);
    return warnings;
}

async function snapshotSqlite(source, destination) {
    const connection = new DatabaseSync(source, { readOnly: true });
    try { await backup(connection, destination); }
    finally { connection.close(); }
    if (process.platform !== 'win32') fs.chmodSync(destination, 0o600);
}

function assertBackupReadable(filename) {
    const connection = new DatabaseSync(filename, { readOnly: true });
    try {
        const result = connection.prepare('PRAGMA integrity_check').all();
        if (result.length !== 1 || result[0].integrity_check !== 'ok') fail('导入前 SQLite 备份完整性检查失败');
        if (connection.prepare('PRAGMA foreign_key_check').all().length) fail('导入前 SQLite 备份外键检查失败');
    } finally { connection.close(); }
}

async function rehearse(dataDir, groups, scratchDir = os.tmpdir()) {
    const scratchRoot = path.resolve(scratchDir);
    if (!fs.statSync(scratchRoot, { throwIfNoEntry: false })?.isDirectory()) fail(`临时目录不存在：${scratchRoot}`);
    const tempRoot = fs.mkdtempSync(path.join(scratchRoot, 'tgdisk-json-check-'));
    if (process.platform !== 'win32') fs.chmodSync(tempRoot, 0o700);
    let repository;
    try {
        const source = path.join(dataDir, 'disk.sqlite');
        if (fs.existsSync(source)) await snapshotSqlite(source, path.join(tempRoot, 'disk.sqlite'));
        repository = openDiskRepository(tempRoot);
        let result;
        repository.atomic(() => {
            const mapped = remapLegacyUsers(groups, repository);
            result = prepareChanges(mapped.groups, repository, mapped.mappedUserIds);
            if (result.changes.length) repository.replaceMany(result.changes);
            verifyImported(mapped.groups, result.changes, repository, mapped.mappedUserIds);
            result.warnings = [...(mapped.count ? [`${mapped.count} 个旧用户与现有 SQLite 用户登录身份相同但 ID 不同；旧数据引用已映射到现有用户`] : []),
                ...retainedChunkWarnings(result.report), ...relationshipWarnings(repository)];
        });
        return result;
    } finally {
        repository?.close();
        const relative = path.relative(scratchRoot, tempRoot);
        if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) fail('临时数据库清理路径无效');
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
}

async function migrate({ dataDir, scratchDir = os.tmpdir(), apply }) {
    const legacy = collectLegacy(dataDir);
    const preview = await rehearse(dataDir, legacy.groups, scratchDir);
    verifySources(dataDir, legacy.sources);
    if (!apply) return { mode: 'dry-run', sources: legacy.sources.length, missing: legacy.missing, warnings: preview.warnings, report: preview.report, changed: preview.changes.length > 0 };
    if (!preview.changes.length) return { mode: 'already-imported', sources: legacy.sources.length, missing: legacy.missing, warnings: preview.warnings, report: preview.report };

    // The backup includes all imported JSON, the identity encryption key, and an
    // online SQLite snapshot. Even a SQL constraint failure leaves these intact.
    const backupRoot = path.join(dataDir, 'migration-backups');
    fs.mkdirSync(backupRoot, { recursive: true, mode: 0o700 });
    if (process.platform !== 'win32') fs.chmodSync(backupRoot, 0o700);
    const backupDir = fs.mkdtempSync(path.join(backupRoot, 'json-to-sqlite-'));
    if (process.platform !== 'win32') fs.chmodSync(backupDir, 0o700);
    let repository;
    try {
        for (const source of legacy.sources) {
            const destination = path.join(backupDir, source.relative);
            fs.mkdirSync(path.dirname(destination), { recursive: true });
            fs.copyFileSync(path.join(dataDir, source.relative), destination);
            if (process.platform !== 'win32') fs.chmodSync(destination, 0o600);
            if (sha256(fs.readFileSync(destination)) !== source.digest) fail(`备份校验失败：${source.relative}`);
        }
        verifySources(dataDir, legacy.sources);
        repository = openDiskRepository(dataDir);
        const databaseBackup = path.join(backupDir, 'disk-before.sqlite');
        await repository.backup(databaseBackup);
        if (process.platform !== 'win32') fs.chmodSync(databaseBackup, 0o600);
        assertBackupReadable(databaseBackup);
        verifySources(dataDir, legacy.sources);
        let result;
        repository.atomic(() => {
            verifySources(dataDir, legacy.sources);
            const mapped = remapLegacyUsers(legacy.groups, repository);
            result = prepareChanges(mapped.groups, repository, mapped.mappedUserIds);
            if (result.changes.length) repository.replaceMany(result.changes);
            verifyImported(mapped.groups, result.changes, repository, mapped.mappedUserIds);
            result.warnings = [...(mapped.count ? [`${mapped.count} 个旧用户与现有 SQLite 用户登录身份相同但 ID 不同；旧数据引用已映射到现有用户`] : []),
                ...retainedChunkWarnings(result.report), ...relationshipWarnings(repository)];
            verifySources(dataDir, legacy.sources);
        });
        return { mode: result.changes.length ? 'applied' : 'already-imported', backupDir, sources: legacy.sources.length,
            missing: legacy.missing, warnings: result.warnings, report: result.report };
    } catch (error) {
        error.message += `；旧文件与数据库备份目录：${backupDir}`;
        throw error;
    } finally { repository?.close(); }
}

async function main(argv = process.argv.slice(2)) {
    const options = parseArgs(argv);
    if (options.help) {
        console.log('用法：node tools/migrate-tgdisk-json-to-sqlite.cjs [--data-dir .tunnel-data] [--scratch-dir 临时目录] [--dry-run|--apply]');
        console.log('默认仅预检；--apply 前必须停止 Node 服务。不会删除旧 JSON。');
        return;
    }
    const result = await migrate(options);
    console.log(JSON.stringify(result, null, 2));
}

if (require.main === module) main().catch(error => {
    console.error(`迁移失败：${error.message}`);
    process.exitCode = 1;
});

module.exports = { collectLegacy, prepareChanges, migrate, parseArgs };
