'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { createDiskOidcReceipt } = require('../server/disk-oidc-receipt');
const { createFixture } = require('./support/disk-oidc-261012-fixture.cjs');
const ui = fs.readFileSync(path.join(__dirname, '../client/disk-ui.js'), 'utf8');

test('Mock reauthentication carries the clicked account ID as a prefill without submitting it', async t => {
    const f = await createFixture(); t.after(() => f.close());
    const start = await f.call('/api/telegram/drive/oidc/start?attempt=retry-mock-999000001&account_hint=999000001', { redirect: 'manual' }); assert.equal(start.status, 302);
    const destination = new URL(start.headers.get('location')); const page = await f.call(destination.pathname + destination.search); const html = await page.text();
    assert.match(html, /name="telegramUserId"[^>]*value="999000001"/); assert.equal((await (await f.call('/api/telegram/drive/me')).json()).identity, null);
});

test('真实 Mock OIDC 重复登录同一账号：会话不轮换，有本次完成回执且不新增账号', async t => {
    const f = await createFixture(); t.after(() => f.close());
    await f.login('attempt-first-999000002');
    const first = await (await f.call('/api/telegram/drive/me?oidc_attempt=attempt-first-999000002')).json();
    const credential = f.cookies.get('drop2tunnel_telegram_drive');
    const html = await f.login('attempt-second-999000002');
    const second = await (await f.call('/api/telegram/drive/me?oidc_attempt=attempt-second-999000002')).json();
    assert.equal(second.identity.id, 'fixture-999000002'); assert.equal(second.accounts.length, 1);
    assert.equal(second.accounts[0].expiresAt, first.accounts[0].expiresAt);
    assert.equal(f.cookies.get('drop2tunnel_telegram_drive'), credential, '在途 Content proof 的会话不能因重复登录轮换');
    assert.equal(second.loginAttempt.result, 'success'); assert.equal(second.loginAttempt.attemptId, 'attempt-second-999000002');
    assert.equal(second.loginAttempt.accountId, second.identity.id); assert.ok(html.includes('attempt-second-999000002'));
    assert.equal((await (await f.call('/api/telegram/drive/me?oidc_attempt=attempt-first-999000002')).json()).loginAttempt, null);
    await f.login('attempt-another-999000001', '999000001');
    assert.equal((await (await f.call('/api/telegram/drive/me')).json()).accounts.length, 2);
    const selected = await f.call('/api/telegram/drive/accounts/select', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ accountId: 'fixture-999000002' }) });
    assert.equal(selected.status, 200); assert.equal((await selected.json()).identity.id, 'fixture-999000002');
    assert.equal((await (await f.call('/api/telegram/drive/me')).json()).accounts.length, 2);
});

test('回执拒绝错误签名、过期、其它尝试及多字节伪造；无状态验证不会生成成功回执', async t => {
    let now = 1000; const receipts = createDiskOidcReceipt({ keyForRequest: () => 'fixture', now: () => now });
    let cookie;
    receipts.record({ headers: {} }, { append: (_key, value) => { cookie = value.split(';')[0]; } }, { attemptId: 'signed-attempt-001', result: 'success', accountId: 'account' });
    const req = { headers: { cookie } }; assert.equal(receipts.get(req, 'signed-attempt-001').accountId, 'account');
    assert.equal(receipts.get(req, 'signed-attempt-002'), null);
    assert.equal(receipts.get({ headers: { cookie: cookie.slice(0, -43) + '好'.repeat(43) } }, 'signed-attempt-001'), null);
    assert.equal(receipts.get({ headers: { cookie: cookie + '.extra' } }, 'signed-attempt-001'), null);
    now += 600001; assert.equal(receipts.get(req, 'signed-attempt-001'), null);
    const f = await createFixture(); t.after(() => f.close());
    await f.login('attempt-good-existing');
    const bad = await f.call('/api/telegram/drive/oidc/callback?state=unknown&mock_user_id=999000002'); await bad.text();
    assert.equal((await (await f.call('/api/telegram/drive/me?oidc_attempt=attempt-bad-unknown')).json()).loginAttempt, null);
});

