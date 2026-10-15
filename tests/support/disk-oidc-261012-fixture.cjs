'use strict';
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), crypto = require('node:crypto');
const express = require('express');
const { createDiskAccountSessions } = require('../../server/disk-account-sessions');
const { createDiskOidcReceipt } = require('../../server/disk-oidc-receipt');
const { createTelegramOidcMock } = require('../../server/telegram-oidc-mock');

// Run the production OIDC route definitions with real HTTP, mock authorization
// and signed account cookies, without booting a service on the user's data.
async function createFixture() {
    const app = express(), key = crypto.randomBytes(32), users = new Map();
    const sessions = createDiskAccountSessions({ keyForRequest: () => key, user: id => users.get(id) });
    const receipt = createDiskOidcReceipt({ keyForRequest: () => key });
    const flows = new Map();
    const source = fs.readFileSync(path.join(__dirname, '../../server.js'), 'utf8');
    const popup = source.slice(source.indexOf('function sendTelegramOidcPopupCompletion('), source.indexOf("app.get('/api/telegram/drive/oidc/start'"));
    const routes = source.slice(source.indexOf("app.get('/api/telegram/drive/oidc/start'"), source.indexOf("app.post('/api/telegram/drive/logout'"));
    const me = source.slice(source.indexOf("app.get('/api/telegram/drive/me',"), source.indexOf("const { createS3Gateway }"));
    const publicOrigin = req => req.protocol + '://' + req.get('host');
    vm.runInNewContext(popup + routes + me, { app, express, crypto, Date, URL,
        console: { warn() {}, info() {} }, sanitizeString: (value, limit) => String(value).slice(0, limit),
        serializeTelegramOidcInlineValue: value => JSON.stringify(value).replace(/</g, '\\u003c'),
        setTelegramOidcNoStore: res => res.set('Cache-Control', 'no-store'), loadTelegramBotConfig: () => ({}),
        isTelegramOidcMockRequest: () => true, isTelegramOidcConfigured: () => false,
        getTelegramPublicOrigin: publicOrigin, getTelegramOidcRedirectUri: req => publicOrigin(req) + '/api/telegram/drive/oidc/callback',
        telegramOidcMock: createTelegramOidcMock({ enabled: true, defaultUserId: '999000002' }), telegramOidcFlows: flows,
        TELEGRAM_OIDC_FLOW_TTL_MS: 600000, TELEGRAM_DRIVE_OIDC_STATE_COOKIE: 'fixture_oidc_state',
        cleanTelegramOidcFlows: () => { for (const [id, flow] of flows) if (flow.expiresAt < Date.now()) flows.delete(id); },
        isSecurePublicRequest: () => false,
        getRequestCookie: (req, name) => (req.headers.cookie || '').split(';').map(part => part.trim()).find(part => part.startsWith(name + '='))?.slice(name.length + 1) || '',
        constantTimeStringEqual: (a, b) => a === b,
        clearTelegramOidcStateCookie: (_req, res) => res.clearCookie('fixture_oidc_state', { path: '/api/telegram/drive/oidc' }),
        setTelegramDriveIdentityCookie(req, res, identity) {
            const user = { ...identity, id: 'fixture-' + identity.id }; users.set(user.id, user); sessions.set(req, res, user);
        }, diskOidcReceipt: receipt, diskAccountSessions: sessions, getTelegramDriveIdentity: req => sessions.identity(req),
        diskAPI: { metadataTiming: (_req, _res, next) => next() }, isTelegramBotEnabled: () => true,
        getTelegramDriveActiveChannel: () => '-1001', getTelegramOidcLoginMode: () => 'mock', getTelegramDriveUploadLimit: () => 20000000 });
    app.use(express.json());
    sessions.registerRoutes(app, { origin: publicOrigin });
    app.use('/client', express.static(path.join(__dirname, '../../client')));
    app.get('/fixture-seed', (req, res) => {
        for (const id of ['999000001', '999000002']) {
            const user = { id: 'fixture-' + id, name: 'Mock 用户 ' + id }; users.set(user.id, user); sessions.set(req, res, user);
        }
        res.redirect('/fixture-accounts');
    });
    app.get('/fixture-accounts', (_req, res) => {
        const ui = fs.readFileSync(path.join(__dirname, '../../client/disk-ui.js'), 'utf8');
        const choose = ui.slice(ui.indexOf('async function manageTelegramDriveAccounts('), ui.indexOf('async function showTelegramDrivePendingSaveBanner('));
        const page = fs.readFileSync(path.join(__dirname, '../../pages/index.html'), 'utf8');
        const style = [...page.matchAll(/<style\b[^>]*>[\s\S]*?<\/style>|<link\b[^>]*\brel=["']stylesheet["'][^>]*>/gi)].map(match => match[0]).join('\n');
        res.type('html').send(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">${style}</head>
<body><main style="padding:32px"><h1>账号选择隔离验收</h1><p>实际选择函数与样式；仅使用测试账号。</p><button id="choose" class="btn">选择转存目标账号</button><output id="http">HTTP 请求：0</output><p id="result"></p></main>
<div id="dialog" class="telegram-drive-subdialog" hidden><section class="telegram-drive-dialog-card"><header class="telegram-drive-dialog-header"><strong id="title"></strong></header><div id="body" class="telegram-drive-dialog-body"></div><footer id="actions" class="telegram-drive-dialog-actions"></footer></section></div>
<script>let account='fixture-999000002',telegramDriveAccountList=[],resolver,requests=0;
window.DiskClient={getAccount:()=>account,raw:async(route,options={})=>{document.getElementById('http').textContent='HTTP 请求：'+(++requests);const response=await fetch('/api/telegram/drive'+route,{...options,headers:{...options.headers}});const data=await response.json();if(!response.ok)throw Error(data.error);return data;}};
function appendTelegramDriveAddAccount(){}function showAppToast(message){document.getElementById('result').textContent=message;}function telegramDriveErrorText(error){return error.message;}
async function switchTelegramDriveAccount(id){await DiskClient.raw('/accounts/select',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({accountId:id})});account=id;showAppToast('已确认目标账号：'+id);}
function closeTelegramDriveDialog(result){document.getElementById('dialog').hidden=true;resolver?.(result);}function openTelegramDriveDialog(options){document.getElementById('title').textContent=options.title;document.getElementById('body').replaceChildren(options.body);const yes=document.createElement('button');yes.className='btn btn-primary';yes.textContent=options.confirmText;yes.onclick=()=>closeTelegramDriveDialog(options.validate());const no=document.createElement('button');no.className='btn';no.textContent=options.cancelText;no.onclick=()=>closeTelegramDriveDialog(null);document.getElementById('actions').replaceChildren(no,yes);document.getElementById('dialog').hidden=false;return new Promise(resolve=>resolver=resolve);}
${choose}
document.getElementById('choose').onclick=()=>manageTelegramDriveAccounts({choose:true}).catch(error=>showAppToast(error.message));</script></body></html>`);
    });
    const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
    const cookies = new Map(), base = 'http://127.0.0.1:' + server.address().port;
    async function call(route, options = {}) {
        const response = await fetch(base + route, { ...options, redirect: 'manual', headers: { Cookie: [...cookies].map(([name, value]) => name + '=' + value).join('; '), ...options.headers } });
        for (const line of response.headers.getSetCookie()) {
            const [pair] = line.split(';'), at = pair.indexOf('=');
            if (/Max-Age=0\b/.test(line)) cookies.delete(pair.slice(0, at)); else cookies.set(pair.slice(0, at), pair.slice(at + 1));
        }
        return response;
    }
    async function login(attempt, id = '999000002') {
        const start = await call('/api/telegram/drive/oidc/start?attempt=' + attempt);
        const location = new URL(start.headers.get('location'), base);
        const page = await call(location.pathname + location.search); await page.text();
        const authorized = await call('/api/telegram/drive/oidc/mock/authorize', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ state: location.searchParams.get('state'), telegramUserId: id }).toString() });
        return (await call(authorized.headers.get('location'))).text();
    }
    return { app, sessions, receipt, cookies, base, call, login,
        async close() { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } };
}
module.exports = { createFixture };
