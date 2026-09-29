'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), vm = require('node:vm');
const express = require('express');
const { createTelegramChatDictionary, createTelegramChatResolver, registerTelegramChatSourceRoute } = require('../server/telegram-chat-dictionary');
const source = name => fs.readFileSync(path.join(__dirname, '..', name), 'utf8');
const app = source('app.js'), workshop = source('client/web-workshop.js');
const block = (text, start, end) => text.slice(text.indexOf(start), text.indexOf(end, text.indexOf(start)));
const chatId = '-1001234567890';

test('手动 Chat 验证路由只确认已配置的映射，不下载文件、不猜测 public 来源', async t => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manual-chat-'));
    const dictionary = createTelegramChatDictionary({ dataDir });
    dictionary.replace([{ chatId, username: '@old_name', aliases: ['@old_alias'] }], dictionary.list().revision);
    let enabled = true, failure = false, mismatch = false;
    const calls = [];
    const resolver = createTelegramChatResolver({ dictionary, getChat: async id => { calls.push(id); if (failure) throw new Error('unavailable'); return { id: mismatch ? '-1009999' : chatId }; } });
    const serverApp = express(); serverApp.use(express.json());
    registerTelegramChatSourceRoute(serverApp, { resolver, isAllowedSession: id => id === 'session-1', credentials: () => enabled ? { token: 'bot' } : null });
    assert.deepEqual(calls, [], '注册及打开页面不查询 Telegram');
    const server = serverApp.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
    t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); fs.rmSync(dataDir, { recursive: true, force: true }); });
    const request = async (publicName, sessionId = 'session-1') => {
        const response = await fetch(`http://127.0.0.1:${server.address().port}/api/telegram/assets/resolve-chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId, source: publicName }) });
        return { status: response.status, value: await response.json() };
    };
    assert.equal((await request('@old_name', 'wrong-session')).status, 403); assert.equal(calls.length, 0);
    assert.equal((await request('https://t.me/OLD_NAME')).value.chatId, chatId);
    assert.equal((await request('@old_name')).value.chatId, chatId); assert.deepEqual(calls, [chatId]);
    assert.equal((await request('@unknown_name')).value.chatId, '');
    assert.equal((await request(chatId)).value.chatId, ''); assert.equal(calls.length, 1);
    mismatch = true; assert.equal((await request('@old_alias')).value.chatId, '');
    mismatch = false; failure = true; assert.equal((await request('@old_alias')).value.chatId, '');
    enabled = false; assert.equal((await request('@old_name')).status, 503);
});

function migrationFixture() {
    const files = new Map([['a', { id: 'a', telegramChatId: '@old_name', telegramFileId: 'file-id', cacheCleared: true, ownerDeviceId: 'owner', version: 8 }]]);
    const messages = new Map([
        ['single', { id: 'single', sessionId: 'session-1', fileInfo: { ...files.get('a') } }],
        ['album', { id: 'album', sessionId: 'session-1', collection: { files: [{ ...files.get('a') }, { id: 'other', telegramChatId: '@untouched' }] } }]
    ]);
    const context = vm.createContext({ state: { sessionId: 'session-1' },
        getFromStore: async (_, id) => files.get(id), getCurrentSessionMessages: async () => [...messages.values()],
        saveToStore: async (table, value) => (table === 'files' ? files : messages).set(value.id, value),
        hasCompleteFileCache: file => Boolean(file?.data && !file.cacheCleared) });
    vm.runInContext(block(app, 'async function applyConfirmedTelegramChatLocally(', 'async function fetchServerAssetCacheOnce('), context);
    return { context, files, messages, migrate: (...args) => context.applyConfirmedTelegramChatLocally(...args) };
}

test('主动迁移无需文件缓存，统一单文件/合辑来源且不改变 provider、版本、所有权和清理状态', async () => {
    const f = migrationFixture();
    assert.equal(await f.migrate('a', chatId), false, '原回源路径仍要求完整缓存');
    assert.equal(await f.migrate('a', chatId, { requireCompleteCache: false }), true);
    const file = f.files.get('a');
    assert.equal(file.telegramChatId, chatId); assert.equal(file.telegramFileId, 'file-id');
    assert.equal(file.cacheCleared, true); assert.equal(file.ownerDeviceId, 'owner'); assert.equal(file.version, 8); assert.equal(file.data, undefined);
    assert.equal(f.messages.get('single').fileInfo.telegramChatId, chatId);
    assert.equal(f.messages.get('album').collection.files[0].telegramChatId, chatId);
    assert.equal(f.messages.get('album').collection.files[1].telegramChatId, '@untouched');
    const before = f.files.get('a'); assert.equal(await f.migrate('a', chatId, { requireCompleteCache: false }), false); assert.equal(f.files.get('a'), before);
});

test('无本地文件的纯传输引用可升级；已存在不同数字 ID 时整条资源保持不变', async () => {
    const f = migrationFixture(); f.files.delete('a');
    assert.equal(await f.migrate('a', chatId, { requireCompleteCache: false }), true);
    assert.equal(f.files.has('a'), false, '不创建假缓存文件');
    const conflict = migrationFixture(); conflict.messages.get('album').collection.files[0].telegramChatId = '-100999';
    assert.equal(await conflict.migrate('a', chatId, { requireCompleteCache: false }), false);
    assert.equal(conflict.files.get('a').telegramChatId, '@old_name'); assert.equal(conflict.messages.get('single').fileInfo.telegramChatId, '@old_name');
});

function annotationDB(files, messages, fail = false) {
    return { transaction(names, mode) {
        assert.deepEqual(Array.from(names), ['files', 'messages']); assert.equal(mode, 'readwrite');
        const tx = { error: null }, writes = []; let requests = 0, aborted = false;
        const request = read => { const req = {}; requests++; queueMicrotask(() => {
            try { req.result = read(); req.onsuccess(); }
            catch (error) { aborted = true; tx.error = error; tx.onabort(); }
            if (!--requests && !aborted) { writes.forEach(([table, value]) => (table === 'files' ? files : messages).set(value.id, value)); tx.oncomplete(); }
        }); return req; };
        tx.objectStore = table => ({ get: id => request(() => (table === 'files' ? files : messages).get(id)),
            index: () => ({ getAll: sessionId => request(() => [...messages.values()].filter(message => message.sessionId === sessionId)) }),
            put(value) { if (fail && table === 'messages') throw new Error('storage-full'); writes.push([table, value]); }
        });
        return tx;
    } };
}

test('Chat 标注以单事务更新最新缓存，不覆盖并发写入的字节；失败不留下半套来源', async () => {
    for (const fail of [false, true]) {
        const f = migrationFixture();
        f.context.state.db = annotationDB(f.files, f.messages, fail);
        const transaction = f.context.state.db.transaction;
        f.context.state.db.transaction = (...args) => { f.files.set('a', { ...f.files.get('a'), data: new Uint8Array([1, 2]), cacheCleared: false }); return transaction(...args); };
        f.context.getFromStore = async () => { throw new Error('不应在事务外再次复制文件字节'); };
        const pending = f.migrate('a', chatId, { requireCompleteCache: false });
        if (fail) await assert.rejects(pending, /storage-full/); else assert.equal(await pending, true);
        assert.equal(f.files.get('a').data.byteLength, 2);
        assert.equal(f.files.get('a').telegramChatId, fail ? '@old_name' : chatId);
        assert.equal(f.messages.get('single').fileInfo.telegramChatId, fail ? '@old_name' : chatId);
    }
});

test('迁移请求只位于手动检测函数：同名映射只请求一次，数字、未知、验证失败来源不改写', async () => {
    const resources = [
        { id: 'a', name: 'a', isTelegramSource: true, telegramChatId: '@old_name' },
        { id: 'b', name: 'b', isTelegramSource: true, telegramChatId: 't.me/OLD_NAME' },
        { id: 'numeric', name: 'n', isTelegramSource: true, telegramChatId: chatId },
        { id: 'missing', name: 'm', isTelegramSource: true, telegramChatId: '@unknown_name' },
        { id: 'failure', name: 'f', isTelegramSource: true, telegramChatId: '@failed_name' }
    ];
    const requests = [], patched = [];
    const context = vm.createContext({ state: { sessionId: 'session-1' }, getSessionResourceInventory: async () => resources,
        showAppToast() {}, showResourceBrowser: async () => {}, historyLog() {}, sleep: async () => {},
        showBlockingProgressPanel: () => ({ update() {}, close() {} }),
        waitForTelegramRepairCache: () => { throw new Error('must not fetch cache for non-repairable resources'); },
        applyConfirmedTelegramChatLocally: async (id, value, options) => { assert.equal(options.requireCompleteCache, false); patched.push([id, value]); return true; },
        fetch: async (url, options) => { const data = JSON.parse(options.body); requests.push([url, data]);
            if (url.endsWith('resolve-chat')) { if (data.source === '@failed_name') throw new Error('offline'); return { ok: true, json: async () => ({ chatId: data.source === '@old_name' ? chatId : '' }) }; }
            return { ok: true, json: async () => ({ results: [{ valid: false, repairable: false }] }) };
        }
    });
    const repair = block(app, 'async function runTelegramFileContinuityRepair(', 'async function showResourceBrowser(');
    assert.equal((app.match(/fetch\('\/api\/telegram\/assets\/resolve-chat'/g) || []).length, 1);
    vm.runInContext(repair, context); assert.equal(requests.length, 0);
    await context.runTelegramFileContinuityRepair();
    assert.deepEqual(patched, [['a', chatId], ['b', chatId]]);
    assert.equal(requests.filter(([url, data]) => url.endsWith('resolve-chat') && data.source === '@old_name').length, 1);
    assert.equal(requests.filter(([url]) => url.endsWith('resolve-chat')).length, 3);
});

function workshopFixture(mode = 'minimized') {
    const saved = [], rendered = [], events = [];
    let release;
    const context = vm.createContext({ presentationMode: mode, presentationRevision: 0,
        ensureUi() {}, showForContent() { if (context.presentationMode === 'closed') context.presentationMode = 'open'; },
        restore() { events.push('restore'); context.presentationMode = 'open'; },
        cleanupSandboxes: async () => {}, all: async () => [], get: async () => null, put: async () => {}, SANDBOX_TTL: 1000,
        global: { FolderArchive: { extractZip: () => new Promise(resolve => { release = () => resolve([{ path: 'index.html', data: new Uint8Array([49, 50, 51]) }]); }) } },
        normalizeEntries: entries => entries, guessType: () => 'text/html', readPackageManifest: () => null,
        uid: () => 'draft-1', safeName: name => name.replace(/\.html\.zip$/, ''), config: { deviceId: () => 'device' },
        isDirectory: () => false, saveDraft: async draft => saved.push(draft), renderEditor: async draft => rendered.push(draft),
        Date, Object, TextEncoder, prompt() { throw new Error('name is provided'); }
    });
    vm.runInContext(block(workshop, 'function revealImportEditor(', 'async function renderHome('), context);
    vm.runInContext(block(workshop, 'async function packageSandbox(', 'async function openPackage('), context);
    return { context, saved, rendered, events, release: () => release() };
}

test('传输记录显式编辑可恢复最小化工坊，实际保存草稿并返回结果；普通导入不解除最小化', async () => {
    for (const revealEditor of [true, false]) {
        const f = workshopFixture();
        const pending = f.context.importPackage({ id: 'zip-1', name: 'source.html.zip' }, { size: 3 }, { messageId: 'record-1', revealEditor });
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(f.context.presentationMode, revealEditor ? 'open' : 'minimized');
        f.release(); const draft = await pending;
        assert.equal(draft.sourceFileId, 'zip-1'); assert.equal(draft.sourceMessageId, 'record-1'); assert.equal(draft.publishMode, 'update');
        assert.equal(draft.name, 'source'); assert.equal(draft.files[0].data[0], 49);
        assert.equal(f.saved.length, 1); assert.equal(f.rendered.length, 1);
        assert.equal(f.events.length, revealEditor ? 1 : 0);
    }
});

test('用户在解压过程中明确关闭工坊时不创建幽灵草稿，也不自动重新展开', async () => {
    const f = workshopFixture('closed');
    const pending = f.context.importPackage({ id: 'zip-1', name: 'source.html.zip' }, { size: 3 }, { revealEditor: true });
    await new Promise(resolve => setImmediate(resolve));
    f.context.presentationMode = 'closed'; f.context.presentationRevision++;
    f.release(); assert.equal(await pending, null); assert.equal(f.saved.length, 0); assert.equal(f.context.presentationMode, 'closed');
});

test('导入对话框保持到草稿保存成功；失败和中途关闭不静默吞掉结果', async () => {
    for (const outcome of ['success', 'failure', 'closed', 'cancelled']) {
        const listeners = {}, alerts = [], calls = [];
        const buttons = {};
        let release;
        const loading = new Promise(resolve => { release = resolve; });
        const dialog = { isConnected: true, innerHTML: '', remove() { this.isConnected = false; }, addEventListener() {},
            querySelector(selector) { if (selector.includes('request')) return null; if (!buttons[selector]) buttons[selector] = { textContent: '转入草稿箱编辑', addEventListener: (_, fn) => { listeners[selector] = fn; } }; return buttons[selector]; } };
        const context = vm.createContext({ state: { deviceId: 'device' }, canEditWebZip: () => true, escapeHtml: text => text,
            document: { querySelector: () => null, createElement: () => dialog, body: { append() {} } }, alert: message => alerts.push(message),
            getWebZipBlob: () => loading,
            window: { WebWorkshop: { importPackage: async (...args) => { calls.push(args); if (outcome === 'failure') throw new Error('storage-full'); return outcome === 'cancelled' ? null : { id: 'draft' }; } } }
        });
        vm.runInContext(block(app, 'function showWebZipEditDialog(', 'async function publishWebZipUpdate('), context);
        context.showWebZipEditDialog({ id: 'zip', creatorDeviceId: 'device' }, { messageId: 'message' });
        const selector = '[data-web-zip-action="edit"]', button = buttons[selector];
        const pending = listeners[selector]({ currentTarget: button });
        assert.equal(dialog.isConnected, true); assert.equal(button.disabled, true); assert.equal(button.textContent, '正在导入…');
        if (outcome === 'closed') dialog.remove();
        release({ size: 3 }); await pending;
        assert.equal(button.disabled, false);
        if (outcome === 'closed') { assert.equal(calls.length, 0); continue; }
        assert.equal(calls[0][2].revealEditor, true); assert.equal(calls[0][3], 'update');
        assert.equal(dialog.isConnected, outcome !== 'success');
        assert.equal(alerts.length, outcome === 'failure' ? 1 : 0);
    }
});
