'use strict';

// Read existing diagnostics while the service is running. Never open the domain
// repository here: its initializer can create/migrate tables in the source DB.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const readline = require('node:readline');
const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');

function parseArgs(argv, now = Date.now()) {
    const options = { dataDir: path.resolve('.tunnel-data'), until: now, uploadIds: [], operationIds: [] };
    let minutes, since;
    const value = (index, name) => {
        const text = argv[index];
        if (!text || text.startsWith('--')) throw new Error(`${name} 缺少参数值`);
        return text;
    };
    const time = (text, name) => {
        if (!/(?:Z|[+-]\d{2}:\d{2})$/i.test(text) || !Number.isFinite(Date.parse(text))) throw new Error(`${name} 请使用带时区的 ISO 时间，例如 2026-09-28T12:00:00+08:00`);
        return Date.parse(text);
    };
    for (let index = 0; index < argv.length; index++) {
        const arg = argv[index];
        if (arg === '--help' || arg === '-h') options.help = true;
        else if (arg === '--data-dir') options.dataDir = path.resolve(value(++index, arg));
        else if (arg === '--output') options.output = path.resolve(value(++index, arg));
        else if (arg === '--minutes') {
            minutes = Number(value(++index, arg));
            if (!Number.isSafeInteger(minutes) || minutes <= 0 || minutes > 10080) throw new Error('--minutes 必须是 1 至 10080 的整数');
        } else if (arg === '--since') since = time(value(++index, arg), arg);
        else if (arg === '--until') options.until = time(value(++index, arg), arg);
        else if (arg === '--upload-id' || arg === '--operation-id') {
            const id = value(++index, arg);
            if (!/^[a-zA-Z0-9_-]{1,120}$/.test(id)) throw new Error(`${arg} 格式无效`);
            options[arg === '--upload-id' ? 'uploadIds' : 'operationIds'].push(id);
        } else throw new Error(`未知参数：${arg}`);
    }
    if (since !== undefined && minutes !== undefined) throw new Error('--since 和 --minutes 请只选一个');
    options.since = since ?? (minutes !== undefined ? options.until - minutes * 60000
        : options.uploadIds.length || options.operationIds.length ? 0 : options.until - 120 * 60000);
    if (options.since > options.until) throw new Error('--since 不能晚于 --until');
    return options;
}

