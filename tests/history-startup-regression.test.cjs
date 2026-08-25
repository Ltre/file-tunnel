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

test('frontend does not restore the bounded or deferred history strategy', () => {
    const app = read('app.js');
    const page = read('pages/index.html');

    assert.doesNotMatch(app, /INITIAL_HISTORY_RENDER_LIMIT/);
    assert.doesNotMatch(app, /loadOlderHistoryBatch/);
    assert.doesNotMatch(app, /historyMessageIndex/);
    assert.doesNotMatch(app, /deferFileCache/);
    assert.doesNotMatch(app, /new IntersectionObserver/);
    assert.doesNotMatch(page, /history-load-control/);

    assert.doesNotMatch(app, /historyProtocolVersion\s*:\s*2/);
    assert.doesNotMatch(app, /data\.unchanged\s*===\s*true/);
    assert.match(app, /\[0, 3000, 12000\]\.forEach/);
});

test('cached history restores every record through the normal render path in timestamp order', async () => {
    const source = read('app.js');
    const loadSessionDataSource = readFunctionSource(source, 'loadSessionData', 'fileToBase64');
    const messages = Array.from({ length: 5000 }, (_, index) => ({
        id: `message-${String(index).padStart(5, '0')}`,
        sessionId: 'session-large',
        sender: 'sender',
        timestamp: 5000 - index,
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
        state: { sessionId: 'session-large', deviceId: 'self', pendingRecordId: '' },
        IDBKeyRange: { only: value => value },
        console: { log() {}, error() {} },
        getAllFromStore: async store => store === 'messages' ? messages : [],
        getFromStore: async () => null,
        saveToStore: async () => {},
        compareHistoryMessages: (left, right) => left.timestamp - right.timestamp,
        summarizeHistoryMessage: message => ({ id: message.id }),
        historyLog: (event, details) => logEntries.push({ event, details }),
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

    assert.equal(renderCalls.length, messages.length);
    assert.deepEqual(
        renderCalls.map(call => call.message.timestamp),
        Array.from({ length: messages.length }, (_, index) => index + 1)
    );
    assert.equal(renderCalls.every(call => call.options.scroll === false), true);
    assert.equal(renderCalls.every(call => !Object.hasOwn(call.options, 'deferFileCache')), true);
    const rendered = logEntries.find(entry => entry.event === 'indexeddb-history-rendered');
    assert.equal(rendered.details.messageCount, messages.length);
    assert.equal(Object.hasOwn(rendered.details, 'deferredCount'), false);
});

test('server sends a full snapshot to legacy clients and keeps revision mode optional', () => {
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
        deletedMessageIds: ['deleted-message']
    };
    const historyRevision = runtime.calculateSessionHistoryRevision(session);

    runtime.emitSessionSnapshot(socket, 'session-large', session, 'device-1', {
        historyRevision,
        historyMessageCount: 5000
    });
    const legacy = emitted.pop().payload;
    assert.equal(legacy.messages.length, 5000);
    assert.deepEqual(Array.from(legacy.deletedMessageIds), ['deleted-message']);
    assert.equal(legacy.reason, 'snapshot');
    assert.equal(Object.hasOwn(legacy, 'authoritative'), false);
    assert.equal(Object.hasOwn(legacy, 'unchanged'), false);
    assert.equal(Object.hasOwn(legacy, 'historyRevision'), false);

    runtime.emitSessionSnapshot(socket, 'session-large', session, 'device-1', {
        historyProtocolVersion: 2,
        historyRevision,
        historyMessageCount: 5000
    });
    const revisionAware = emitted.pop().payload;
    assert.equal(revisionAware.messages.length, 0);
    assert.equal(revisionAware.deletedMessageIds.length, 0);
    assert.equal(revisionAware.authoritative, true);
    assert.equal(revisionAware.unchanged, true);
    assert.equal(revisionAware.historyRevision, historyRevision);

    assert.doesNotMatch(app, /historyProtocolVersion\s*:\s*2/);
});

test('ordinary session creation restores only deletion tombstones, not persisted realtime history', () => {
    const server = read('server.js');
    const joinHandlerStart = server.indexOf("socket.on('join-session'");
    const sessionCreationStart = server.indexOf('if (!sessions.has(sessionId))', joinHandlerStart);
    const sessionCreationEnd = server.indexOf('const session = sessions.get(sessionId)', sessionCreationStart);

    assert.ok(joinHandlerStart >= 0, 'join-session handler must exist');
    assert.ok(sessionCreationStart >= 0 && sessionCreationEnd > sessionCreationStart,
        'ordinary session creation block must exist');
    const sessionCreation = server.slice(sessionCreationStart, sessionCreationEnd);
    assert.match(sessionCreation, /sessions\.set\(sessionId,\s*\{/);
    assert.match(sessionCreation, /history\s*:\s*\[\]/);
    assert.match(sessionCreation, /deletedMessageIds\s*:\s*loadPersistedDeletionTombstones\(sessionId\)/);
    assert.match(server, /function loadPersistedDeletionTombstones[\s\S]*?listDeletedHistoryIds/);
    assert.match(server, /listDeletedHistoryIds[\s\S]*?slice\(0, MAX_HISTORY_MESSAGES\)\.reverse\(\)/);
    assert.match(server, /history-reconcile[\s\S]*?findDeletedHistoryIds[\s\S]*?deletedMessageIds\.has\(message\.id\)/);
    assert.doesNotMatch(sessionCreation, /infraStore[^\n]*history|persisted[^\n]*history/i);
    assert.doesNotMatch(server, /hydratePersistedSessionHistory/);
});

test('deferred audit queue retries synchronous failures and finalizes its coalescing key', () => {
    const server = read('server.js');
    const queueSource = readFunctionSource(server, 'finishInfraAuditEntry', 'persistHistoryAudit');
    const context = vm.createContext({
        INFRA_AUDIT_MAX_ATTEMPTS: 3,
        infraAuditQueue: [],
        infraAuditPendingByKey: new Map(),
        infraAuditDrainScheduled: false,
        infraStore: { flush: () => true },
        setImmediate: callback => callback(),
        console: { warn() {}, error() {} }
    });
    vm.runInContext(queueSource, context);

    let retryAttempts = 0;
    let completed = 0;
    let permanentlyFailed = 0;
    context.enqueueInfraAudit(() => {
        retryAttempts++;
        if (retryAttempts < 3) throw new Error('transient-audit-failure');
    }, 'history:session:message', {
        onSuccess: () => completed++,
        onFinalFailure: () => permanentlyFailed++
    });

    assert.equal(retryAttempts, 3);
    assert.equal(completed, 1);
    assert.equal(permanentlyFailed, 0);
    assert.equal(context.infraAuditQueue.length, 0);
    assert.equal(context.infraAuditPendingByKey.size, 0);

    let finalAttempts = 0;
    context.enqueueInfraAudit(() => {
        finalAttempts++;
        throw new Error('permanent-audit-failure');
    }, 'history:session:permanent', {
        onFinalFailure: () => permanentlyFailed++
    });

    assert.equal(finalAttempts, 3);
    assert.equal(permanentlyFailed, 1);
    assert.equal(context.infraAuditPendingByKey.size, 0);
});

test('occupied HTTP port is reported as a failed restart instead of an unhandled event', () => {
    const server = read('server.js');

    assert.match(server, /await new Promise\(\(resolve, reject\) => \{/);
    assert.match(server, /webServer\.once\('error', handleStartupError\)/);
    assert.match(server, /err\?\.code === 'EADDRINUSE'/);
    assert.match(server, /本次 npm start 没有启动成功/);
    assert.match(server, /let shutdownStarted = false/);
    assert.match(server, /process\.once\('SIGHUP', \(\) => shutdown\('SIGHUP'\)\)/);
});
