'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), vm = require('node:vm');
const { createAudioTrackRepair, registerAudioTrackRepairRoutes, resolveTelegramForwardFile } = require('../server/audio-track-repair');

function repairFixture(t) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'forward-variant-261011-3-'));
    t.after(() => fs.rmSync(directory, { recursive:true, force:true }));
    const file = { path:path.join(directory, 'source.mp4'), name:'片段.mp4' };
    fs.writeFileSync(file.path, 'original-body');
    let task = { id:'clip', status:'completed', downloadSections:'*00:10-00:20', mediaType:'video', asMusic:false };
    let runs = 0;
    const repair = createAudioTrackRepair({
        probe:async () => ({ streams:[{ codec_type:'audio' }, { codec_type:'video' }] }),
        run:async args => { runs++; fs.writeFileSync(args.at(-1), 'repaired-body'); }
    });
    const service = { get:() => task, getFile:() => file, getTaskDirectory:() => directory };
    return { directory, file, repair, service, task:() => task, setTask:next => { task = next; }, runs:() => runs };
}

test('修正版选择只复用已完成的有效缓存，原版保持原文件，失效或非截取视频明确拒绝', async t => {
    const f = repairFixture(t);
    assert.equal(resolveTelegramForwardFile(f.service, 'clip', f.repair).path, f.file.path);
    assert.throws(() => resolveTelegramForwardFile(f.service, 'clip', f.repair, 'audio-repaired'), /音轨修正版尚未完成/);
    assert.equal(f.runs(), 0);
    const corrected = await f.repair.prepare(f.file, f.directory);
    assert.equal(resolveTelegramForwardFile(f.service, 'clip', f.repair, 'audio-repaired').path, corrected.path);
    assert.equal(f.runs(), 1);
    for (const change of [{ downloadSections:'' }, { asMusic:true }, { mediaType:'audio' }, { status:'failed' }]) {
        const before = f.task(); f.setTask({ ...before, ...change });
        assert.throws(() => resolveTelegramForwardFile(f.service, 'clip', f.repair, 'audio-repaired'), /不适用于当前任务/);
        assert.equal(resolveTelegramForwardFile(f.service, 'clip', f.repair, 'original').path, f.file.path);
        f.setTask(before);
    }
    assert.throws(() => resolveTelegramForwardFile(f.service, 'clip', f.repair, '../other'), /未知的.*文件版本/);
    fs.appendFileSync(f.file.path, '-changed');
    assert.throws(() => resolveTelegramForwardFile(f.service, 'clip', f.repair, 'audio-repaired'), /已失效/);
    assert.equal(f.runs(), 1, '转发不会隐式启动转码');
});

test('两个后台状态接口仅在截取视频转码完成且修正版仍可用时给出 forwardAvailable', async t => {
    const express = require('express'), f = repairFixture(t), app = express(); app.use(express.json());
    for (const root of ['/api/sns-dl', '/api/youtube-premium']) registerAudioTrackRepairRoutes(app, {
        root, service:f.service, repair:f.repair, requireAuth:(req, res, next) => req.headers['x-admin'] === '1' ? next() : res.sendStatus(401), sanitizeError:error => error.message
    });
    const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
    t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
    const base = 'http://127.0.0.1:' + server.address().port, headers = { 'x-admin':'1' };
    const firstRoot = '/api/sns-dl/tasks/clip/audio-repair';
    assert.equal((await fetch(base + firstRoot + '/status')).status, 401);
    assert.equal((await fetch(base + firstRoot + '/status', { headers })).status, 404);
    const submitted = await (await fetch(base + firstRoot, { method:'POST', headers })).json();
    assert.equal(submitted.forwardAvailable, false);
    await f.repair.prepare(f.file, f.directory);
    for (const root of ['/api/sns-dl', '/api/youtube-premium']) {
        const status = await (await fetch(`${base}${root}/tasks/clip/audio-repair/status`, { headers })).json();
        assert.equal(status.status, 'completed'); assert.equal(status.forwardAvailable, true);
        f.setTask({ ...f.task(), downloadSections:'' });
        const nonClip = await (await fetch(`${base}${root}/tasks/clip/audio-repair/status`, { headers })).json();
        assert.equal(nonClip.forwardAvailable, false);
        f.setTask({ ...f.task(), downloadSections:'*00:10-00:20' });
    }
    const cached = f.repair.cached(f.file, f.directory); fs.unlinkSync(cached.path);
    const oldJob = await (await fetch(base + firstRoot + '/status?jobId=' + submitted.jobId, { headers })).json();
    assert.equal(oldJob.status, 'completed'); assert.equal(oldJob.forwardAvailable, false, '完成的旧任务不能代替当前文件可用性验证');
});

