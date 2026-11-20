'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), net = require('node:net');
const { spawn } = require('node:child_process');
const { chromium } = require(path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));

test('production pages survive repeated exit/rejoin and hard refresh, while real guess and API limits remain enforced', { timeout: 150000 }, async t => {
    const root = path.resolve(__dirname, '..'), dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dr2t-rejoin-browser-261121-'));
    const probe = net.createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
    const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
    const base = 'http://127.0.0.1:' + port, env = { ...process.env, PORT: String(port), TUNNEL_DATA_DIR: dataDir, TELEGRAM_OIDC_MOCK_ENABLED: '1', DR2T_PROXY_REEXEC: '1' };
    for (const name of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'DR2T_PROXY', 'DR2T_ALL_PROXY', 'NODE_USE_ENV_PROXY']) env[name] = '';
    const child = spawn(process.execPath, ['server.js'], { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let logs = '', browser;
    child.stdout.on('data', value => { logs = (logs + value).slice(-6000); });
    child.stderr.on('data', value => { logs = (logs + value).slice(-6000); });
    t.after(async () => {
        await browser?.close();
        if (child.exitCode === null && child.signalCode === null) {
            const done = new Promise(resolve => child.once('exit', resolve)); child.kill(); await done;
        }
        const resolved = path.resolve(dataDir);
        assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
        assert.ok(path.basename(resolved).startsWith('dr2t-rejoin-browser-261121-'));
        fs.rmSync(resolved, { recursive: true, force: true });
    });
    const deadline = Date.now() + 20000;
    for (;;) {
        if (child.exitCode !== null) throw Error('Isolated server exited: ' + logs);
        try { if ((await fetch(base + '/api/admin/auth/status', { signal: AbortSignal.timeout(1000) })).ok) break; } catch (_) {}
        if (Date.now() > deadline) throw Error('Isolated server startup timed out: ' + logs);
        await new Promise(resolve => setTimeout(resolve, 40));
    }
    browser = await chromium.launch({ channel: 'chrome', headless: true });
    const context = await browser.newContext({ locale: 'zh-CN', serviceWorkers: 'block' });
    await context.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
    const page = await context.newPage(), pageErrors = [], codeRequests = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    page.on('dialog', dialog => dialog.accept());
    page.on('request', request => { if (request.url().includes('/api/short-codes/2U52R')) codeRequests.push(request.headers()); });
    const cdp = await context.newCDPSession(page); await cdp.send('Network.enable'); await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
    const ready = () => page.waitForFunction(() => window.TunnelStartup?.completeMs !== null &&
        typeof state !== 'undefined' && state.socket?.connected && state.shortCode && !document.body.classList.contains('tunnel-route-active'), null, { timeout: 18000 });
    const typeCode = async () => { for (let i = 0; i < 5; i++) await page.locator('#tunnelCodeInputs input').nth(i).fill('2U52R'[i]); };
    await page.goto(base + '/'); await page.locator('#landingCreateBtn').click(); await ready();
    const changed = await page.evaluate(() => new Promise(resolve => state.socket.emit('session-short-code-update', { shortCode: '2U52R' }, resolve)));
    assert.equal(changed.ok, true, JSON.stringify(changed)); await page.waitForFunction(() => state.shortCode === '2U52R');
    const identity = await page.evaluate(() => ({ sessionId: state.sessionId, deviceId: state.deviceId, grant: savedTunnelGrant(state.sessionId) }));
    for (let i = 0; i < 4; i++) {
        await page.evaluate(() => { void exitTunnelAndClearCache(); });
        await page.waitForURL(url => url.searchParams.get('leave') === '1');
        await page.locator('#tunnelCodeInputs input').first().waitFor({ state: 'visible' });
        await typeCode(); await ready();
        assert.deepEqual(await page.evaluate(() => ({ sessionId: state.sessionId, deviceId: state.deviceId, grant: savedTunnelGrant(state.sessionId) })), identity);
    }
    // Exercise more shell requests than the unchanged production API threshold.
    for (let batch = 0; batch < 51; batch++) {
        const responses = await Promise.all(Array.from({ length: 20 }, () => fetch(base + '/client/tunnel-entry.js', { method: 'HEAD' })));
        assert.ok(responses.every(response => response.status === 200));
    }
    assert.equal((await fetch(base + '/api/admin/auth/status')).status, 200, '1020 shell requests do not consume the API budget');
    for (let i = 0; i < 41; i++) {
        const response = await fetch(base + '/api/short-codes/WRONG'); assert.ok([404, 429].includes(response.status));
    }
    assert.equal((await fetch(base + '/api/short-codes/WRONG')).status, 429, 'unknown guesses retain their original limit');
    await page.goto(base + '/?leave=1'); await page.locator('#tunnelCodeInputs input').first().waitFor({ state: 'visible' });
    await typeCode(); await ready();
    const proof = codeRequests.at(-1);
    assert.equal(proof['x-tunnel-device'], identity.deviceId); assert.equal(proof['x-tunnel-grant'], identity.grant);
    assert.equal(await page.evaluate(() => state.sessionId), identity.sessionId, 'the lightweight chooser reused exactly the saved membership');
    // Fill the real, unscaled API budget, then force a full uncached reload.
    let apiLimited = false;
    for (let batch = 0; batch < 51 && !apiLimited; batch++) {
        const responses = await Promise.all(Array.from({ length: 20 }, () => fetch(base + '/api/admin/auth/status')));
        apiLimited = responses.some(response => response.status === 429);
        await Promise.all(responses.map(response => response.arrayBuffer()));
    }
    assert.equal(apiLimited, true);
    const limited = await fetch(base + '/api/admin/auth/status');
    assert.equal(limited.status, 429); assert.equal((await limited.json()).code, 'LOCAL_REQUEST_RATE_LIMIT');
    const refreshed = await page.reload({ waitUntil: 'domcontentloaded' });
    assert.equal(refreshed.status(), 200); assert.match(refreshed.headers()['content-type'], /text\/html/); await ready();
    assert.equal(await page.evaluate(() => state.sessionId), identity.sessionId);
    assert.equal(await page.evaluate(() => savedTunnelGrant(state.sessionId)), identity.grant);
    await page.goto(base + '/?leave=1'); await page.locator('#landingRecentBtn').click();
    await page.waitForFunction(() => document.getElementById('landingNote')?.textContent === '请求过于频繁，请稍后再试');
    assert.equal(await page.locator('#sessionLanding').isVisible(), true);
    assert.deepEqual(pageErrors, []);
    t.diagnostic(JSON.stringify({ browser: browser.version(), exitsAndRejoins: 4, uncachedShellReads: 1020, apiLimitConfirmed: true,
        validMemberAfterGuessLimit: true, hardRefreshStayedInTunnel: true, genericThrottleMessageCorrect: true }));
});
