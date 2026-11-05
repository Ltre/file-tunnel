'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '../server.js'), 'utf8');
const handler = source.slice(source.indexOf("    socket.on('text-message-edit'"), source.indexOf("    socket.on('markdown-message-edit'"));
function fixture() {
    const original = { id: 'text-record', type: 'text', text: 'old', sender: 'author', timestamp: 123, favorite: true };
    const size = Buffer.byteLength(JSON.stringify(original));
    const session = { devices: new Map([['editor', {}]]), history: [{ message: original, size }], historySize: size };
    let edit, writes = 0; const denied = new Set(), sessions = new Map([['tunnel', session]]);
    vm.runInNewContext(handler, { socket: { on: (_name, run) => { edit = run; } }, sessions, currentSession: 'tunnel', currentDevice: 'editor',
        canUseTunnelCapability: (_s, _d, capability) => !denied.has(capability), checkMessageRate: () => true,
        Buffer, Date, MAX_MESSAGE_SIZE: 1048576, MAX_HISTORY_SIZE: 2097152, createHistoryMessage: structuredClone,
        persistHistoryAudit: () => { writes++; }, emitToReadableSessionDevices() {}, scheduleSessionHistoryBroadcast() {}, console });
    return { session, denied, original, get writes() { return writes; }, call: data => { let response; edit(data, value => { response = value; }); return response; } };
}
test('text editing confirms the persisted record, retains identity and makes an identical retry harmless', () => {
    const f = fixture(), input = { sessionId: 'tunnel', messageId: 'text-record', baseText: 'old', text: '新文本\n<plain> 😀' };
    const result = f.call(input); assert.equal(result.ok, true); assert.equal(result.message.text, input.text);
    assert.equal(result.message.sender, 'author'); assert.equal(result.message.timestamp, 123); assert.equal(result.message.favorite, true);
    assert.equal(result.message.textVersion, 2);
    assert.equal(f.session.historySize, Buffer.byteLength(JSON.stringify(result.message)));
    assert.equal(f.call(input).ok, true); assert.equal(f.writes, 1);
    assert.equal(f.call({ ...input, text: 'stale overwrite' }).error, 'text-conflict'); assert.equal(f.writes, 1);
});
test('text editing rejects wrong tunnels, revoked permissions, missing records and empty input', () => {
    const input = { sessionId: 'tunnel', messageId: 'text-record', baseText: 'old', text: 'new' };
    for (const capability of ['read', 'sendText']) { const f = fixture(); f.denied.add(capability); assert.equal(f.call(input).error, 'permission-denied'); assert.equal(f.writes, 0); }
    const f = fixture();
    assert.equal(f.call({ ...input, sessionId: 'other' }).error, 'invalid-session');
    assert.equal(f.call({ ...input, messageId: 'deleted' }).error, 'message-not-found');
    assert.equal(f.call({ ...input, text: ' ' }).error, 'invalid-text');
    assert.equal(f.call({ ...input, text: 'x'.repeat(1048577) }).error, 'invalid-text');
    assert.equal(f.writes, 0); assert.equal(f.session.history[0].message, f.original);
});

test('a delayed text acknowledgement cannot overwrite a newer local revision', async () => {
    const app = fs.readFileSync(require('node:path').join(__dirname, '../app.js'), 'utf8');
    const start = app.indexOf('async function applyHistoryMessageUpdate('), end = app.indexOf('async function updateHistoryMessage(', start);
    let writes = 0;
    const c = { state:{sessionId:'tunnel'}, isHistoryMessageDeleted:()=>false, getFromStore:async()=>({type:'text',textVersion:3}), saveToStore:async()=>{writes++;} };
    vm.createContext(c); vm.runInContext(app.slice(start,end),c);
    await c.applyHistoryMessageUpdate({id:'record',type:'text',text:'late',textVersion:2});
    assert.equal(writes,0);
});
