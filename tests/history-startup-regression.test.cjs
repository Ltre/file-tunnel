'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const read = relative => fs.readFileSync(path.join(ROOT, relative), 'utf8');

function readFunctionSource(source, name, nextFunctionName) {
    const asyncStart = source.indexOf(`async function ${name}(`);
    const plainStart = source.indexOf(`function ${name}(`);
    const start = asyncStart >= 0 ? asyncStart : plainStart;
    let end = source.indexOf(`function ${nextFunctionName}(`, start);
    if (source.slice(Math.max(0, end - 6), end) === 'async ') end -= 6;
    assert.ok(start >= 0 && end > start, `unable to extract ${name}`);
    return source.slice(start, end);
}

test('durable history keeps a bounded startup DOM and loads older records on demand', () => {
    const app = read('app.js');
    const page = read('pages/index.html');

    assert.match(app, /const INITIAL_HISTORY_RENDER_LIMIT = 80/);
    assert.match(app, /const initialMessages = messages\.slice\(-INITIAL_HISTORY_RENDER_LIMIT\)/);
    assert.match(app, /loadOlderHistoryBatch\(\)/);
    assert.match(app, /historyMessageIndex\.slice\(nextStart, historyRenderStartIndex\)/);
    assert.match(app, /deferFileCache: true/);
    assert.match(app, /new IntersectionObserver/);
    assert.match(page, /history-load-control/);
});

test('five thousand cached records render only eighty startup rows', async () => {
    const source = read('app.js');
    const loadSessionDataSource = readFunctionSource(source, 'loadSessionData', 'fileToBase64');
    const messages = Array.from({ length: 5000 }, (_, index) => ({
        id: `message-${String(index).padStart(5, '0')}`,
        sessionId: 'session-large',
        sender: 'sender',
        timestamp: index + 1,
        type: 'file',
        fileInfo: { id: `file-${index}`, size: 10 * 1024 * 1024 }
    }));
    const renderCalls = [];
    const logEntries = [];
    const chatMessages = {
        classList: { add() {}, remove() {} },
        scrollHeight: 100,
        scrollTop: 0
    };
    const context = {
        state: { sessionId: 'session-large', deviceId: 'self' },
        IDBKeyRange: { only: value => value },
        INITIAL_HISTORY_RENDER_LIMIT: 80,
        HISTORY_DEBUG: false,
        console: { log() {}, error() {} },
        getAllFromStore: async store => store === 'messages' ? messages : [],
        getFromStore: async () => null,
        saveToStore: async () => {},
        compareHistoryMessages: (left, right) => left.timestamp - right.timestamp,
        summarizeHistoryMessage: message => ({ id: message.id }),
        historyLog: (event, details) => logEntries.push({ event, details }),
        setHistoryMessageIndex() {},
        addMessageToChat: async (message, isOwn, options) => renderCalls.push({ message, isOwn, options }),
        document: { getElementById: id => id === 'chatMessages' ? chatMessages : null },
        requestAnimationFrame: callback => callback(),
        getMessageElement: () => null,
        settleMobileWorkspaceView() {},
        scrollMessageInsideChat() {},
        pinChatScrollToDomAnchor() {},
        flashResourceTarget() {},
        pinChatScrollToBottom() {},
        scheduleChatScrollAnchorSave() {},
        settleCurrentMobileWorkspaceView() {},
        sleep: async () => {},
        chatScrollAnchorMessageId: ''
    };

    const runtime = vm.createContext(context);
    const loadSessionData = vm.runInContext(`(${loadSessionDataSource})`, runtime);
    await loadSessionData();

    assert.equal(renderCalls.length, 80);
    assert.deepEqual(
        { autoRequestAsset: renderCalls[0].options.autoRequestAsset, deferFileCache: renderCalls[0].options.deferFileCache },
        { autoRequestAsset: false, deferFileCache: true }
    );
    const rendered = logEntries.find(entry => entry.event === 'indexeddb-history-rendered');
    assert.equal(rendered.details.messageCount, 80);
    assert.equal(rendered.details.deferredCount, 4920);
});

