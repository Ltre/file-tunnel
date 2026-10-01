'use strict';

// Standalone maintenance tool: do not require server.js or start the application.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { createRequire } = require('node:module');
const { isDeepStrictEqual } = require('node:util');

const ADVISORY = 'https://github.com/advisories/GHSA-2gc4-cqfq-p2gv';
const MAINTENANCE = '.dependency-maintenance';
const hash = data => crypto.createHash('sha256').update(data).digest('hex');
const readJSON = filename => JSON.parse(fs.readFileSync(filename, 'utf8'));
const enginePath = key => /(?:^|\/)node_modules\/engine\.io$/.test(key);
const versionParts = value => /^(\d+)\.(\d+)\.(\d+)$/.exec(value || '')?.slice(1).map(Number);
const vulnerable = version => { const p = versionParts(version); return !!p && p[0] === 6 && p[1] === 6 && p[2] < 10; };
const safePatch = version => { const p = versionParts(version); return !!p && p[0] === 6 && p[1] === 6 && p[2] >= 10; };

function argumentsFor(argv) {
    const options = { projectDir: process.cwd(), apply: false, stopped: false };
    const value = (i, flag) => {
        if (!argv[i] || argv[i].startsWith('--')) throw new Error(`${flag} 缺少参数`);
        return argv[i];
    };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--project-dir') options.projectDir = path.resolve(value(++i, arg));
        else if (arg === '--port') options.port = Number(value(++i, arg));
        else if (arg === '--rollback') options.rollback = path.resolve(value(++i, arg));
        else if (arg === '--apply') options.apply = true;
        else if (arg === '--service-stopped') options.stopped = true;
        else if (arg === '--help') options.help = true;
        else throw new Error(`未知参数：${arg}`);
    }
    if (options.apply && options.rollback) throw new Error('--apply 与 --rollback 不能同时使用');
    if (options.port !== undefined && (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535))
        throw new Error('--port 必须为 1–65535 的实际 Node 服务监听端口');
    if ((options.apply || options.rollback) && (!options.stopped || options.port === undefined))
        throw new Error('先停止所有本站 Node 进程及自动重启，再传入 --service-stopped 和 --port <实际 Node 端口>');
    return options;
}

function contained(root, relative) {
    const filename = path.resolve(root, relative);
    const rel = path.relative(root, filename);
    if (!rel || rel.startsWith(`..${path.sep}`) || rel === '..' || path.isAbsolute(rel))
        throw new Error(`路径超出维护范围：${relative}`);
    let current = root;
    for (const segment of rel.split(path.sep)) {
        current = path.join(current, segment);
        if (fs.lstatSync(current, { throwIfNoEntry: false })?.isSymbolicLink())
            throw new Error(`维护路径不允许符号链接：${relative}`);
    }
    return filename;
}

function treeHash(directory) {
    const digest = crypto.createHash('sha256');
    function visit(relative) {
        const filename = path.join(directory, relative);
        const stat = fs.lstatSync(filename);
        if (stat.isSymbolicLink()) throw new Error(`依赖中存在符号链接，未修改：${filename}`);
        if (stat.isDirectory()) {
            digest.update(`d:${relative}\0`);
            for (const name of fs.readdirSync(filename).sort()) visit(relative ? `${relative}/${name}` : name);
        } else if (stat.isFile()) digest.update(`f:${relative}\0${hash(fs.readFileSync(filename))}\0`);
        else throw new Error(`依赖中存在非常规文件：${filename}`);
    }
    visit('');
    return digest.digest('hex');
}

function atomicWrite(filename, content) {
    const temporary = `${filename}.${crypto.randomUUID()}.tmp`;
    const previous = fs.statSync(filename, { throwIfNoEntry: false });
    try {
        fs.writeFileSync(temporary, content, { flag: 'wx', mode: previous ? previous.mode & 0o777 : 0o600, flush: true });
        fs.renameSync(temporary, filename);
    } finally {
        if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    }
}

function writeJournal(directory, record) {
    atomicWrite(path.join(directory, 'repair.json'), JSON.stringify(record, null, 2) + '\n');
}