function uiFixture(task, repairStatus) {
    function element(tag) {
        return { tag, children:[], handlers:{}, value:'', hidden:false, isConnected:true,
            append(...items) { this.children.push(...items); }, replaceChildren(...items) { this.children = items; },
            setAttribute() {}, addEventListener(name, fn) { this.handlers[name] = fn; }, contains() { return false; }, focus() {} };
    }
    const requests = [], window = {};
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../client/telegram-target-forward.js'), 'utf8'), {
        window, document:{ createElement:element, createTextNode:text => text, addEventListener() {} }
    });
    const details = window.TelegramTargetForward.create(task, '/api/sns-dl', async (url, options) => {
        requests.push({ url, options });
        if (url.endsWith('/audio-repair/status')) {
            if (repairStatus instanceof Error) throw repairStatus;
            return repairStatus;
        }
        if (url === '/api/telegram-forward-targets') return { targets:[] };
        if (url.endsWith('/telegram-forward')) return { target:'-100123', fileVariant:JSON.parse(options.body).fileVariant };
        throw Error(url);
    });
    const menu = details.children[1];
    return { details, menu, requests, variantLabel:menu.children[0], variant:menu.children[0].children[1], input:menu.children[1], send:menu.children[5], status:menu.children[6], async open() { details.open = true; await details.handlers.toggle(); } };
}

test('浮层第一行版本选择在服务端确认后显示，提交修正版并正确显示发送结果', async () => {
    const f = uiFixture({ id:'clip', status:'completed', downloadSections:'*10-20', mediaType:'video' }, { status:'completed', forwardAvailable:true });
    assert.equal(f.variantLabel.hidden, true); await f.open();
    assert.equal(f.variantLabel.hidden, false);
    assert.deepEqual(f.variant.children.map(option => option.textContent), ['原版', '音轨修正版']);
    f.variant.value = 'audio-repaired'; f.variant.onchange(); f.input.value = '-100123';
    assert.equal(f.send.textContent, '发送音轨修正版'); await f.send.onclick();
    const sent = f.requests.find(request => request.url.endsWith('/telegram-forward'));
    assert.equal(JSON.parse(sent.options.body).fileVariant, 'audio-repaired');
    assert.match(f.status.textContent, /已将音轨修正版发送/);
    assert.equal(f.variant.disabled, false);
});

test('未截取、音乐、仍在转码、缓存失效或仅旧完成标志均不显示版本选择并继续发送原版', async () => {
    for (const [change, result] of [
        [{ downloadSections:'' }, { status:'completed', forwardAvailable:true }],
        [{ asMusic:true }, { status:'completed', forwardAvailable:true }],
        [{}, { status:'processing', forwardAvailable:false }],
        [{}, { status:'completed', forwardAvailable:false }],
        [{}, { status:'completed' }],
        [{}, Error('缓存不存在')]
    ]) {
        const f = uiFixture({ id:'clip', status:'completed', downloadSections:'*10-20', mediaType:'video', ...change }, result);
        await f.open(); assert.equal(f.variantLabel.hidden, true);
        f.input.value = '-100123'; await f.send.onclick();
        assert.equal(JSON.parse(f.requests.at(-1).options.body).fileVariant, 'original');
    }
});

test('实际转发函数按所选版本构建正文 multipart，文档和视频预览均使用对应文件', async t => {
    const f = repairFixture(t), corrected = await f.repair.prepare(f.file, f.directory);
    const server = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
    const start = server.indexOf('async function forwardTaskFileToTelegram'), end = server.indexOf('\nfunction loadYoutubePremiumMetadataCache', start);
    const multipart = require('../server/telegram-multipart'), received = [];
    const context = {
        fs, audioTrackRepair:f.repair, resolveTelegramForwardFile,
        getTelegramBotToken:() => 'test', resolveTelegramForwardTarget:() => ({ target:'-100123', chatId:'-100123' }),
        getMimeTypeFromFileName:() => 'video/mp4', prepareTelegramForwardVideoThumbnail:async () => null,
        buildTelegramSingleFileMultipart:multipart.buildTelegramSingleFileMultipart, buildTelegramDocumentsMultipart:multipart.buildTelegramDocumentsMultipart,
        rememberTelegramForwardTarget:() => [],
        telegramFetchJson:async (method, request) => {
            const chunks = []; for await (const chunk of request.body) chunks.push(Buffer.from(chunk));
            received.push({ method, body:Buffer.concat(chunks) });
            return { result:{ chat:{ id:'-100123' }, message_id:1 } };
        }
    };
    vm.runInNewContext(server.slice(start, end), context);
    for (const supportVideoPreview of [false, true]) {
        const result = await context.forwardTaskFileToTelegram(f.service, 'clip', { fileVariant:'audio-repaired', target:'-100123', supportVideoPreview }, 'test');
        assert.equal(result.fileVariant, 'audio-repaired');
        assert.ok(received.at(-1).body.includes(fs.readFileSync(corrected.path)));
        assert.equal(received.at(-1).body.includes(fs.readFileSync(f.file.path)), false);
        assert.equal(received.at(-1).method, supportVideoPreview ? 'sendVideo' : 'sendDocument');
    }
    await context.forwardTaskFileToTelegram(f.service, 'clip', { target:'-100123' }, 'test');
    assert.ok(received.at(-1).body.includes(fs.readFileSync(f.file.path)));
    assert.equal(f.runs(), 1);
});
