'use strict';
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

// Independent administrative queue. Never persist Bot tokens or file paths.
function createTelegramForwardJobs({ dataDir, validate, send, autoStart = true }) {
    fs.mkdirSync(dataDir, { recursive: true });
    const db = new DatabaseSync(path.join(dataDir, 'telegram-forward.sqlite'));
    db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS forward_jobs(id TEXT PRIMARY KEY, source TEXT NOT NULL, task_id TEXT NOT NULL, state TEXT NOT NULL, pid INTEGER, created_at INTEGER NOT NULL, payload TEXT NOT NULL);");
    let busy = false, closed = false, timer;
    const read = row => row ? JSON.parse(row.payload) : null;
    const save = job => { job.updatedAt = Date.now(); db.prepare('UPDATE forward_jobs SET state=?,pid=?,payload=? WHERE id=?').run(job.state, process.pid, JSON.stringify(job), job.id); };
    const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; } };
    const counts = job => {
        job.completedTargets = job.targets.filter(item => item.state === 'completed').length;
        job.failedTargets = job.targets.filter(item => ['failed', 'uncertain'].includes(item.state)).length;
        job.processedTargets = job.completedTargets + job.failedTargets;
        const current = job.targets.find(item => item.state === 'running');
        job.progress = Math.min(job.state === 'running' ? 99 : 100, Math.floor((job.processedTargets * 100 + (current?.progress || 0)) / job.targets.length));
    };
    // A Telegram request interrupted by process death has an unknown outcome.
    // Do not automatically send it again or silently mark it as successful.
    function recover() {
        for (const row of db.prepare("SELECT * FROM forward_jobs WHERE state='running'").all()) {
            if (alive(row.pid)) continue;
            const job = read(row); job.state = 'interrupted'; job.detail = '服务中断，最后一个目标是否收到消息尚未确认；请先检查 Telegram，未自动重发。';
            for (const item of job.targets) if (item.state === 'running') { item.state = 'uncertain'; item.error = job.detail; }
            counts(job); save(job);
        }
    }
    function create(source, taskId, input) {
        if (closed) throw Error('转发服务正在停止');
        if (!Array.isArray(input.targets) || !input.targets.length || input.targets.length > 50) throw Error('请指定 1 至 50 个 Telegram 目标');
        const checked = validate(source, taskId, input), targets = [...new Map(checked.targets.map(target => [target.toLowerCase(), target])).values()];
        const requestId = typeof input.requestId === 'string' && /^[a-zA-Z0-9_-]{8,100}$/.test(input.requestId) ? input.requestId : crypto.randomUUID();
        const id = crypto.createHash('sha256').update(source + ':' + taskId + ':' + requestId).digest('hex');
        const existing = read(db.prepare('SELECT * FROM forward_jobs WHERE id=?').get(id));
        const options = { caption: String(input.caption || '').trim().slice(0, 1024), fileVariant: input.fileVariant || 'original', supportVideoPreview: input.supportVideoPreview === true };
        if (existing) {
            if (JSON.stringify(existing.options) !== JSON.stringify(options) || JSON.stringify(existing.targets.map(item => item.target)) !== JSON.stringify(targets)) throw Error('同一提交标识的目标或发送选项已改变，请重新提交');
            return existing;
        }
        if (db.prepare("SELECT count(*) AS n FROM forward_jobs WHERE state IN ('queued','running')").get().n >= 30) throw Error('Telegram 转发队列已满，请稍后再提交');
        const job = { id, source, taskId, createdAt: Date.now(), state: 'queued', progress: 0, completedTargets: 0, failedTargets: 0, processedTargets: 0,
            detail: '等待前面的发送任务完成', fingerprint: checked.fingerprint,
            options,
            targets: targets.map(target => ({ target, state: 'queued', progress: 0 })) };
        db.prepare('INSERT INTO forward_jobs VALUES(?,?,?,?,?,?,?)').run(id, source, taskId, job.state, process.pid, job.createdAt, JSON.stringify(job));
        db.prepare("DELETE FROM forward_jobs WHERE id IN (SELECT id FROM forward_jobs WHERE state NOT IN ('queued','running','interrupted') ORDER BY created_at DESC LIMIT -1 OFFSET 200)").run();
        if (autoStart) setImmediate(() => pump().catch(error => console.error('[telegram-forward-queue]', error.code || 'worker-failed')));
        return job;
    }
    async function pump() {
        if (busy || closed) return; busy = true;
        try {
            recover(); db.exec('BEGIN IMMEDIATE'); let job;
            try {
                if (!db.prepare("SELECT id FROM forward_jobs WHERE state='running' LIMIT 1").get()) {
                    job = read(db.prepare("SELECT * FROM forward_jobs WHERE state='queued' ORDER BY created_at,id LIMIT 1").get());
                    if (job) { job.state = 'running'; save(job); }
                }
                db.exec('COMMIT');
            } catch (error) { db.exec('ROLLBACK'); throw error; }
            if (!job) return;
            for (const item of job.targets) {
                if (closed) { job.state = 'queued'; save(job); break; }
                if (item.state !== 'queued') continue;
                item.state = 'running'; job.currentTarget = item.target; job.detail = '正在检查当前成品版本'; save(job);
                try {
                    const checked = validate(job.source, job.taskId, { ...job.options, targets: [item.target] });
                    if (checked.fingerprint !== job.fingerprint) throw Error('来源成品或所选版本已发生变化，请重新创建转发任务');
                    let lastSave = 0;
                    const result = await send(job.source, job.taskId, { ...job.options, target: item.target, onProgress: update => {
                        job.detail = update.detail; item.sentBytes = update.sentBytes; item.totalBytes = update.totalBytes;
                        item.progress = Math.max(item.progress, Math.min(99, Number(update.progress) || 0)); counts(job);
                        if (Date.now() - lastSave > 500 || update.phase === 'response') { lastSave = Date.now(); save(job); }
                    } });
                    Object.assign(item, { state: 'completed', progress: 100, messageId: result.messageId });
                } catch (error) {
                    // No automatic retry: a network error can follow remote acceptance.
                    item.state = 'failed'; item.error = ['ENOENT','EACCES','EPERM'].includes(error.code) ? '来源成品不可读取或已被清理，请检查下载任务' :
                        String(error.message || '发送失败').replace(/(?:bot)?\d{6,}:[\w-]+/g, '[redacted]').slice(0, 500);
                }
                counts(job); save(job);
            }
            if (job.state === 'running') {
                job.state = job.failedTargets ? (job.completedTargets ? 'partial' : 'failed') : 'completed';
                job.detail = `发送结束：成功 ${job.completedTargets}/${job.targets.length} 个目标，失败 ${job.failedTargets} 个`; job.finishedAt = Date.now(); job.progress = 100; save(job);
            }
        } finally { busy = false; if (closed) db.close(); }
    }
    recover();
    if (autoStart) { timer = setInterval(() => pump().catch(error => console.error('[telegram-forward-queue]', error.code || 'worker-failed')), 500); timer.unref(); }
    return { create, pump,
        list(source, taskId) { return db.prepare('SELECT * FROM forward_jobs WHERE source=? AND task_id=? ORDER BY created_at DESC,id DESC LIMIT 10').all(source, taskId).map(read); },
        get(id) { return read(db.prepare('SELECT * FROM forward_jobs WHERE id=?').get(id)); },
        close() { if (closed) return; closed = true; clearInterval(timer); if (!busy) db.close(); }
    };
}
module.exports = { createTelegramForwardJobs };
