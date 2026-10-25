'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../client/disk-ui.js'), 'utf8');
const loginSource = source.slice(source.indexOf('async function finishTelegramDriveOidcLogin('), source.indexOf('async function pollTelegramDriveOidcLogin('));
function fixture({ identityFailure = false, switched = false } = {}) {
    const calls = [], target = {}, popup = { closed:false, close() { this.closed=true; calls.push('popup-closed'); } };
    let selected='999000001';
    const context = { telegramDriveLoginTarget:target, telegramDriveOidcPollGeneration:2, telegramDriveOidcPopup:popup,
        telegramDrivePendingSaveRunning:false, telegramDrivePendingSaveId:'',
        window:{ DiskClient:{ getAccount:() => selected, raw:async () => { if (identityFailure) throw Error('NETWORK_ERROR'); return {identity:{id:'999000002'}}; } },
            AccountUI:{ isOpen:() => true, refresh:() => calls.push('refresh-account-list'), completeSignIn:() => calls.push('close-account-panel') } },
        switchTelegramDriveAccount:async () => { calls.push('switch'); if(switched)selected='999000002'; throw Error('COLLABORATION_TARGET_NOT_FOUND'); },
        renderTelegramDrive:async () => calls.push('render'), showAppToast:message => calls.push('toast:'+message),
        historyLog(){}, alert:message => calls.push('alert:'+message), resumeTelegramDrivePendingSave:async () => calls.push('resume') };
    vm.createContext(context); vm.runInContext(loginSource, context);
    return {calls,context,popup,run:() => context.finishTelegramDriveOidcLogin('success','','999000002')};
}
test('an authenticated popup whose account switch fails restores the account panel instead of leaving the independent-window message', async () => {
    const f=fixture(); assert.equal(await f.run(), false);
    assert.equal(f.popup.closed,true); assert.equal(f.context.telegramDriveOidcPopup,null);
    assert.ok(f.calls.includes('refresh-account-list')); assert.equal(f.calls.includes('close-account-panel'),false);
    assert.ok(f.calls.some(value => value.startsWith('alert:') && value.includes('切换') && value.includes('COLLABORATION_TARGET_NOT_FOUND')));
    assert.equal(f.calls.some(value => value.startsWith('toast:')),false);
});
test('an unreadable login receipt resets the pending login UI and reports verification failure without claiming authentication succeeded', async () => {
    const f=fixture({identityFailure:true}); assert.equal(await f.run(),false);
    assert.ok(f.calls.includes('refresh-account-list')); assert.equal(f.calls.includes('switch'),false);
    assert.ok(f.calls.some(value => value.startsWith('alert:') && value.includes('NETWORK_ERROR')));
    assert.equal(f.calls.includes('close-account-panel'),false);
});
test('a committed switch followed by a render failure reports the actual selected account state',async () => {
    const f=fixture({switched:true});assert.equal(await f.run(),false);
    assert.equal(f.context.window.DiskClient.getAccount(),'999000002');
    assert.ok(f.calls.some(value=>value.startsWith('alert:')&&value.includes('已切换')&&value.includes('刷新')));
});
