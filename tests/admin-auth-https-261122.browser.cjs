'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),express=require('express');
const {chromium}=require(path.join(os.homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));
const {listenHttp}=require('./support/listen-http.cjs');

test('real Chrome blocks HTTP without server permission, despite localhost secure-context classification',{timeout:20000},async t=>{
    const root=path.resolve(__dirname,'..'),app=express(),authRequests=[];
    app.get('/admin-auth',(_req,res)=>res.sendFile(path.join(root,'pages/admin-auth.html')));
    app.use('/client',express.static(path.join(root,'client')));
    app.use('/api/admin/auth',(req,res)=>{authRequests.push(req.method+' '+req.path);res.json({configured:true,authenticated:false,localHttpTestAllowed:false});});
    const server=await listenHttp(app);let browser;
    t.after(async()=>{await browser?.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
    browser=await chromium.launch({channel:'chrome',headless:true});
    const page=await browser.newPage({locale:'zh-CN'});
    await page.goto('http://localhost:'+server.address().port+'/admin-auth');
    await page.waitForFunction(()=>window.TunnelI18n?.t);
    assert.equal(await page.evaluate(()=>isSecureContext),true);
    assert.equal(await page.locator('#token').isDisabled(),true);
    assert.equal(await page.locator('#form button').isDisabled(),true);
    assert.match(await page.locator('#status').innerText(),/HTTPS/);
    await page.evaluate(()=>{document.getElementById('form').dispatchEvent(new Event('submit',{cancelable:true}));});
    assert.deepEqual(authRequests,['GET /status']);
    assert.match(page.url(),/\/admin-auth$/);
    for(const language of ['en','ja','zh-Hans']){
        await page.evaluate(language=>window.TunnelI18n.setLanguage(language),language);
        const expected=await page.evaluate(()=>TunnelI18n.t('管理员 DBSC 登录需要证书有效的 HTTPS。请通过 HTTPS 地址重新打开；HTTP localhost 不会触发浏览器原生注册。'));
        await page.waitForFunction(expected=>document.getElementById('status').textContent===expected,expected);
        assert.equal(await page.locator('#status').innerText(),expected);
    }
    assert.deepEqual(authRequests,['GET /status']);
});

test('real Chrome signs in after valid TOTP with an explicitly unbound and local-only test session',{timeout:20000},async t=>{
    const crypto=require('node:crypto'),{createAdminAuth}=require('../server/admin-auth');
    const root=path.resolve(__dirname,'..'),dir=fs.mkdtempSync(path.join(os.tmpdir(),'admin-local-browser-261122-'));
    const secret='JBSWY3DPEHPK3PXP';fs.writeFileSync(path.join(dir,'.gauth-admin.json'),JSON.stringify({secret,createdAt:'fixture'}));
    const auth=createAdminAuth({dataDir:dir}),app=express();app.use(express.json());let submissions=0;
    app.get('/admin-auth',(_req,res)=>res.sendFile(path.join(root,'pages/admin-auth.html')));
    app.use('/client',express.static(path.join(root,'client')));
    app.get('/api/admin/auth/status',(req,res)=>res.json({configured:true,authenticated:auth.isAuthenticated(req),localHttpTestAllowed:auth.localHttpTestAllowed(req)}));
    app.post('/api/admin/auth/login',(req,res)=>{submissions++;if(!auth.verifyToken(req.body.token))return res.status(401).json({error:'invalid-totp'});res.json(auth.beginBinding(req,res));});
    app.get('/admin',auth.requireAuth,(_req,res)=>res.sendFile(path.join(root,'pages/admin-security.html')));
    app.get('/api/admin/security/sessions',auth.requireAuth,(req,res)=>res.json({currentSessionId:auth.getSession(req)?.id,sessions:auth.sessions()}));
    const server=await listenHttp(app);let browser;
    t.after(async()=>{await browser?.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));const target=path.resolve(dir);assert.equal(path.dirname(target),path.resolve(os.tmpdir()));assert.ok(path.basename(target).startsWith('admin-local-browser-261122-'));fs.rmSync(target,{recursive:true,force:true});});
    browser=await chromium.launch({channel:'chrome',headless:true});const page=await browser.newPage({locale:'zh-CN'});
    const base='http://localhost:'+server.address().port;
    await page.goto(base+'/admin-auth');await page.waitForFunction(()=>!document.getElementById('token').disabled);
    assert.match(await page.locator('#description').innerText(),/不要求 DBSC 或管理员 Passkey/);
    await page.locator('#token').fill('invalid');
    // An empty/invalid code is also checked by the actual server route.
    const bad=await page.request.post(base+'/api/admin/auth/login',{data:{token:'invalid'}});assert.equal(bad.status(),401);assert.equal(auth.sessions().length,0);
    const bytes=Buffer.from('48656c6c6f21deadbeef','hex'),counter=Buffer.alloc(8);counter.writeBigUInt64BE(BigInt(Math.floor(Date.now()/30000)));
    const digest=crypto.createHmac('sha1',bytes).update(counter).digest(),offset=digest[19]&15;
    const token=String((digest.readUInt32BE(offset)&0x7fffffff)%1000000).padStart(6,'0');
    await page.locator('#token').fill(token);await page.locator('#form button').click();await page.waitForURL(base+'/admin');
    await page.getByText('本机 HTTP 测试会话（未绑定 DBSC）',{exact:true}).waitFor();
    assert.equal(submissions,2);const session=auth.sessions()[0];assert.equal(session.localTest,true);assert.equal(session.dbscBound,false);assert.equal(session.boundAt,0);
    assert.equal(session.expiresAt-session.createdAt,15*24*60*60*1000);
    const copied=(await page.context().cookies()).map(value=>value.name+'='+value.value).join('; ');
    const blocked=await fetch(base+'/api/admin/security/sessions',{headers:{cookie:copied,'X-Forwarded-Port':'443'}});assert.equal(blocked.status,401);
    assert.equal(auth.revokeSession(session.id),true);
    assert.equal((await page.request.get(base+'/api/admin/security/sessions')).status(),401);
});

