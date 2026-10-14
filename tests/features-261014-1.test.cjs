'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm'), os = require('node:os'), path = require('node:path');
const { createAdminAuth } = require('../server/admin-auth');
const source = name => fs.readFileSync(name, 'utf8'), tick = () => new Promise(setImmediate);
class Element {
    constructor(tag = 'div') { this.tagName = tag.toUpperCase(); this.children = []; this.dataset = {}; this.listeners = {}; this.value = ''; this.style = {};
        this.classList = { add() {}, remove() {}, toggle() {} }; }
    append(...nodes) { this.children.push(...nodes); for (const node of nodes) if (node && typeof node === 'object') node.parentElement = this; }
    appendChild(node) { this.append(node); } add(node) { this.append(node); if (this.children.length === 1) this.value = node.value; }
    replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
    setAttribute(key, value) { this[key] = value; } removeAttribute(key) { delete this[key]; }
    addEventListener(key, fn) { (this.listeners[key] ||= []).push(fn); }
    querySelectorAll(selector) { return this.children.flatMap(node => typeof node === 'object' ? [...(selector === '[data-folder-path]' && node.dataset?.folderPath !== undefined ? [node] : []), ...(node.querySelectorAll?.(selector) || [])] : []); }
    querySelector() { return null; } focus() {} select() {}
}
const options = { Option: class extends Element { constructor(name, value) { super('option'); this.textContent = name; this.value = value; } } };

test('new administrator tokens and cookies last 30 days; expiry, marker revocation and signature checks remain enforced', t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dr2t-admin-261014-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const marker = path.join(dir, '.gauth-admin.json'); fs.writeFileSync(marker, JSON.stringify({ secret: 'JBSWY3DPEHPK3PXP', createdAt: 'fixture' }));
    const auth = createAdminAuth({ dataDir: dir }), token = auth.createSession(), payload = JSON.parse(Buffer.from(token.split('.')[0], 'base64url'));
    assert.ok(Math.abs(payload.exp - payload.iat - 30 * 86400000) < 5);
    assert.match(auth.cookieHeader({ secure: true, headers: {} }, token), /HttpOnly; SameSite=Strict; Max-Age=2592000; Secure$/);
    const authenticated = value => auth.isAuthenticated({ headers: { cookie: 'tunnel_admin_session=' + value } });
    t.mock.method(Date, 'now', () => payload.iat + 29 * 86400000); assert.equal(authenticated(token), true);
    t.mock.method(Date, 'now', () => payload.exp); assert.equal(authenticated(token), false);
    t.mock.method(Date, 'now', () => payload.iat); assert.equal(authenticated(token + 'x'), false);
    fs.writeFileSync(marker, JSON.stringify({ secret: 'JBSWY3DPEHPK3PXP', createdAt: 'changed' })); assert.equal(authenticated(token), false);
});

function landingAndDisk(search) {
    let url = new URL('http://localhost/disk' + search), account = 'old-account', space = 'old-space';
    const elements = new Map(), body = new Element('body'), calls = [], memory = new Map([['telegram-drive-window', JSON.stringify({ retained: true, path: '上次位置' })]]);
    const get = id => { if (!elements.has(id)) { const node = new Element(); node.parentElement = body; elements.set(id, node); } return elements.get(id); };
    const location = { get href() { return url.href; }, get search() { return url.search; }, get pathname() { return url.pathname; }, get hash() { return url.hash; }, origin: url.origin };
    const client = { setAccount(id) { account = id; }, getAccount: () => account, getSpace: () => space, setSpace(id) { space = id; },
        raw: async (route, context) => { calls.push({ route, context }); return { id: 'saved-file', folderPath: 'video-collection' }; } };
    const context = vm.createContext({ ...options, window: { location, DiskClient: client, addEventListener() {}, matchMedia: () => ({ matches: false }) }, location,
        history: { state: {}, replaceState(_a, _b, value) { url = new URL(value, url); } },
        document: { body, addEventListener() {}, getElementById: get, createElement: tag => new Element(tag), querySelectorAll: () => [], querySelector: () => null },
        localStorage: { getItem: key => memory.get(key) ?? null, setItem: (key, value) => memory.set(key, value) }, URL, URLSearchParams, setTimeout, clearTimeout, requestAnimationFrame: fn => fn(),
        state: {}, readSessionDirectoryCache: () => [], getAllFromStore: async () => [], replaceSessionDirectoryCache: () => [], historyLog() {}, alert: message => { throw Error(message); } });
    const app = source('app.js'); vm.runInContext(app.slice(app.indexOf('function initSessionLanding()'), app.indexOf('\nfunction openSession(')), context);
    context.initSessionLanding(); // Execute the real shell initialization, not just DiskUI in isolation.
    const hook = `
        initDiskEnhancements=()=>{};initDiskBreadcrumbScroll=()=>{};saveDiskWindow=()=>{};
        openTelegramDrive=async()=>{window.calls.push({openPath:telegramDrivePath});telegramDriveSpaceOwner=window.DiskClient.getAccount();
            history.replaceState(null,'','/disk?disk_account='+telegramDriveSpaceOwner);};
        switchTelegramDrivePartition=async value=>{window.calls.push({space:value});window.DiskClient.setSpace(value);};
        navigateTelegramDrive=async value=>{window.calls.push({path:value});telegramDrivePath=value;};
        navigateTelegramDriveInputPath=async value=>{window.calls.push({inputPath:value});};
        highlightTelegramDriveRow=item=>window.calls.push({highlight:item.id});
    `;
    context.window.calls = calls;
    vm.runInContext(source('client/disk-ui.js').replace('window.DiskUI = {', hook + '\nwindow.DiskUI = {'), context);
    context.window.DiskUI.init(); return { calls, client };
}
test('real tunnel landing preserves explicit disk account/partition/file parameters; later history rewrites cannot discard the destination', async () => {
    const f = landingAndDisk('?disk_account=collection-owner&disk_space=&disk_path=obsolete&disk_file=saved-file'); await tick();
    assert.equal(f.client.getAccount(), 'collection-owner'); assert.equal(f.client.getSpace(), '');
    assert.ok(f.calls.some(c => c.route === '/files/saved-file')); assert.ok(f.calls.some(c => c.path === 'video-collection'));
    assert.ok(f.calls.some(c => c.highlight === 'saved-file'));
});
test('bare /disk keeps the retained directory; an explicit disk_path is honored even without disk_file', async () => {
    const bare = landingAndDisk(''); await tick(); assert.equal(bare.calls[0].openPath, '上次位置'); assert.equal(bare.calls.some(c => c.path || c.inputPath), false);
    const explicit = landingAndDisk('?disk_account=alice&disk_space=中文分区&disk_path=资料'); await tick();
    assert.equal(explicit.client.getAccount(), 'alice'); assert.equal(explicit.client.getSpace(), '中文分区'); assert.ok(explicit.calls.some(c => c.inputPath === '资料'));
});

