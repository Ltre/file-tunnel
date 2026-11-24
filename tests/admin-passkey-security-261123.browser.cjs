'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),https=require('node:https'),crypto=require('node:crypto'),{execFileSync}=require('node:child_process'),express=require('express');
const {chromium}=require(path.join(os.homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));
async function fixture(t){
    const root=path.resolve(__dirname,'..'),dir=fs.mkdtempSync(path.join(os.tmpdir(),'admin-passkey-security-261123-'));let browser,server;
    t.after(async()=>{await browser?.close();if(server?.listening){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}const target=path.resolve(dir);assert.equal(path.dirname(target),path.resolve(os.tmpdir()));assert.ok(path.basename(target).startsWith('admin-passkey-security-261123-'));fs.rmSync(target,{recursive:true,force:true,maxRetries:10,retryDelay:100});});
    let tls;if(process.platform==='win32'){
        const pfx=path.join(dir,'fixture.pfx'),script=`$rsa=[System.Security.Cryptography.RSA]::Create(2048); $req=[System.Security.Cryptography.X509Certificates.CertificateRequest]::new('CN=admin.test',$rsa,[System.Security.Cryptography.HashAlgorithmName]::SHA256,[System.Security.Cryptography.RSASignaturePadding]::Pkcs1); $cert=$req.CreateSelfSigned([DateTimeOffset]::UtcNow.AddMinutes(-1),[DateTimeOffset]::UtcNow.AddDays(1)); [System.IO.File]::WriteAllBytes('${pfx.replaceAll("'","''")}',$cert.Export([System.Security.Cryptography.X509Certificates.X509ContentType]::Pfx)); $cert.Dispose(); $rsa.Dispose()`;execFileSync('pwsh.exe',['-NoProfile','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{windowsHide:true,stdio:'pipe'});tls={pfx:fs.readFileSync(pfx)};
    }else{execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-subj','/CN=admin.test','-keyout',path.join(dir,'key.pem'),'-out',path.join(dir,'cert.pem')],{stdio:'pipe'});tls={key:fs.readFileSync(path.join(dir,'key.pem')),cert:fs.readFileSync(path.join(dir,'cert.pem'))};}
    const {createAdminPasskeys}=require('../server/admin-passkeys'),signingKey=crypto.randomBytes(32),store=createAdminPasskeys({dataDir:dir,marker:()=> 'isolated-totp-marker',signingKey:()=>signingKey});
    const app=express(),calls=[];let listFailure=false;
    app.use(express.json());app.use('/client',express.static(path.join(root,'client')));app.get('/client/simplewebauthn.js',(_req,res)=>res.sendFile(require('../server/browser-assets').resolvePasskeyBrowserAsset(root)));
    app.get('/admin/security',(_req,res)=>res.cookie('test_admin_session','authorized',{secure:true,httpOnly:true,sameSite:'strict'}).sendFile(path.join(root,'pages/admin-security.html')));
    const authenticated=(req,res,next)=>String(req.headers.cookie||'').includes('test_admin_session=authorized')?next():res.status(401).json({error:'ADMIN_AUTH_REQUIRED'});
    app.use('/api',authenticated);
    app.get('/api/admin/security/sessions',(_req,res)=>res.json({currentSessionId:'admin-fixture-session-261123',sessions:[{id:'admin-fixture-session-261123',model:'Test device',os:'Fixture OS',browser:'Chrome',lastActivityAt:Date.now(),expiresAt:Date.now()+60000,authMethod:'totp-passkey',independentAuth:true,dbscBound:false,ipActivity:[{address:'127.0.0.1',lastActivityAt:Date.now()}]}]}));
    app.use('/api/telegram',(req,res)=>{calls.push('UNEXPECTED FRONTEND '+req.path);res.status(500).json({error:'ADMIN_CREDENTIALS_MUST_NOT_USE_FRONTEND_ROUTES'});});
    app.get('/api/admin/security/passkeys',(_req,res)=>{calls.push('list');if(listFailure)return res.status(503).json({error:'FIXTURE_LIST_UNAVAILABLE'});res.json({authenticated:true,passkeys:store.list()});});
    const origin=req=>req.protocol+'://'+req.get('host');
    app.post('/api/admin/security/passkeys/register/options',async(req,res)=>{try{calls.push('options');assert.equal(req.get('origin'),origin(req));res.json(await store.registrationOptions({origin:origin(req),sessionId:'admin-fixture-session-261123',remark:req.body.remark}));}catch(error){res.status(400).json({error:error.message});}});
    app.post('/api/admin/security/passkeys/register/verify',async(req,res)=>{try{calls.push('verify');assert.equal(req.get('origin'),origin(req));res.json({ok:true,passkey:await store.register({origin:origin(req),sessionId:'admin-fixture-session-261123',flowId:req.body.flow_id,response:req.body.response})});}catch(error){res.status(400).json({error:error.message});}});
    server=https.createServer(tls,app);await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
    browser=await chromium.launch({channel:'chrome',headless:true,args:['--ignore-certificate-errors','--no-proxy-server','--host-resolver-rules=MAP admin.test 127.0.0.1']});const context=await browser.newContext({ignoreHTTPSErrors:true,locale:'zh-CN'}),page=await context.newPage(),cdp=await context.newCDPSession(page);
    await cdp.send('WebAuthn.enable');await cdp.send('WebAuthn.addVirtualAuthenticator',{options:{protocol:'ctap2',transport:'internal',hasResidentKey:true,hasUserVerification:true,isUserVerified:true,automaticPresenceSimulation:true}});
    await page.goto('https://admin.test:'+server.address().port+'/admin/security');await page.waitForFunction(()=>!document.getElementById('bindAdminPasskey').disabled);
    return {page,store,calls,failList:value=>{listFailure=value;}};
}
test('管理员安全中心：独立管理员凭据真实 WebAuthn 绑定、备注及列表，不调用前台账号 API',{timeout:30000},async t=>{
    const {page,store,calls}=await fixture(t),errors=[];page.on('pageerror',error=>errors.push(error.message));
    assert.equal(await page.locator('#sessions').getByText('TOTP + 管理员 Passkey',{exact:true}).count(),1);
    assert.equal(await page.locator('.admin-passkeys button').count(),1,'仅提供绑定，不擅自增加移除或重命名');
    assert.match(await page.locator('.admin-passkeys').innerText(),/与前台账号的 Passkey 相互独立/);
    await page.locator('#adminPasskeyRemark').fill('s10p 管理员凭据');await page.locator('#bindAdminPasskey').click();await page.getByText('管理员 Passkey 已绑定',{exact:true}).waitFor();
    assert.equal(store.list().length,1);assert.equal(store.list()[0].remark,'s10p 管理员凭据');assert.equal(store.list()[0].rpID,'admin.test');assert.ok(store.list()[0].createdAt);
    await page.locator('#adminPasskeys').getByText('s10p 管理员凭据',{exact:true}).waitFor();assert.equal(await page.locator('#adminPasskeyRemark').inputValue(),'');
    await page.reload();await page.locator('#adminPasskeys').getByText('s10p 管理员凭据',{exact:true}).waitFor();assert.equal(store.list().length,1,'刷新列表不能重复注册');
    assert.deepEqual(calls.filter(value=>value==='options'||value==='verify'),['options','verify']);assert.equal(calls.some(value=>value.startsWith('UNEXPECTED')),false);assert.deepEqual(errors,[]);
    assert.equal(await page.evaluate(()=>typeof window.DiskClient),'undefined');assert.equal(await page.evaluate(()=>typeof window.PasskeyClient),'undefined');
});
test('管理员绑定失败保留备注，已绑定后的列表刷新失败不误报绑定失败',{timeout:30000},async t=>{
    const {page,store,failList}=await fixture(t);
    await page.evaluate(()=>{window.actualRegistration=SimpleWebAuthnBrowser.startRegistration;SimpleWebAuthnBrowser.startRegistration=async()=>{throw new DOMException('cancelled by user','NotAllowedError');};});
    await page.locator('#adminPasskeyRemark').fill('Keep note');await page.locator('#bindAdminPasskey').click();await page.getByText(/管理员 Passkey 绑定未完成，请重试/).waitFor();assert.equal(await page.locator('#adminPasskeyRemark').inputValue(),'Keep note');assert.equal(store.list().length,0);
    await page.evaluate(()=>{SimpleWebAuthnBrowser.startRegistration=window.actualRegistration;});failList(true);await page.locator('#bindAdminPasskey').click();await page.getByText(/管理员 Passkey 已绑定，但列表刷新失败，请刷新页面/).waitFor();assert.equal(store.list().length,1);failList(false);await page.reload();await page.locator('#adminPasskeys').getByText('Keep note',{exact:true}).waitFor();
});