function loginUI(raw) {
    const errors = [], successes = [], selected = [], timers = [], popup = { closed: false, close() { this.closed = true; }, focus() {} };
    const context = vm.createContext({ window: { location: { origin: 'https://fixture.test' }, DiskClient: { raw } },
        document: { querySelector: () => null }, telegramDriveOidcPopup: popup, telegramDriveOidcPollGeneration: 1,
        telegramDriveLoginAttempt: 'current-attempt-001', telegramDriveLoginTarget: null, telegramDriveLoginBaseline: [{ id: 'account', expiresAt: 500 }], telegramDrivePendingSaveId: '',
        switchTelegramDriveAccount: async id => selected.push(id), renderTelegramDrive: async () => {},
        showAppToast: message => successes.push(message), alert: message => errors.push(message), historyLog() {},
        setTimeout: (callback, delay) => { timers.push({ callback, delay }); }, Date, encodeURIComponent });
    const start = ui.indexOf('async function finishTelegramDriveOidcLogin('), end = ui.indexOf('\nlet diskExporter', start);
    vm.runInContext(ui.slice(start, end), context);
    return { context, popup, errors, successes, selected, timers, poll: () => context.pollTelegramDriveOidcLogin(popup, 1, Date.now()) };
}
const status = receipt => ({ identity: { id: 'account' }, accounts: [{ identity: { id: 'account' }, expiresAt: 500, reauthRequired: false }], oidcMode: 'mock', ...(receipt ? { loginAttempt: receipt } : {}) });

test('同账号与有效期不变且 opener 通知缺失时，匹配的完成回执仍能结束登录', async () => {
    const f = loginUI(async () => status({ attemptId: 'current-attempt-001', result: 'success', accountId: 'account' }));
    f.popup.closed = true; await f.poll();
    assert.deepEqual(f.selected, ['account']); assert.equal(f.successes.length, 1); assert.equal(f.errors.length, 0);
});
test('已有登录不能当作此次成功：手动关窗复查一次后正确报告未完成', async () => {
    let reads = 0; const f = loginUI(async () => { reads++; return status(); }); f.popup.closed = true;
    await f.poll(); assert.equal(f.timers[0].delay, 250); assert.equal(f.errors.length, 0);
    await f.timers.shift().callback(); await new Promise(resolve => setImmediate(resolve));
    assert.equal(reads, 2); assert.equal(f.successes.length, 0); assert.match(f.errors[0], /登录窗口已关闭/);
});
test('已有登录与其它窗口的账号变化都不代替本次授权完成', async () => {
    const f = loginUI(async () => status()); f.context.telegramDriveLoginBaseline = [];
    await f.poll(); assert.equal(f.successes.length, 0); assert.equal(f.timers[0].delay, 2000);
    const another = loginUI(async () => ({ identity: { id: 'other' }, accounts: [{ identity: { id: 'other' }, expiresAt: 1000 }] }));
    await another.poll(); assert.equal(another.successes.length, 0); assert.equal(another.timers[0].delay, 2000);
});
test('轮询收到旧响应时，成功通知和取消都不会被迟到响应覆盖', async () => {
    for (const cancel of [false, true]) {
        let release; const f = loginUI(route => route.includes('oidc_attempt') ? new Promise(resolve => { release = resolve; }) : Promise.resolve(status()));
        const waiting = f.poll();
        if (cancel) { f.context.telegramDriveOidcPollGeneration++; f.popup.close(); f.context.telegramDriveOidcPopup = null; }
        else f.context.handleTelegramDriveOidcPopupMessage({ origin: 'https://fixture.test', source: f.popup,
            data: { type: 'telegram-drive-oidc-result', result: 'success', attemptId: 'current-attempt-001', accountId: 'account' } });
        release(status()); await waiting; await new Promise(resolve => setImmediate(resolve));
        assert.equal(f.errors.length, 0); assert.equal(f.successes.length, cancel ? 0 : 1); assert.equal(f.timers.length, 0);
    }
});
test('旧回执与旧窗口消息不确认本次登录，成功完成仍需有效凭据', async () => {
    const f = loginUI(async () => status({ attemptId: 'old-attempt-0001', result: 'success', accountId: 'account' }));
    f.context.handleTelegramDriveOidcPopupMessage({ origin: 'https://fixture.test', source: f.popup, data: { type: 'telegram-drive-oidc-result', result: 'success', attemptId: 'old-attempt-0001' } });
    await f.poll(); assert.equal(f.successes.length, 0); assert.equal(f.timers[0].delay, 2000);
    const expired = loginUI(async () => ({ identity: null }));
    await assert.rejects(expired.context.finishTelegramDriveOidcLogin('success'), /凭据尚未确认/); assert.equal(expired.successes.length, 0);
});