test('server snapshots persist all records but only render the latest startup window', () => {
    const app = read('app.js');

    assert.match(app, /const snapshotRenderIds = new Set\(messages[\s\S]*?\.slice\(-INITIAL_HISTORY_RENDER_LIMIT\)/);
    assert.match(app, /const existingById = new Map\(existingMessages/);
    assert.match(app, /if \(shouldRender\) \{[\s\S]*?addMessageToChat\(message/);
    assert.match(app, /setHistoryMessageIndex\(await getCurrentSessionMessages\(\), \{ preserveStart: true \}\)/);
});

test('matching history revision transfers zero record bodies on refresh', () => {
    const source = read('server.js');
    const app = read('app.js');
    const functionSource = readFunctionSource(source, 'calculateSessionHistoryRevision', 'emitToReadableSessionDevices');
    const emitted = [];
    const runtime = vm.createContext({
        crypto: require('node:crypto'),
        HISTORY_DEBUG: false,
        sanitizeString: value => String(value || '').slice(0, 100),
        summarizeHistoryMessage: message => ({ id: message.id }),
        historyLog() {}
    });
    vm.runInContext(functionSource, runtime);
    const socket = { id: 'socket-1', emit: (event, payload) => emitted.push({ event, payload }) };
    const session = {
        history: Array.from({ length: 5000 }, (_, index) => {
            const message = { id: `message-${index}`, timestamp: index, type: 'text', text: `record-${index}` };
            return { message, size: JSON.stringify(message).length };
        }),
        deletedMessageIds: []
    };

    runtime.emitSessionSnapshot(socket, 'session-large', session, 'device-1', {
        historyProtocolVersion: 2,
        historyRevision: ''
    });
    const first = emitted.pop().payload;
    assert.equal(first.messages.length, 5000);
    assert.equal(first.authoritative, true);
    assert.equal(first.unchanged, false);

    runtime.emitSessionSnapshot(socket, 'session-large', session, 'device-1', {
        historyProtocolVersion: 2,
        historyRevision: first.historyRevision,
        historyMessageCount: 5000
    });
    const refresh = emitted.pop().payload;
    assert.equal(refresh.messages.length, 0);
    assert.equal(refresh.deletedMessageIds.length, 0);
    assert.equal(refresh.unchanged, true);
    assert.equal(refresh.historyRevision, first.historyRevision);

    runtime.emitSessionSnapshot(socket, 'session-large', session, 'device-1', {
        historyProtocolVersion: 2,
        historyRevision: first.historyRevision,
        historyMessageCount: 4999
    });
    assert.equal(emitted.pop().payload.messages.length, 5000);
    assert.match(app, /historyProtocolVersion: 2/);
    assert.match(app, /if \(data\.unchanged === true && data\.historyRevision\)[\s\S]*?reason: 'history-revision-unchanged'[\s\S]*?return;/);
    assert.match(app, /\[3000, 12000\]\.forEach/);
    assert.doesNotMatch(app, /\[0, 3000, 12000\]\.forEach/);
});

test('unchanged client snapshot bypasses local history reconciliation', async () => {
    const source = read('app.js');
    const functionSource = readFunctionSource(source, 'handleSessionHistory', 'getCurrentSessionMessages');
    const emitted = [];
    let reconciled = 0;
    const context = vm.createContext({
        state: {
            sessionId: 'session-large',
            deviceId: 'device-1',
            historyRevision: '',
            socket: { emit: (event, payload) => emitted.push({ event, payload }) }
        },
        historyMessageIndex: [],
        historyLog() {},
        rememberSessionHistoryRevision: async revision => { context.state.historyRevision = revision; },
        reconcileLocalHistory: async () => { reconciled += 1; }
    });
    const handleSessionHistory = vm.runInContext(`(${functionSource})`, context);

    await handleSessionHistory({ messages: [], unchanged: true, historyRevision: 'revision-1' });

    assert.equal(reconciled, 0);
    assert.equal(emitted.length, 1);
    assert.equal(emitted[0].event, 'session-history-ack');
    assert.equal(emitted[0].payload.unchanged, true);
});

test('occupied HTTP port is reported as a failed restart instead of an unhandled event', () => {
    const server = read('server.js');

    assert.match(server, /await new Promise\(\(resolve, reject\) => \{/);
    assert.match(server, /webServer\.once\('error', handleStartupError\)/);
    assert.match(server, /err\?\.code === 'EADDRINUSE'/);
    assert.match(server, /本次 npm start 没有启动成功/);
});