function redact(value) {
    if (typeof value === 'string') return value.replace(/https?:\/\/[^\s"<>]+/gi, '[url]')
        .replace(/\b(?:bot)?\d{5,}:[A-Za-z0-9_-]{20,}\b/g, '[credential]')
        .replace(/\bBearer\s+[\w.+/=-]+/gi, 'Bearer [credential]');
    if (Array.isArray(value)) return value.map(redact);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.entries(value).filter(([key]) => !/(?:token|secret|password|authorization|cookie|credential|encrypted)|^(?:body|payload|caption|headers)$/i.test(key))
        .map(([key, item]) => [key, redact(item)]));
}

async function readLog(filename, warnings) {
    let handle;
    try { handle = await fsp.open(filename, 'r'); }
    catch (error) {
        warnings.push(`${path.basename(filename)}：${error.code === 'ENOENT' ? '不存在' : '无法读取（' + error.code + '）'}`);
        return { source: path.basename(filename), bytes: 0, entries: [], malformedLines: 0 };
    }
    const entries = []; let malformedLines = 0, stream;
    try {
        // Freeze the read boundary, even if the running service keeps appending.
        const { size } = await handle.stat();
        if (!size) return { source: path.basename(filename), bytes: 0, entries, malformedLines };
        stream = handle.createReadStream({ start: 0, end: size - 1, autoClose: false });
        for await (const line of readline.createInterface({ input: stream, crlfDelay: Infinity })) {
            if (!line.trim()) continue;
            try {
                const entry = JSON.parse(line);
                if (!entry || typeof entry !== 'object' || Array.isArray(entry) || !entry.event || !Number.isFinite(Date.parse(entry.time))) throw new Error('invalid row');
                entries.push(entry);
            } catch { malformedLines++; }
        }
        if (malformedLines) warnings.push(`${path.basename(filename)}：忽略 ${malformedLines} 行不完整或无效日志`);
        return { source: path.basename(filename), bytes: size, entries, malformedLines };
    } finally { stream?.destroy(); await handle.close(); }
}

function readOperations(dataDir, warnings) {
    const filename = path.join(dataDir, 'disk.sqlite');
    if (fs.existsSync(filename)) {
        let db;
        try {
            const { DatabaseSync } = require('node:sqlite');
            db = new DatabaseSync(filename, { readOnly: true });
            db.exec('PRAGMA query_only = ON; PRAGMA busy_timeout = 1000');
            const rows = db.prepare('SELECT payload FROM disk_operations').all();
            const items = [];
            for (const row of rows) {
                try { items.push(JSON.parse(row.payload)); }
                catch { warnings.push('SQLite 中有一条无法解析的任务记录，已忽略'); }
            }
            return { source: 'disk.sqlite', items };
        } catch (error) {
            warnings.push(`SQLite 任务状态读取失败（${error.code || 'READ_FAILED'}）；不会用可能过期的旧 JSON 替代`);
            return { source: 'disk.sqlite', items: [] };
        } finally { db?.close(); }
    }
    try {
        const items = JSON.parse(fs.readFileSync(path.join(dataDir, 'disk-operations.json'), 'utf8'));
        if (!Array.isArray(items)) throw new Error('INVALID_JSON');
        return { source: 'disk-operations.json', items };
    } catch (error) {
        warnings.push(`任务状态无法读取（${error.code || 'INVALID_JSON'}）；仍收集现有日志`);
        return { source: null, items: [] };
    }
}

const operationFields = new Set(['operation_id', 'uploadId', 'type', 'status', 'phase', 'title', 'message', 'folderPath', 'diskSpace',
    'errorCode', 'errorMessage', 'errorDetails', 'createdAt', 'startedAt', 'updatedAt', 'finishedAt', 'percent', 'processedBytes', 'totalBytes',
    'clientBytesReceived', 'clientTotalBytes', 'telegramBytesUploaded', 'telegramTotalBytes', 'clientPartsReceived', 'clientPartsTotal',
    'telegramPartsUploaded', 'queueParts', 'queueBytes', 'cancelRequested']);
function deploymentVersion(repoDir) {
    try {
        const release = JSON.parse(fs.readFileSync(path.join(repoDir, 'release.json'), 'utf8'));
        if (release.sourceCommit) return redact({ source: 'release.json', commit: release.sourceCommit, branch: release.sourceBranch,
            buildId: release.buildId, builtAt: release.builtAt, domain: release.domain });
    } catch {}
    const read = args => {
        const result = spawnSync('git', args, { cwd: repoDir, encoding: 'utf8', timeout: 2000, windowsHide: true });
        return result.status === 0 ? result.stdout.trim().slice(0, 200) : null;
    };
    return { source: 'git', commit: read(['rev-parse', 'HEAD']), branch: read(['rev-parse', '--abbrev-ref', 'HEAD']) };
}

async function collect(options) {
    const warnings = [], dataDir = path.resolve(options.dataDir);
    if (!fs.statSync(dataDir).isDirectory()) throw new Error('--data-dir 必须是已有的数据目录');
    const sources = [];
    // Sequential snapshots minimize the rotation window between the two files.
    for (const name of ['disk-upload.log.1', 'disk-upload.log']) sources.push(await readLog(path.join(dataDir, name), warnings));
    const stored = readOperations(dataDir, warnings);
    const uploadIds = new Set(options.uploadIds), operationIds = new Set(options.operationIds);
    const targeted = uploadIds.size || operationIds.size;
    if (targeted) for (const job of stored.items) {
        if (uploadIds.has(job.uploadId) || operationIds.has(job.operation_id)) {
            if (job.uploadId) uploadIds.add(job.uploadId);
            if (job.operation_id) operationIds.add(job.operation_id);
        }
    }
    const inWindow = time => Number.isFinite(Number(time)) && Number(time) >= options.since && Number(time) <= options.until;
    const rawRows = sources.flatMap(source => source.entries).filter(entry => inWindow(Date.parse(entry.time))
        && (!targeted || uploadIds.has(entry.uploadId) || operationIds.has(entry.operationId)));
    const seen = new Set();
    const logs = rawRows.filter(entry => { const key = JSON.stringify(entry); if (seen.has(key)) return false; seen.add(key); return true; })
        .sort((a, b) => Date.parse(a.time) - Date.parse(b.time)).map(redact);
    const referenced = new Set(logs.map(entry => entry.operationId).filter(Boolean));
    const operations = stored.items.filter(job => job?.type === 'upload' && (targeted
        ? uploadIds.has(job.uploadId) || operationIds.has(job.operation_id)
        : referenced.has(job.operation_id) || ['createdAt', 'startedAt', 'updatedAt', 'finishedAt'].some(key => job[key] && inWindow(job[key]))))
        .map(job => redact(Object.fromEntries(Object.entries(job).filter(([key]) => operationFields.has(key)))));
    if (!logs.length) warnings.push('筛选范围内没有日志；请检查时间、任务 ID、数据目录，以及日志是否已经轮转丢弃');
    return { format: 'drop2tunnel-tgdisk-diagnostics-v1', collectedAt: new Date().toISOString(),
        window: { since: options.since ? new Date(options.since).toISOString() : null, until: new Date(options.until).toISOString(), uploadIds: options.uploadIds, operationIds: options.operationIds },
        deployment: deploymentVersion(options.repoDir || path.join(__dirname, '..')), collector: { node: process.version, platform: process.platform, arch: process.arch },
        sources: sources.map(({ entries, ...source }) => ({ ...source, validEntries: entries.length })), operationsSource: stored.source,
        warnings, operations, logs };
}

async function main(argv = process.argv.slice(2)) {
    const options = parseArgs(argv);
    if (options.help) {
        console.log('用法：node tools/collect-tgdisk-diagnostics.cjs --data-dir .tunnel-data [--minutes 120 | --since ISO时间] [--until ISO时间] [--upload-id ID] [--operation-id ID] [--output 文件.json]\n按任务 ID 筛选时，未指定时间则收集全部尚未轮转的相关日志。服务运行时可执行。');
        return;
    }
    const bundle = await collect(options);
    const output = options.output || path.join(options.dataDir, 'diagnostics', `tgdisk-${Date.now()}-${crypto.randomUUID().slice(0, 8)}.json`);
    await fsp.mkdir(path.dirname(output), { recursive: true });
    // A typo must never overwrite a live log, database or previous diagnostic.
    await fsp.writeFile(output, JSON.stringify(bundle), { flag: 'wx', mode: 0o600 });
    const report = { output, logEntries: bundle.logs.length, operations: bundle.operations.length, warnings: bundle.warnings };
    console.log(JSON.stringify(report, null, 2));
    return report;
}

if (require.main === module) main().catch(error => { console.error(`诊断收集失败：${error.code || redact(error.message)}`); process.exitCode = 1; });
module.exports = { parseArgs, redact, collect, main };