test('tunnel save picker switches native partitions, creates a nested target and returns an immutable transport instead of the active mount', async () => {
    const calls = [], directories = new Map([['', ['原目录']], ['target', ['目标']]]), memory = new Map(); let created;
    const client = { getAccount: () => 'alice', getSpace: () => '', json: (method, body) => ({ method, body: JSON.stringify(body) }),
        raw: async (route, opts) => {
            calls.push({ route, opts }); assert.equal(opts.accountId, 'alice'); assert.equal(opts.requestBase, '/api/telegram/drive');
            if (route === '/spaces') return { spaces: [{ id: 'default', scopeKey: '', name: '默认分区' }, { id: 'second', scopeKey: 'target', name: '目标分区' }] };
            if (opts.method === 'POST') { const path = JSON.parse(opts.body).path; directories.get(opts.diskSpace).push(path); return { path }; }
            return { directories: directories.get(opts.diskSpace).map(path => ({ path, name: path.split('/').at(-1) })) };
        } };
    const window = { DiskClient: client }, context = vm.createContext({ ...options, window, document: { createElement: tag => new Element(tag), createTextNode: text => text },
        localStorage: { getItem: key => memory.get(key) ?? null, setItem: (key, value) => memory.set(key, value) },
        prepareTelegramDrivePicker() {}, installContextGesture() {}, telegramDriveMountContext: { mount: {} }, telegramDrivePath: '远端目录',
        telegramDriveErrorText: e => e.message, alert: message => { throw Error(message); },
        openTelegramDriveDialog: async opts => {
            const picker = opts.body[0].children[0]; assert.equal(picker.value, 'default'); picker.value = 'second'; await picker.onchange();
            const path = opts.body.find(node => node.tagName === 'INPUT'); path.value = '/目标/子';
            await opts.body.find(node => node.textContent === '创建多级目录并选中').onclick();
            return opts.validate();
        } });
    vm.runInContext(source('client/disk-directory-picker.js'), context);
    const ui = source('client/disk-ui.js'); vm.runInContext(ui.slice(ui.indexOf('async function chooseTelegramDriveSaveDestination('), ui.indexOf('\nasync function moveTelegramDriveItems(')), context);
    const target = await context.chooseTelegramDriveSaveDestination({ userId: 'alice', onCreateDirectory: (path, actor) => { created = { path, actor }; } });
    assert.equal(target.path, '目标/子'); assert.equal(target.transportContext.diskSpace, 'target'); assert.equal(created.actor.diskSpace, 'target');
    assert.equal(memory.get('telegramDriveSaveDirectory:alice:second'), '目标/子');
    const uploads = []; window.DiskUI = { setExporter() {}, chooseSaveDestination: async () => target, navigationVersion: 0 };
    client.context = () => ({ accountId: 'bob', requestBase: '/api/telegram/drive/mount-scope/foreign', diskSpace: 'other' });
    client.raw = async () => ({ identity: { id: 'alice' } }); client.upload = async (...args) => { uploads.push(args); return { items: [] }; };
    vm.runInContext(source('client/disk-tunnel-adapter.js'), context);
    window.DiskTunnelAdapter.configure({ filesForRecord: () => [{ id: 'local', name: 'a.txt' }], readFile: () => {} });
    await window.DiskTunnelAdapter.save({ id: 'record' }); assert.equal(uploads[0][1], '目标/子'); assert.equal(uploads[0][3].transportContext.accountId, 'alice');
    assert.equal(uploads[0][3].transportContext.diskSpace, 'target'); assert.equal(uploads[0][3].transportContext.requestBase, '/api/telegram/drive');
});