function inspect(projectDir) {
    const root = fs.realpathSync(projectDir);
    const manifestPath = contained(root, 'package.json');
    const lockPath = contained(root, 'package-lock.json');
    const manifestBytes = fs.readFileSync(manifestPath);
    const lockBytes = fs.readFileSync(lockPath);
    const manifest = JSON.parse(manifestBytes);
    const lock = JSON.parse(lockBytes);
    if (![2, 3].includes(lock.lockfileVersion) || !lock.packages || !lock.packages[''])
        throw new Error('仅支持 npm package-lock v2/v3；请先用项目支持的 npm 版本生成锁文件');
    if (manifest.workspaces || fs.existsSync(path.join(root, 'npm-shrinkwrap.json')))
        throw new Error('发现 workspaces 或 npm-shrinkwrap.json，本定向修复工具不修改这种依赖布局');
    for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
        if (!isDeepStrictEqual(manifest[field] || {}, lock.packages[''][field] || {}))
            throw new Error(`package.json 与锁文件的 ${field} 不一致；先确认部署文件属于同一版本`);
    }
    contained(root, 'node_modules');
    const req = createRequire(manifestPath);
    let socketEntry;
    try { socketEntry = req.resolve('socket.io'); }
    catch (_) { throw new Error('当前项目没有安装 Socket.IO；请先核对 --project-dir 与实际运行目录'); }
    const entry = createRequire(socketEntry).resolve('engine.io');
    let engineDir = path.dirname(entry);
    while (!fs.existsSync(path.join(engineDir, 'package.json'))) {
        const parent = path.dirname(engineDir);
        if (parent === engineDir) throw new Error('无法定位运行时 Engine.IO');
        engineDir = parent;
    }
    const runtimeKey = path.relative(root, engineDir).split(path.sep).join('/');
    contained(root, runtimeKey);
    if (!enginePath(runtimeKey) || readJSON(path.join(engineDir, 'package.json')).name !== 'engine.io')
        throw new Error('Socket.IO 使用的 Engine.IO 不在本项目依赖目录中');
    const engines = Object.entries(lock.packages).filter(([key]) => enginePath(key)).map(([key, value]) => {
        const directory = contained(root, key);
        const packageFile = path.join(directory, 'package.json');
        const installed = fs.existsSync(packageFile) ? readJSON(packageFile) : null;
        if (installed && installed.name !== 'engine.io') throw new Error(`依赖名称异常：${key}`);
        return { key, lockedVersion: value.version, installedVersion: installed?.version || null };
    });
    if (!engines.some(item => item.key === runtimeKey)) throw new Error('运行时 Engine.IO 在锁文件中没有对应记录');
    return { root, manifest, lock, manifestBytes, lockBytes, runtimeKey, engines,
        needsRepair: engines.some(item => vulnerable(item.lockedVersion) || vulnerable(item.installedVersion)) };
}

function validatePlan(before, after) {
    const withoutLegacyEngine = dependencies => Object.fromEntries(Object.entries(dependencies || {}).filter(([name]) => name !== 'engine.io')
        .map(([name, item]) => [name, item.dependencies ? { ...item, dependencies: withoutLegacyEngine(item.dependencies) } : item]));
    const unchanged = value => ({ ...value, packages: Object.fromEntries(Object.entries(value.packages).filter(([key]) => !enginePath(key))),
        ...(value.dependencies ? { dependencies: withoutLegacyEngine(value.dependencies) } : {}) });
    if (!isDeepStrictEqual(unchanged(before), unchanged(after)))
        throw new Error('npm 计划还会改变 Engine.IO 之外的依赖或锁文件结构，已拒绝应用；请按常规发布流程处理');
    const keys = Object.keys(before.packages).filter(enginePath).sort();
    if (!isDeepStrictEqual(keys, Object.keys(after.packages).filter(enginePath).sort()))
        throw new Error('Engine.IO 依赖路径发生变化，已拒绝应用');
    for (const key of keys) {
        const old = before.packages[key], next = after.packages[key];
        if (isDeepStrictEqual(old, next)) {
            if (vulnerable(next.version)) throw new Error(`${key} 的父依赖或 override 阻止了安全补丁升级`);
            continue;
        }
        if (!safePatch(next.version) || !versionParts(old.version) || old.version.split('.').slice(0, 2).join('.') !== '6.6')
            throw new Error(`只允许 Engine.IO 6.6.x 安全补丁升级：${key} ${old.version} → ${next.version}`);
        if (versionParts(next.version)[2] < versionParts(old.version)[2]) throw new Error('拒绝降级 Engine.IO');
    }
}

