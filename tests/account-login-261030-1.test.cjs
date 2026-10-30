'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm');
const ui = fs.readFileSync('client/disk-ui.js', 'utf8');
const turn = () => new Promise(setImmediate);
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const section = (start, end) => ui.slice(ui.indexOf(start), ui.indexOf(end, ui.indexOf(start)));
class Element {
    constructor(tag) { this.tagName = tag; this.children = []; this.attrs = {}; this.isConnected = true; this.classList = { add() {}, remove() {}, toggle() {} }; }
    append(...children) { for (const child of children) { child.parentNode = this; this.children.push(child); } }
    replaceChildren(...children) { this.children = []; this.append(...children); }
    setAttribute(key, value) { this.attrs[key] = value; }
    remove() { this.isConnected = false; if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(node => node !== this); }
    contains(node) { return node === this || this.children.some(child => child.contains(node)); }
    querySelectorAll(selector) { return this.children.flatMap(child => [child, ...child.querySelectorAll(selector)]).filter(node => selector === 'button' ? node.tagName === 'button' : selector === '[aria-pressed]' && node.attrs['aria-pressed'] !== undefined); }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
}
const alice = { identity: { id: 'alice', name: 'Alice' }, expiresAt: Date.now() + 60000 };
const bob = { identity: { id: 'bob', name: 'Bob' }, expiresAt: Date.now() + 60000 };
const status = () => ({ identity: alice.identity, accounts: [alice, bob], oidcConfigured: true, oidcMode: 'mock' });
function fixture({ transport = false } = {}) {
    const body = new Element('body'), calls = [], directory = deferred(), extraStatus = deferred(); let selected = 'alice', loginTarget;
    const document = { body, createElement: tag => new Element(tag), addEventListener() {}, getElementById: () => null };
    const history = { state: {}, pushState(value) { this.state = value; }, replaceState(value) { this.state = value; } };
    const window = { addEventListener() {}, dispatchEvent() {} };
    const context = vm.createContext({ window, document, history, AbortController, setTimeout, clearTimeout, setInterval() {}, URL, URLSearchParams,
        location: { origin: 'http://fixture.test', href: 'http://fixture.test/' },
        fetch: async (route, options) => { calls.push(route); if (options.method === 'POST') return { ok: true, json: async () => ({ identity: bob.identity, accounts: [bob] }) }; return { ok: true, json: () => calls.filter(value => value.includes('/me')).length > 1 ? extraStatus.promise : Promise.resolve(status()) }; },
        telegramDriveLoginTarget: null, telegramDriveOidcPollGeneration: 1, telegramDriveOidcPopup: { closed: false, close() { this.closed = true; } },
        telegramDrivePendingSaveRunning: false, telegramDrivePendingSaveId: '', telegramDriveNavigationVersion: 0, telegramDriveRenderGeneration: 0,
        telegramDriveMountContext: null, telegramDriveCurrentData: null, telegramDriveStaticLinks: [], telegramDriveSpaceOwner: '',
        appendTelegramDriveAddAccount(target) { loginTarget = target; },
        switchTelegramDriveAccount: null, logoutTelegramDrive() {},
        renderTelegramDrive: () => { calls.push('render'); return directory.promise; }, resumeTelegramDriveEntry: async () => false,
        cancelTelegramDrivePendingMount() {}, closeDiskCollaborationFrame() {}, closeDiskPreview() {}, clearTelegramDriveSearch() {}, clearTelegramDriveSelection() {},
        rememberTelegramDriveAccountView() {}, rememberTelegramDriveActiveAccount() {}, historyLog() {}, showAppToast: message => calls.push('toast:' + message), alert: message => calls.push('alert:' + message),
        CustomEvent: class { constructor(type) { this.type = type; } }
    });
    if (transport) vm.runInContext(fs.readFileSync('client/disk-client.js', 'utf8'), context);
    else window.DiskClient = { getAccount: () => selected, setAccount: value => { selected = value; }, setMount() {}, setCollaboration() {},
        accountOperations: async () => ({ accountId: selected, operations: [] }), json: (method, value) => ({ method, body: JSON.stringify(value) }),
        raw: async (route, options = {}) => { calls.push(route); return route === '/accounts/select' ? { identity: bob.identity } : { ...status(), identity: options.accountId === 'bob' ? bob.identity : alice.identity }; } };
    vm.runInContext(fs.readFileSync('client/account-ui.js', 'utf8'), context);
    vm.runInContext(section('async function switchTelegramDriveAccount(', 'async function resumeTelegramDriveEntry(') + section('async function manageTelegramDriveAccounts(', 'async function showTelegramDrivePendingSaveBanner(') + section('async function finishTelegramDriveOidcLogin(', 'async function pollTelegramDriveOidcLogin('), context);
    return { window, body, calls, directory, extraStatus, context, signInTarget: () => loginTarget };
}