test('转存候选账号鼠标按下即选中，无额外请求；触摸滚动、键盘确认及失效账号保持正确', async () => {
    class Node {
        constructor() { this.children = []; this.attrs = {}; this.events = {}; const values = new Set(); this.classList = { toggle: (name, enabled) => enabled ? values.add(name) : values.delete(name), contains: name => values.has(name) }; }
        append(...nodes) { this.children.push(...nodes); } setAttribute(name, value) { this.attrs[name] = value; }
        replaceChildren(...nodes) { this.children = nodes; } contains(node) { return this.children.includes(node); }
        addEventListener(name, callback) { this.events[name] = callback; }
        querySelectorAll() { return this.children.flatMap(row => row.children).filter(node => node.className?.includes('disk-account-entry')); }
    }
    const calls = [], switches = [], toasts = [], body = new Node(), dialog = { hidden: true }; let options, resolve;
    const accounts = ['alice', 'bob', 'expired'].map(id => ({ identity: { id }, reauthRequired: id === 'expired' }));
    const context = vm.createContext({ window: { DiskClient: { raw: async route => { calls.push(route); return { accounts, identity: { id: 'alice' } }; }, getAccount: () => 'alice' } },
        document: { createElement: () => new Node(), getElementById: id => id === 'telegramDriveDialogBody' ? body : dialog }, AbortController,
        telegramDriveAccountList: [], appendTelegramDriveAddAccount() {},
        switchTelegramDriveAccount: async id => switches.push(id), showAppToast: message => toasts.push(message),
        openTelegramDriveDialog: value => { options = value; body.append(value.body); dialog.hidden = false; return new Promise(done => { resolve = done; }); } });
    vm.runInContext(ui.slice(ui.indexOf('async function manageTelegramDriveAccounts('), ui.indexOf('async function showTelegramDrivePendingSaveBanner(')), context);
    const pending = context.manageTelegramDriveAccounts({ choose: true });
    assert.equal(dialog.hidden, false); assert.equal(options.body.textContent, '正在读取账号状态…');
    await new Promise(setImmediate);
            const [alice, bob, expired] = options.body.querySelectorAll(); assert.equal(calls.length, 2);
            bob.events.pointerdown({ pointerType: 'touch', button: 0 }); assert.equal(alice.classList.contains('selected'), true);
            bob.events.pointerdown({ pointerType: 'mouse', button: 0 }); assert.equal(bob.classList.contains('selected'), true);
            assert.equal(bob.attrs['aria-pressed'], 'true'); assert.equal(alice.classList.contains('selected'), false); assert.equal(calls.length, 2);
            expired.events.pointerdown({ pointerType: 'mouse', button: 0 }); await expired.onclick(); assert.equal(bob.classList.contains('selected'), true);
            await alice.onclick(); assert.equal(alice.attrs['aria-pressed'], 'true'); await bob.onclick();
            assert.equal(calls.length, 2); assert.equal(switches.length, 0); resolve(options.validate());
    await pending; assert.deepEqual(switches, ['bob']); assert.equal(toasts.length, 1);
    assert.match(fs.readFileSync(path.join(__dirname, '../client/disk.css'), 'utf8'), /\.disk-account-list \.disk-account-entry\{[^}]*transition:none/);
});

test('账号浮层先于慢接口显示；关闭后迟到响应不更新列表或打开新浮层', async () => {
    let complete, close, opened=0; const answer=new Promise(done=>{complete=done;}),calls=[];
    const body={nodes:[],contains(node){return this.nodes.includes(node);}},dialog={hidden:true};
    const context=vm.createContext({AbortController,telegramDriveAccountList:[],
        window:{DiskClient:{getAccount:()=> 'alice',raw:(route,options)=>{calls.push({route,options});return answer;}}},
        document:{getElementById:id=>id==='telegramDriveDialogBody'?body:dialog,createElement:()=>({setAttribute(){}})},
        openTelegramDriveDialog:options=>{opened++;dialog.hidden=false;body.nodes=[options.body];return new Promise(done=>{close=done;});},
        telegramDriveErrorText:error=>error.message});
    vm.runInContext(ui.slice(ui.indexOf('async function manageTelegramDriveAccounts('),ui.indexOf('async function showTelegramDrivePendingSaveBanner(')),context);
    const pending=context.manageTelegramDriveAccounts();assert.equal(opened,1);assert.equal(dialog.hidden,false);assert.equal(calls.length,2);
    dialog.hidden=true;close(null);await pending;assert.ok(calls.every(call=>call.options.signal.aborted));
    complete({accounts:[{identity:{id:'late'}}]});await new Promise(setImmediate);assert.equal(context.telegramDriveAccountList.length,0);assert.equal(opened,1);
});