function npmCLI() {
    const candidates = [process.env.npm_execpath, path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js')];
    for (const directory of (process.env.PATH || '').split(path.delimiter).filter(Boolean)) {
        candidates.push(path.join(directory, 'node_modules/npm/bin/npm-cli.js'));
        if (process.platform !== 'win32') {
            try { candidates.push(fs.realpathSync(path.join(directory, 'npm'))); } catch (_) {}
        }
    }
    const filename = candidates.find(item => item && path.basename(item) === 'npm-cli.js' && fs.existsSync(item));
    if (!filename) throw new Error('找不到 npm-cli.js，请使用安装了 npm 的 Node 环境执行');
    return filename;
}

function execute(command, args, cwd, timeoutMs = 600000) {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '', stderr = '', failure;
        const timer = setTimeout(() => { failure = new Error('维护子进程超时，已停止；未自动重启业务服务'); child.kill(); }, timeoutMs);
        const collect = channel => chunk => {
            if (channel === 'out') stdout += chunk; else stderr += chunk;
            if (stdout.length + stderr.length > 8 * 1024 * 1024) { failure = new Error('维护子进程输出过大，已停止'); child.kill(); }
        };
        child.stdout.on('data', collect('out')); child.stderr.on('data', collect('err'));
        child.on('error', error => { clearTimeout(timer); reject(error); });
        child.on('close', code => {
            clearTimeout(timer);
            if (failure) return reject(failure);
            resolve({ code, stdout, stderr });
        });
    });
}

function redact(text) {
    return String(text || '').replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/g, '$1[redacted]@')
        .replace(/((?:_authToken|authorization|password|token)\s*[=:]\s*)[^\s]+/gi, '$1[redacted]');
}

async function runNpm(args, cwd, cache) {
    const result = await execute(process.execPath, [npmCLI(), ...args, '--prefix', cwd, '--global=false', '--workspaces=false', '--cache', cache], cwd);
    if (result.code !== 0) throw new Error(`npm ${args[0]} 失败：${redact(result.stderr || result.stdout).slice(-4000)}`);
    return result;
}

async function assertStopped(port) {
    for (const host of ['127.0.0.1', '::1']) {
        await new Promise((resolve, reject) => {
            const socket = net.connect({ port, host });
            socket.once('connect', () => { socket.destroy(); reject(new Error(`${host}:${port} 仍有监听，请停止服务及自动重启后重试`)); });
            socket.once('error', error => {
                socket.destroy();
                if (['ECONNREFUSED', 'EAFNOSUPPORT', 'EADDRNOTAVAIL'].includes(error.code)) resolve();
                else reject(new Error(`无法确认 ${host}:${port} 已停止：${error.code}`));
            });
            socket.setTimeout(1500, () => { socket.destroy(); reject(new Error(`确认 ${host}:${port} 已停止时超时`)); });
        });
    }
}