test('verified Mock login closes its account dialog before unrelated disk directory reading completes', async () => {
    const f = fixture(); const chosen = f.context.manageTelegramDriveAccounts(); await turn();
    f.context.telegramDriveLoginTarget = f.signInTarget();
    const completing = f.context.finishTelegramDriveOidcLogin('success', '', 'bob'); await turn();
    const closedBeforeDirectory = !f.window.AccountUI.isOpen();
    f.directory.resolve(); await completing; f.window.AccountUI.close(); await chosen;
    assert.equal(closedBeforeDirectory, true, 'authenticated account selection must not wait for the disk directory to close its pending login dialog');
    assert.equal(f.window.DiskClient.getAccount(), 'bob');
});

test('account dialog reuses freshly loaded account metadata instead of waiting behind another network read', async () => {
    const f = fixture({ transport: true }); await f.window.DiskClient.raw('/me');
    const chosen = f.context.manageTelegramDriveAccounts(); await turn();
    const visible = f.body.querySelectorAll('button').some(node => node.textContent === 'Bob');
    const reads = f.calls.filter(route => route.includes('/me')).length;
    f.extraStatus.resolve(status()); await turn(); f.window.AccountUI.close(); await chosen;
    assert.equal(visible, true, 'fresh server account metadata should already be visible while connections are busy');
    assert.equal(reads, 1, 'fresh metadata needs no duplicate account read');
});

test('account mutations invalidate earlier account metadata before opening the next dialog', async () => {
    const f = fixture({ transport: true }); await f.window.DiskClient.raw('/me');
    await f.window.DiskClient.raw('/accounts/select', { accountId: '', method: 'POST', body: JSON.stringify({ accountId: 'bob' }) });
    const chosen = f.context.manageTelegramDriveAccounts(); await turn();
    assert.equal(f.body.querySelectorAll('button').some(node => node.textContent === 'Alice'), false);
    f.extraStatus.resolve({ ...status(), accounts: [bob], identity: bob.identity }); await turn();
    assert.equal(f.body.querySelectorAll('button').some(node => node.textContent === 'Bob'), true);
    f.window.AccountUI.close(); await chosen;
});

test('expired display metadata is fetched again and cannot indefinitely retain an earlier login', async () => {
    const f = fixture({ transport: true }); await f.window.DiskClient.raw('/me');
    const now = Date.now(); f.context.Date = { now: () => now + 16000 };
    const chosen = f.context.manageTelegramDriveAccounts(); await turn();
    assert.equal(f.calls.filter(route => route.includes('/me')).length, 2);
    assert.equal(f.body.querySelectorAll('button').some(node => node.textContent === 'Alice'), false);
    f.extraStatus.resolve({ ...status(), identity: null, accounts: [] }); await turn(); f.window.AccountUI.close(); await chosen;
});

test('a disk refresh failure after authentication closes the login and reports the committed account separately', async () => {
    const f = fixture(); const chosen = f.context.manageTelegramDriveAccounts(); await turn();
    f.context.telegramDriveLoginTarget = f.signInTarget();
    f.context.renderTelegramDrive = async () => { throw Error('DIRECTORY_READ_FAILED'); };
    await f.context.finishTelegramDriveOidcLogin('success', '', 'bob'); await turn(); await chosen;
    assert.equal(f.window.AccountUI.isOpen(), false); assert.equal(f.window.DiskClient.getAccount(), 'bob');
    assert.ok(f.calls.some(message => message.startsWith('toast:') && message.includes('账号已切换') && message.includes('DIRECTORY_READ_FAILED')));
});
