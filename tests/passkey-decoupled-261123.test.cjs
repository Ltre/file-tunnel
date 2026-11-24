'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { createPasskeyAuth } = require('../server/passkey-auth');
const { installPasskeyRoutes, installPasskeyAuthenticationRoutes, installPasskeyAdminRoutes } = require('../server/passkey-routes');
const authenticator = require('./support/passkey-authenticator.cjs');

function fixture() {
    const users = [];
    let saves = 0, origins = ['https://a.test', 'https://b.test'];
    const auth = createPasskeyAuth({
        accounts: {
            list: () => users,
            add: user => users.push(user),
            save: () => saves++,
            publicUser: user => ({ id: user.id, username: user.username, name: user.name }),
            hasAlternativeAuthentication: user => user.recoveryEnabled === true
        },
        originSettings: {
            get: () => ({ origins }),
            save: value => ({ origins: origins = value.origins })
        }
    });
    return { auth, users, saves: () => saves };
}
async function register(auth, key, extra = {}) {
    const flow = await auth.passkeyOptions({ kind: 'register', username: 'alice', origin: 'https://b.test', binding: 'browser', ...extra });
    return auth.passkeyVerify({ flowId: flow.flow_id, binding: 'browser', existingUserId: extra.existingUserId || '', response: key.register(flow, extra.origin || 'https://b.test') });
}

test('通用 Passkey 服务脱离网盘存储运行，保留同账号跨 RP 凭据、真实验签和单次交接', async () => {
    const { auth, users, saves } = fixture(), b = authenticator('b.test'), a = authenticator('a.test');
    const user = await register(auth, b);
    users[0].productData = { retained: 'independent business data' };
    await register(auth, a, { origin: 'https://a.test', existingUserId: user.id });
    assert.equal(users.length, 1);
    assert.deepEqual(users[0].productData, { retained: 'independent business data' });
    const login = await auth.passkeyOptions({ kind: 'login', username: 'alice', origin: 'https://a.test', rpID: 'b.test', binding: 'ror' });
    assert.equal((await auth.passkeyVerify({ flowId: login.flow_id, binding: 'ror', response: b.login(login, 1, 'https://a.test') })).id, user.id);
    await assert.rejects(auth.passkeyVerify({ flowId: login.flow_id, binding: 'ror', response: b.login(login, 2, 'https://a.test') }), /FLOW_INVALID/);
    const start = auth.startHandoff({ username: 'alice', rpID: 'b.test', origin: 'https://a.test', binding: 'target', returnPath: '/profile' });
    const options = await auth.handoffOptions({ id: start.flow_id, origin: 'https://b.test', binding: 'source' });
    const verified = await auth.handoffVerify({ flowId: options.flow_id, origin: 'https://b.test', binding: 'source', response: b.login(options, 2) });
    const fragment = new URLSearchParams(new URL(verified.url).hash.slice(1));
    const complete = { id: fragment.get('complete'), code: fragment.get('code'), origin: 'https://a.test', binding: 'target' };
    assert.equal(auth.completeHandoff(complete).identity.id, user.id);
    assert.throws(() => auth.completeHandoff(complete), /FLOW_INVALID/);
    auth.removePasskey(user.id, a.id);
    assert.throws(() => auth.removePasskey(user.id, b.id), /LAST_CREDENTIAL/);
    users[0].recoveryEnabled = true;
    auth.removePasskey(user.id, b.id);
    assert.equal(auth.passkeys(user.id).length, 0, '备用登录方式由通用账号宿主决定，不依赖 Telegram 字段');
    assert.ok(saves() >= 6);
});

test('通用 Passkey 路由通过账号和会话适配运行，含注册、近期认证、管理配置及独立 App 绑定', async t => {
    const { auth, users } = fixture(), app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
        req.account = users.find(user => user.id === req.get('X-Fixture-Account'));
        req.accountProof = req.get('X-Fixture-Proof');
        next();
    });
    const common = { auth, getOrigin: () => 'https://b.test', limiter: () => (_req, _res, next) => next(),
        wrap: work => (req, res, next) => Promise.resolve().then(() => work(req, res, next)).catch(next) };
    const browser = express.Router(), admin = express.Router(), external = express.Router();
    installPasskeyRoutes(browser, { ...common, getIdentity: req => req.account, getSessionProof: req => req.accountProof,
        setIdentity(req, _res, user) { req.account = user; req.accountProof = 'verified:' + user.id; } });
    installPasskeyAdminRoutes(admin, common);
    installPasskeyAuthenticationRoutes(external, { ...common, issueBinding: () => 'app-one', readBinding: req => req.get('X-Fixture-App') });
    app.use('/auth', browser); app.use('/admin', admin); app.use('/external', external);
    app.use((error, _req, res, _next) => res.status(400).json({ error: error.message }));
    const server = await new Promise((resolve, reject) => { const value = app.listen(0, '127.0.0.1', () => resolve(value)); value.on('error', reject); });
    t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
    let cookie = '';
    const base = 'http://127.0.0.1:' + server.address().port;
    async function call(route, body, headers = {}, method = body ? 'POST' : 'GET') {
        const response = await fetch(base + route, { method, headers: { Cookie: cookie, Origin: 'https://b.test', ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) });
        const next = response.headers.getSetCookie();
        if (next.length) cookie = next.map(value => value.split(';')[0]).join('; ');
        return { status: response.status, body: await response.json() };
    }
    const b = authenticator('b.test');
    const options = (await call('/auth/passkeys/register/options', { username: 'alice', addAccount: true })).body;
    const result = await call('/auth/passkeys/verify', { flow_id: options.flow_id, response: b.register(options), addAccount: true });
    assert.equal(result.status, 200);
    const account = result.body.identity.id, headers = { 'X-Fixture-Account': account, 'X-Fixture-Proof': 'verified:' + account };
    assert.equal((await call('/auth/passkeys', null, headers)).body.passkeys[0].id, b.id);
    assert.equal((await call('/auth/passkeys/' + b.id, { remark: 'General account' }, headers, 'PATCH')).status, 200);
    assert.equal((await call('/auth/passkeys/' + b.id, { remark: 'wrong' }, { ...headers, 'X-Fixture-Proof': 'wrong' }, 'PATCH')).body.error, 'PASSKEY_REAUTH_REQUIRED');
    assert.equal((await call('/admin/users/' + account + '/passkeys', null)).body.passkeys[0].remark, 'General account');
    assert.equal((await call('/admin/users/' + account + '/passkeys/' + b.id, null, {}, 'DELETE')).status, 409);
    assert.equal((await call('/admin/passkey-origins', { origins: ['https://b.test'] }, {}, 'PUT')).status, 200);
    const externalOptions = (await call('/external/passkeys/login/options', { username: 'alice' })).body;
    assert.equal((await call('/external/passkeys/verify', { flow_id: externalOptions.flow_id, response: b.login(externalOptions) }, { 'X-Fixture-App': 'wrong' })).body.error, 'PASSKEY_FLOW_INVALID');
    const retry = (await call('/external/passkeys/login/options', { username: 'alice' })).body;
    assert.equal((await call('/external/passkeys/verify', { flow_id: retry.flow_id, response: b.login(retry) }, { 'X-Fixture-App': 'app-one' })).body.identity.id, account);
});