// Executed in a fresh child process, so require caches cannot hide an old package.
async function securityProbe(root) {
    const assert = require('node:assert/strict'), http = require('node:http'), crypto = require('node:crypto');
    const { createRequire } = require('node:module'), path = require('node:path');
    const appRequire = createRequire(path.join(root, 'package.json'));
    const socketRequire = createRequire(appRequire.resolve('socket.io'));
    const engine = socketRequire('engine.io');
    const WebSocket = createRequire(socketRequire.resolve('engine.io'))('ws');
    const server = http.createServer(), io = new engine.Server();
    io.attach(server);
    io.on('connection', socket => socket.on('message', data => socket.send(data)));
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const request = (query, method = 'GET', body, headers = {}) => new Promise((resolve, reject) => {
        const req = http.request({ hostname: '127.0.0.1', port, path: `/engine.io/?${query}`, method, headers, agent: false }, res => {
            const parts = [];
            res.on('data', part => parts.push(part)); res.on('error', reject);
            res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(parts).toString() }));
        });
        req.on('error', reject);
        req.on('upgrade', (res, socket) => { socket.destroy(); resolve({ status: res.statusCode }); });
        req.setTimeout(3000, () => req.destroy(new Error('probe timeout')));
        req.end(body);
    });
    try {
        const first = await request('EIO=4&transport=polling');
        assert.equal(first.status, 200);
        const sid = JSON.parse(first.body.slice(1)).sid;
        for (const eio of ['&EIO=3', '']) {
            const rejected = await request(`transport=websocket&sid=${encodeURIComponent(sid)}${eio}`, 'GET', undefined, {
                Connection: 'Upgrade', Upgrade: 'websocket',
                'Sec-WebSocket-Key': crypto.randomBytes(16).toString('base64'), 'Sec-WebSocket-Version': '13'
            });
            assert.equal(rejected.status, 400, 'unsafe protocol upgrade was accepted');
            assert.equal(io.clients[sid].protocol, 4);
        }
        assert.equal((await request(`EIO=4&transport=polling&sid=${encodeURIComponent(sid)}`, 'POST', '4probe', { 'Content-Type': 'text/plain' })).status, 200);
        assert.equal((await request(`EIO=4&transport=polling&sid=${encodeURIComponent(sid)}`)).body, '4probe');
        await new Promise((resolve, reject) => {
            const socket = new WebSocket(`ws://127.0.0.1:${port}/engine.io/?EIO=4&transport=websocket&sid=${encodeURIComponent(sid)}`);
            socket.on('error', reject);
            socket.on('open', () => socket.send('2probe'));
            const bytes = Buffer.from([0, 127, 128, 255]);
            socket.on('message', (data, binary) => {
                try {
                    if (binary) { assert.deepEqual(data, bytes); assert.equal(io.clients[sid].transport.name, 'websocket'); socket.close(); resolve(); }
                    else if (data.toString() === '3probe') { socket.send('5'); socket.send('4probe-ws'); }
                    else { assert.equal(data.toString(), '4probe-ws'); socket.send(bytes); }
                } catch (error) { socket.terminate(); reject(error); }
            });
        });
        console.log(JSON.stringify({ protocolMismatchRejected: true, polling: true, websocketUpgrade: true, binary: true }));
    } finally { io.close(); await new Promise(resolve => server.close(resolve)); }
}

async function probe(root) {
    const result = await execute(process.execPath, ['-e', `(${securityProbe.toString()})(process.argv[1]).catch(e=>{console.error(e.message);process.exit(1)})`, root], root, 15000);
    if (result.code !== 0) throw new Error(`Engine.IO 隔离验证失败：${redact(result.stderr || result.stdout).slice(-2000)}`);
    return JSON.parse(result.stdout.trim());
}

function replaceTree(root, key, source, expectedHash) {
    const destination = contained(root, key);
    const temporary = contained(root, `${key}.repair-${crypto.randomUUID()}`);
    const previous = contained(root, `${key}.previous-${crypto.randomUUID()}`);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    let moved = false;
    try {
        fs.cpSync(source, temporary, { recursive: true, force: false, errorOnExist: true });
        if (treeHash(temporary) !== expectedHash) throw new Error(`依赖复制校验失败：${key}`);
        if (fs.existsSync(destination)) { fs.renameSync(destination, previous); moved = true; }
        fs.renameSync(temporary, destination);
    } catch (error) {
        if (moved && !fs.existsSync(destination)) fs.renameSync(previous, destination);
        throw error;
    } finally {
        if (fs.existsSync(temporary)) fs.rmSync(temporary, { recursive: true, force: true });
    }
    // The verified original remains in the permanent backup. A locked leftover is harmless.
    try { if (moved) fs.rmSync(previous, { recursive: true, force: true }); }
    catch (_) { return { leftover: previous }; }
    return {};
}

