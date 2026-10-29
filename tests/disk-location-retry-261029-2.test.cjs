'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm');
const source = fs.readFileSync('client/disk-ui.js', 'utf8');
const section = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
function navigationFixture({ accounts, reveal, approve = false } = {}) {
    const calls = [], record = { id: 'saved', status: 'completed', target: { accountId: 'bob', path: 'folder' }, result: { items: [{ id: 'file' }] } };
    const context = vm.createContext({
        telegramDrivePendingSaveId: record.id, telegramDrivePendingSaveRunning: false, telegramDriveNavigationVersion: 2,
        window: { DiskClient: { getAccount: () => 'alice' }, DiskPendingSave: { resume: async (_id, hooks) => hooks.onCompleted(record) } },
        document: { getElementById: () => null }, pendingSaveTransferId: value => value.id,
        pendingSaveRead: accounts || (async () => ({ accounts: [{ identity: { id: 'bob' } }] })), choosePendingSaveTarget() {},
        confirmTelegramDriveAction() {}, pendingSaveFeedback: (message, busy) => calls.push({ message, busy }),
        showAppToast: () => calls.push('toast'), showTelegramDrivePendingSaveBanner: async () => {},
        finishPendingSaveFeedback: () => calls.push('finished'), telegramDriveErrorText: error => error.message,
        revealTelegramDriveUploadedDirectory: reveal || (async () => { calls.push('reveal'); return true; }),
        switchTelegramDriveAccount: async () => { calls.push('switch'); return approve; }, formatFileSize: String, telegramDriveDisplayPath: String
    });
    vm.runInContext(section('async function resumeTelegramDrivePendingSave(', 'function telegramDriveErrorText('), context);
    return { context, calls, run: () => context.resumeTelegramDrivePendingSave() };
}
test('declining the account switch ends the busy notice and retains a retryable saved location', async () => {
    const f = navigationFixture(); await f.run();
    assert.equal(f.calls.at(-1).busy, false); assert.match(f.calls.at(-1).message, /定位已取消/);
    assert.equal(f.context.telegramDrivePendingSaveId, 'saved'); assert.equal(f.calls.includes('finished'), false); assert.equal(f.calls.includes('reveal'), false);
});
test('navigation during an account read prevents the old saved location from switching accounts', async () => {
    let resolve; const f = navigationFixture({ accounts: () => new Promise(done => { resolve = done; }) });
    const run = f.run(); await new Promise(setImmediate); f.context.telegramDriveNavigationVersion++;
    resolve({ accounts: [{ identity: { id: 'bob' } }] }); await run;
    assert.equal(f.calls.includes('switch'), false); assert.equal(f.calls.includes('finished'), false); assert.equal(f.calls.at(-1).busy, false);
});
test('a delayed old account lookup cannot overwrite a newer pending flow', async () => {
    let resolve; const f = navigationFixture({ accounts: () => new Promise(done => { resolve = done; }) });
    const run = f.run(); await new Promise(setImmediate); f.context.telegramDrivePendingSaveId = 'newer'; const before = f.calls.length;
    resolve({ accounts: [{ identity: { id: 'bob' } }] }); await run;
    assert.equal(f.context.telegramDrivePendingSaveId, 'newer'); assert.equal(f.calls.length, before); assert.equal(f.calls.includes('switch'), false);
});
test('saved location read failure retains the receipt link; retry locates without submitting another transfer', async () => {
    let id = 'saved', failed = true, cleared = 0, submits = 0, highlighted = 0;
    const record = { id, status: 'completed', target: { accountId: 'alice', diskSpace: 'space', path: 'folder' }, result: { items: [{ id: 'file' }] } };
    const context = vm.createContext({
        telegramDrivePendingSaveId: id, telegramDrivePendingSaveRunning: false, telegramDriveNavigationVersion: 2,
        window: { DiskClient: { getAccount: () => 'alice', context: () => ({ accountId: 'alice', diskSpace: 'space' }) }, DiskPendingSave: {
            describeTarget: () => 'Alice / folder', resume: async (_id, hooks) => hooks.onCompleted(record)
        } },
        document: { getElementById: () => null },
        pendingSaveTransferId: value => value.id, pendingSaveRead: async () => ({}), choosePendingSaveTarget() {},
        confirmTelegramDriveAction() {}, pendingSaveFeedback() {}, showAppToast() {}, showTelegramDrivePendingSaveBanner: async () => {},
        finishPendingSaveFeedback: () => { cleared++; context.telegramDrivePendingSaveId = ''; }, telegramDriveErrorText: error => error.message,
        revealTelegramDriveUploadedDirectory: async () => { if (failed) throw Error('Failed to fetch'); highlighted++; return true; },
        switchTelegramDriveAccount: async () => { submits++; }, formatFileSize: String, telegramDriveDisplayPath: String
    });
    vm.runInContext(section('async function resumeTelegramDrivePendingSave(', 'function telegramDriveErrorText('), context);
    await assert.rejects(context.resumeTelegramDrivePendingSave(), /Failed to fetch/);
    assert.equal(context.telegramDrivePendingSaveId, id, 'a directory read error must not consume the saved location link');
    assert.equal(cleared, 0);
    failed = false; await context.resumeTelegramDrivePendingSave();
    assert.equal(highlighted, 1); assert.equal(cleared, 1); assert.equal(submits, 0); assert.equal(record.status, 'completed');
});