test('real Chrome with a different UA: a rejected DBSC proof never downgrades authentication',{timeout:20000},async t=>{
    const root=path.resolve(__dirname,'..'),browser=await chromium.launch({channel:'chrome',headless:true});
    t.after(()=>browser.close());
    const context=await browser.newContext({locale:'zh-CN',userAgent:'Mozilla/5.0 (Linux; Android 16; SM-X700) AppleWebKit/537.36 Chrome/156.0.8078.47 Mobile Safari/537.36'});
    let attempted=false,statusReads=0;
    await context.route('https://admin.test/**',async route=>{
        const url=new URL(route.request().url());
        if(url.pathname==='/api/admin/auth/status'){
            statusReads++;
            return route.fulfill({json:{configured:true,authenticated:false,localHttpTestAllowed:false,bindingStatus:attempted?{state:'registration-rejected'}:null}});
        }
        if(url.pathname==='/api/admin/auth/login'){attempted=true;return route.fulfill({json:{pending:true,dbscRequired:true}});}
        if(url.pathname==='/admin-auth')return route.fulfill({contentType:'text/html',body:fs.readFileSync(path.join(root,'pages/admin-auth.html'))});
        if(url.pathname.startsWith('/client/')){
            const target=path.resolve(root,'.'+url.pathname);assert.ok(target.startsWith(path.join(root,'client')+path.sep));
            if(fs.existsSync(target))return route.fulfill({contentType:url.pathname.endsWith('.json')?'application/json':'application/javascript',body:fs.readFileSync(target)});
        }
        return route.fulfill({status:404,body:''});
    });
    const page=await context.newPage();await page.goto('https://admin.test/admin-auth');
    assert.equal(await page.locator('#dbscPlatformHint').count(),0,'平台 UA 不决定认证方式');
    assert.equal(await page.locator('#token').isDisabled(),false);
    await page.locator('#token').fill('123456');await page.locator('#form button').click();
    await page.getByText(/ADMIN_DBSC_PROOF_REJECTED/).waitFor();
    assert.equal(await page.locator('#form button').isDisabled(),false);
    assert.equal(statusReads,2);assert.match(page.url(),/\/admin-auth$/);
});