function acquireLock(root) {
    const directory = contained(root, MAINTENANCE);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const filename = contained(root, `${MAINTENANCE}/maintenance.lock`);
    let fd;
    try { fd = fs.openSync(filename, 'wx', 0o600); }
    catch (error) {
        if (error.code === 'EEXIST') throw new Error(`已有维护锁：${filename}；确认无其它维护进程后，先处理 repair.json 中未完成的修复，再手动移除锁`);
        throw error;
    }
    const token = crypto.randomUUID();
    fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, token, createdAt: new Date().toISOString() })); fs.closeSync(fd);
    return () => { if (readJSON(filename).token === token) fs.unlinkSync(filename); };
}

function rollback(root, backupDir) {
    const directory = contained(root, path.relative(root, backupDir));
    if (!directory.startsWith(path.join(root, MAINTENANCE) + path.sep)) throw new Error('回滚目录必须位于本项目 .dependency-maintenance 中');
    const record = readJSON(path.join(directory, 'repair.json'));
    if (record.format !== 1 || record.projectDir !== root || !Array.isArray(record.targets)) throw new Error('备份不属于当前项目或格式无效');
    const originalManifest = fs.readFileSync(contained(directory, 'package.json'));
    const originalLock = fs.readFileSync(contained(directory, 'package-lock.json'));
    if (hash(originalManifest) !== record.manifestHash || hash(originalLock) !== record.originalLockHash)
        throw new Error('备份清单校验失败，未回滚');
    if (hash(fs.readFileSync(contained(root, 'package.json'))) !== record.manifestHash)
        throw new Error('package.json 在修复后发生变化，未回滚，以免覆盖后续发布');
    const currentLockHash = hash(fs.readFileSync(contained(root, 'package-lock.json')));
    if (![record.originalLockHash, record.plannedLockHash].includes(currentLockHash)) throw new Error('锁文件在修复后发生变化，未回滚');
    for (const target of record.targets) {
        if (!enginePath(target.key)) throw new Error('备份中的依赖路径无效');
        const backup = contained(directory, `original/${target.key}`), current = contained(root, target.key);
        if (treeHash(backup) !== target.beforeHash) throw new Error(`原依赖备份校验失败：${target.key}`);
        if (fs.existsSync(current) && ![target.beforeHash, target.afterHash].includes(treeHash(current)))
            throw new Error(`依赖在修复后发生变化，未回滚：${target.key}`);
    }
    for (const target of [...record.targets].reverse()) {
        const current = contained(root, target.key);
        if (!fs.existsSync(current) || treeHash(current) !== target.beforeHash)
            replaceTree(root, target.key, contained(directory, `original/${target.key}`), target.beforeHash);
    }
    atomicWrite(contained(root, 'package-lock.json'), originalLock);
    record.status = 'rolled-back'; record.rolledBackAt = new Date().toISOString(); writeJournal(directory, record);
    return { mode: 'rolled-back', backupDir: directory, warning: '已恢复原依赖；原版本可能仍有漏洞。请保持维护状态并排查后重新修复。' };
}

async function auditSummary(root, cache) {
    try {
        const audit = await execute(process.execPath, [npmCLI(), 'audit', '--omit=dev', '--json', '--cache', cache], root, 120000);
        const data = JSON.parse(audit.stdout);
        return data.metadata?.vulnerabilities ? { status: 'available', vulnerabilities: data.metadata.vulnerabilities }
            : { status: 'unavailable', message: 'npm 审计未返回漏洞统计；本次版本和协议验证已通过' };
    } catch (_) { return { status: 'unavailable', message: '在线 npm 审计不可用；本次版本和协议验证已通过' }; }
}

async function main(options, hooks = {}) {
    const checkStopped = hooks.assertStopped || assertStopped, npm = hooks.runNpm || runNpm, verify = hooks.probe || probe;
    if ((options.apply || options.rollback) && (!options.stopped || !Number.isInteger(options.port) || options.port < 1 || options.port > 65535))
        throw new Error('修复/回滚必须声明服务已停止，并指定实际 Node 监听端口');
    const progress = hooks.progress || (message => console.error(message));
    if (options.rollback) {
        const root = fs.realpathSync(options.projectDir);
        await checkStopped(options.port);
        const release = acquireLock(root);
        try { return rollback(root, options.rollback); } finally { release(); }
    }
    const state = inspect(options.projectDir);
    const report = { mode: 'dry-run', projectDir: state.root, advisory: ADVISORY, runtimePath: state.runtimeKey,
        engines: state.engines, needsRepair: state.needsRepair, requiresServiceRestart: true };
    if (!options.apply || !state.needsRepair) {
        if (options.apply) report.mode = 'already-safe';
        return report;
    }
    await checkStopped(options.port);
    const release = acquireLock(state.root);
    let directory, stage, record, changed = false;
    try {
        const base = contained(state.root, MAINTENANCE);
        for (const item of fs.readdirSync(base, { withFileTypes: true })) {
            const journal = item.isDirectory() ? path.join(base, item.name, 'repair.json') : null;
            if (journal && fs.existsSync(journal) && ['applying', 'rollback-failed'].includes(readJSON(journal).status))
                throw new Error(`发现未完成的修复，请先回滚：${path.dirname(journal)}`);
        }
        directory = fs.mkdtempSync(path.join(base, 'engineio-'));
        stage = path.join(directory, 'stage'); fs.mkdirSync(stage, { mode: 0o700 });
        fs.writeFileSync(path.join(directory, 'package.json'), state.manifestBytes, { mode: 0o600 });
        fs.writeFileSync(path.join(directory, 'package-lock.json'), state.lockBytes, { mode: 0o600 });
        fs.writeFileSync(path.join(stage, 'package.json'), state.manifestBytes);
        fs.writeFileSync(path.join(stage, 'package-lock.json'), state.lockBytes);
        const npmrc = contained(state.root, '.npmrc');
        if (fs.existsSync(npmrc)) fs.copyFileSync(npmrc, path.join(stage, '.npmrc'));
        const cache = path.join(base, 'npm-cache');
        progress('正在隔离目录中解析 Engine.IO 安全补丁；尚未修改生产依赖…');
        await npm(['update', 'engine.io', '--package-lock-only', `--lockfile-version=${state.lock.lockfileVersion}`, '--ignore-scripts', '--no-audit', '--no-fund'], stage, cache);
        if (!fs.readFileSync(path.join(stage, 'package.json')).equals(state.manifestBytes)) throw new Error('npm 修改了 package.json，已拒绝应用');
        const plannedBytes = fs.readFileSync(path.join(stage, 'package-lock.json'));
        const planned = JSON.parse(plannedBytes); validatePlan(state.lock, planned);
        progress('正在隔离安装并验证协议、连接升级和二进制传输…');
        await npm(['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], stage, cache);
        if (!fs.readFileSync(path.join(stage, 'package-lock.json')).equals(plannedBytes)) throw new Error('隔离安装改写了锁文件，已拒绝应用');
        report.stagingProbe = await verify(stage);
        const targets = [];
        for (const item of state.engines) {
            const next = planned.packages[item.key];
            if (item.installedVersion === next.version && isDeepStrictEqual(state.lock.packages[item.key], next)) continue;
            if (!item.installedVersion) throw new Error(`原依赖缺失：${item.key}；先核对实际安装状态`);
            const installedVersion = versionParts(item.installedVersion);
            if (!safePatch(next.version) || !installedVersion || installedVersion[0] !== 6 || installedVersion[1] !== 6 || installedVersion[2] > versionParts(next.version)[2])
                throw new Error(`无法安全替换 ${item.key}`);
            const source = contained(stage, item.key), current = contained(state.root, item.key);
            if (readJSON(path.join(source, 'package.json')).version !== next.version) throw new Error('隔离安装版本与计划不一致');
            const target = { key: item.key, beforeVersion: item.installedVersion, afterVersion: next.version,
                beforeHash: treeHash(current), afterHash: treeHash(source) };
            const backup = contained(directory, `original/${item.key}`);
            fs.mkdirSync(path.dirname(backup), { recursive: true }); fs.cpSync(current, backup, { recursive: true, force: false, errorOnExist: true });
            if (treeHash(backup) !== target.beforeHash) throw new Error('备份依赖校验失败');
            targets.push(target);
        }
        record = { format: 1, projectDir: state.root, createdAt: new Date().toISOString(), status: 'prepared', targets,
            manifestHash: hash(state.manifestBytes), originalLockHash: hash(state.lockBytes), plannedLockHash: hash(plannedBytes) };
        writeJournal(directory, record);
        await checkStopped(options.port);
        if (!fs.readFileSync(contained(state.root, 'package.json')).equals(state.manifestBytes) || !fs.readFileSync(contained(state.root, 'package-lock.json')).equals(state.lockBytes))
            throw new Error('维护期间项目清单发生变化，未应用');
        for (const target of targets) if (treeHash(contained(state.root, target.key)) !== target.beforeHash) throw new Error('维护期间原依赖发生变化，未应用');
        record.status = 'applying'; writeJournal(directory, record); changed = true;
        progress('备份及隔离验证通过，正在替换 Engine.IO 并核验生产目录…');
        report.leftovers = [];
        for (const target of targets) {
            const result = replaceTree(state.root, target.key, contained(stage, target.key), target.afterHash);
            if (result.leftover) report.leftovers.push(result.leftover);
        }
        atomicWrite(contained(state.root, 'package-lock.json'), plannedBytes);
        report.installedProbe = await verify(state.root);
        const installed = inspect(state.root);
        if (installed.needsRepair) throw new Error('替换后仍存在本次漏洞版本');
        for (const target of targets) if (treeHash(contained(state.root, target.key)) !== target.afterHash) throw new Error('替换后的依赖校验失败');
        record.status = 'applied'; record.finishedAt = new Date().toISOString(); writeJournal(directory, record);
        report.mode = 'applied'; report.backupDir = directory; report.engines = installed.engines; report.needsRepair = false;
        report.nextStep = '按实际进程管理方式启动所有本站 Node 进程，确认新 PID/启动时间及站点连接；文件替换不会更新仍运行的旧进程。';
        report.audit = await (hooks.audit || auditSummary)(state.root, cache);
        return report;
    } catch (error) {
        if (changed) {
            try { rollback(state.root, directory); error.message += `；已自动回滚，备份：${directory}`; }
            catch (rollbackError) {
                record.status = 'rollback-failed'; writeJournal(directory, record);
                error.message += `；自动回滚失败：${rollbackError.message}。保持服务停止，备份：${directory}`;
            }
        }
        throw error;
    } finally {
        try { if (stage && fs.existsSync(stage)) fs.rmSync(contained(state.root, path.relative(state.root, stage)), { recursive: true, force: true }); }
        catch (_) { console.error(`临时安装目录未能清理：${stage}；服务停止后可手动清理。保留 original 备份和 repair.json。`); }
        release();
    }
}

const HELP = `用法：
  node tools/repair-engineio-security.cjs [--project-dir <实际部署目录>]
  node tools/repair-engineio-security.cjs --apply --service-stopped --port <实际 Node 端口>
  node tools/repair-engineio-security.cjs --rollback <backupDir> --service-stopped --port <实际 Node 端口>
默认只检查，不写入、不联网。实际修复前必须停止所有本站 Node 进程及自动重启。
支持 npm 锁文件 v2/v3，只升级 Engine.IO 6.6.x 安全补丁。不会启动或停止生产服务。
说明：tools/repair-engineio-security.md`;

if (require.main === module) {
    Promise.resolve().then(() => {
        const options = argumentsFor(process.argv.slice(2));
        return options.help ? HELP : main(options);
    }).then(result => console.log(typeof result === 'string' ? result : JSON.stringify(result, null, 2)))
        .catch(error => { console.error(`Engine.IO 修复失败：${redact(error.message)}`); process.exitCode = 1; });
}

module.exports = { argumentsFor, main, inspect, validatePlan, vulnerable, safePatch, treeHash, rollback, assertStopped, probe };
