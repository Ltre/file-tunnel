'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),https=require('node:https'),{execFileSync}=require('node:child_process');
const express=require('express'),{chromium}=require(path.join(os.homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));
const {createDiskAuth}=require('../server/disk-auth'),{createDiskAccountSessions}=require('../server/disk-account-sessions'),{createDiskAPI}=require('../server/disk-api');
const {createTelegramDriveStore}=require('../server/telegram-drive'),{createDiskOperations}=require('../server/disk-operations'),{openDiskRepository}=require('../server/disk-repository');
async function fixture(t,{port:requestedPort=0}={}){
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'passkey-browser-261123-')),root=path.resolve(__dirname,'..');let browser,server,api;
    t.after(async()=>{await browser?.close();api?.close();if(server?.listening){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}openDiskRepository(dir).close();assert.equal(path.dirname(path.resolve(dir)),path.resolve(os.tmpdir()));assert.ok(path.basename(dir).startsWith('passkey-browser-261123-'));fs.rmSync(dir,{recursive:true,force:true});});
    let tls;
    if(process.platform==='win32'){
        const pfx=path.join(dir,'fixture.pfx'),script=`$rsa=[System.Security.Cryptography.RSA]::Create(2048); $req=[System.Security.Cryptography.X509Certificates.CertificateRequest]::new('CN=a.test',$rsa,[System.Security.Cryptography.HashAlgorithmName]::SHA256,[System.Security.Cryptography.RSASignaturePadding]::Pkcs1); $cert=$req.CreateSelfSigned([DateTimeOffset]::UtcNow.AddMinutes(-1),[DateTimeOffset]::UtcNow.AddDays(1)); [System.IO.File]::WriteAllBytes('${pfx.replaceAll("'","''")}',$cert.Export([System.Security.Cryptography.X509Certificates.X509ContentType]::Pfx)); $cert.Dispose(); $rsa.Dispose()`;
        execFileSync('pwsh.exe',['-NoProfile','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{windowsHide:true,stdio:'pipe'});tls={pfx:fs.readFileSync(pfx)};
    }else{
        execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-subj','/CN=a.test','-keyout',path.join(dir,'key.pem'),'-out',path.join(dir,'cert.pem')],{stdio:'pipe'});tls={key:fs.readFileSync(path.join(dir,'key.pem')),cert:fs.readFileSync(path.join(dir,'cert.pem'))};
    }
    const app=express();app.use(express.json());let origins=[];
    const auth=createDiskAuth({dataDir:dir,trustedOrigins:()=>origins}),sessions=createDiskAccountSessions({keyForRequest:()=>auth.sessionKey,user:id=>auth.user(id),secure:()=>true});
    const origin=req=>req.protocol+'://'+req.get('host');
    api=createDiskAPI({dataDir:dir,auth,defaultStore:createTelegramDriveStore({dataDir:dir}),operations:createDiskOperations({dataDir:dir}),telegram:{},getDefaultBackend:()=>({}),getIdentity:req=>sessions.identity(req),setIdentity:(req,res,value)=>sessions.set(req,res,value),getOrigin:origin,isMockRequest:()=>false,maxDepth:()=>30});
    sessions.registerRoutes(app,{origin});
    app.get('/api/telegram/drive/me',(req,res)=>res.json({identity:sessions.identity(req),accounts:sessions.list(req)}));
    app.use('/api/telegram/drive',api.browser);app.use('/api/telegram/disk-admin',api.admin);
    app.use('/client',express.static(path.join(root,'client')));
    app.get('/client/simplewebauthn.js',(_req,res)=>res.sendFile(require('../server/browser-assets').resolvePasskeyBrowserAsset(root)));
    // Static middleware falls through for the vendor asset, which is resolved
    // from the same installed package as the application's actual route.
    app.get('/.well-known/webauthn',(_req,res)=>res.json({origins}));
    for(const [route,file] of [['/account-center','account-center.html'],['/passkey-auth','passkey-auth.html'],['/admin/users','admin-users.html']])app.get(route,(_req,res)=>res.set({'Cache-Control':'no-store','Referrer-Policy':'no-referrer'}).sendFile(path.join(root,'pages',file)));
    app.get('/fixture',(_req,res)=>res.type('html').send('<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/client/passkey-client.css"><link rel="stylesheet" href="/client/account-ui.css"><script src="/client/simplewebauthn.js"></script><script src="/client/disk-client.js"></script><script src="/client/passkey-client.js"></script><script src="/client/account-ui.js"></script><button id="register">register</button><button id="login">login</button><script>register.onclick=()=>PasskeyClient.register({username:"alice",addAccount:true}).then(value=>window.result=value).catch(error=>window.failure=error.message);login.onclick=()=>PasskeyClient.login({username:"alice",addAccount:true}).then(value=>window.result=value).catch(error=>window.failure=error.message);</script>'));
    server=https.createServer(tls,app);
    await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(requestedPort,'127.0.0.1',resolve);});
    const port=server.address().port;origins=['a','b','c'].map(host=>`https://${host}.test${port===443?'':':'+port}`);
    browser=await chromium.launch({channel:'chrome',headless:true,args:['--ignore-certificate-errors','--no-proxy-server','--host-resolver-rules=MAP *.test 127.0.0.1']});
    const context=await browser.newContext({ignoreHTTPSErrors:true,locale:'zh-CN'});
    return {auth,context,origins,async authenticator(page,credentials=[]){const cdp=await context.newCDPSession(page);await cdp.send('WebAuthn.enable');const {authenticatorId}=await cdp.send('WebAuthn.addVirtualAuthenticator',{options:{protocol:'ctap2',transport:'internal',hasResidentKey:true,hasUserVerification:true,isUserVerified:true,automaticPresenceSimulation:true}});for(const credential of credentials)await cdp.send('WebAuthn.addCredential',{authenticatorId,credential});return {cdp,id:authenticatorId,keys:async()=> (await cdp.send('WebAuthn.getCredentials',{authenticatorId})).credentials};}};
}
test('隔离 HTTPS Chrome：原域名 Passkey 真实注册，禁用 ROR 后通过原域名弹窗认证并安全返回',{timeout:60000},async t=>{
    const f=await fixture(t),b=await f.context.newPage(),errors=[];b.on('pageerror',error=>errors.push(error.message));
    await b.goto(f.origins[1]+'/fixture');const device=await f.authenticator(b);await b.locator('#register').click();await b.waitForFunction(()=>window.result||window.failure);
    const registered=await b.evaluate(()=>({result:window.result,failure:window.failure}));assert.equal(registered.failure,undefined);const userId=registered.result.identity.id;
    assert.equal(f.auth.users().length,1);const credentials=await device.keys();assert.equal(credentials.length,1);
    const a=await f.context.newPage();a.on('pageerror',error=>errors.push(error.message));await a.goto(f.origins[0]+'/fixture');await f.authenticator(a,credentials);
    await a.evaluate(()=>{PublicKeyCredential.getClientCapabilities=async()=>({relatedOrigins:false});});await a.locator('#login').click();await a.getByText('选择 Passkey 验证方式',{exact:true}).waitFor();
    const popupPromise=f.context.waitForEvent('page');await a.getByText('前往 b.test 验证',{exact:true}).click();const popup=await popupPromise;await popup.waitForURL(f.origins[1]+'/passkey-auth?flow=*');await f.authenticator(popup,credentials);
    await popup.locator('#verify').waitFor({state:'visible'});await popup.locator('#verify').click();
    try{await a.waitForFunction(()=>window.result||window.failure,{},{timeout:20000});}
    catch(error){throw Error(error.message+' '+JSON.stringify({popupPath:new URL(popup.url()).pathname,popup:await popup.evaluate(()=>({status:document.getElementById('status')?.textContent,hasOpener:Boolean(window.opener),referrer:document.referrer&&new URL(document.referrer).origin})),original:await a.evaluate(()=>({failure:window.failure,dialogs:document.querySelector('dialog')?.textContent}))}));}
    const result=await a.evaluate(()=>({result:window.result,failure:window.failure}));
    assert.equal(result.failure,undefined);assert.equal(result.result.identity.id,userId);assert.equal(f.auth.users().length,1);assert.equal(f.auth.passkeys(userId).length,1,'选择不创建时不增加凭据');assert.equal(result.result.authenticatedRpID,'b.test');
    await a.evaluate(id=>{DiskClient.setAccount(id);void AccountUI.open({currentAccount:()=>id,load:async()=>({accounts:[{identity:{id,name:'Alice'}}],status:{}}),select:async()=>{throw Error('unexpected account selection')},renderSignIn(){}});},userId);
    await a.getByText('管理当前账号',{exact:true}).click();const center=a.frameLocator('.account-center-overlay iframe');await center.locator('#add').waitFor({state:'visible'});await center.locator('#add').click();await center.getByText('Passkey 已添加，原有凭据保持有效',{exact:true}).waitFor();
    assert.equal(f.auth.users().length,1);assert.deepEqual(f.auth.passkeys(userId).map(key=>key.rpID).sort(),['a.test','b.test']);
    await center.getByText('修改备注',{exact:true}).first().click();await center.locator('dialog input').fill('我的设备');await center.locator('dialog').getByText('保存',{exact:true}).click();await center.getByText('我的设备',{exact:true}).waitFor();assert.equal(f.auth.passkeys(userId)[0].remark,'我的设备');
    await a.screenshot({path:path.join(__dirname,'../.npm-cache/261123-account-center.png'),fullPage:true});assert.deepEqual(errors,[]);
});
test('隔离 HTTPS Chrome：真实读取 ROR well-known 后跨 RP 验证；已有用户名注册转为验证，不创建第二账号',{timeout:30000},async t=>{
    let f;try{f=await fixture(t,{port:443});}catch(error){if(error.code==='EADDRINUSE'||error.code==='EACCES'){t.skip('本机 443 端口不可用，未运行默认 HTTPS 端口 ROR 浏览器测试');return;}throw error;}
    const b=await f.context.newPage();await b.goto(f.origins[1]+'/fixture');const source=await f.authenticator(b);await b.locator('#register').click();await b.waitForFunction(()=>window.result||window.failure);
    const before=await b.evaluate(()=>window.result);assert.ok(before?.identity);const credentials=await source.keys();
    const a=await f.context.newPage();await a.goto(f.origins[0]+'/fixture');await f.authenticator(a,credentials);await a.locator('#register').click();await a.waitForFunction(()=>window.result||window.failure,undefined,{timeout:12000});
    const result=await a.evaluate(()=>({result:window.result,failure:window.failure}));assert.equal(result.failure,undefined);assert.equal(result.result.identity.id,before.identity.id);assert.equal(result.result.authenticatedRpID,'b.test');assert.equal(result.result.offerPasskey,true);assert.equal(f.auth.users().length,1);assert.equal(f.auth.passkeys(before.identity.id).length,1);
});
test('真实后台界面：滑块文案、风险说明、仅移除的 Passkey 面板和最后凭据保护',{timeout:30000},async t=>{
    const f=await fixture(t),key=require('./support/passkey-authenticator.cjs')('a.test');
    const start=await f.auth.passkeyOptions({kind:'register',username:'admincheck',origin:f.origins[0],binding:'fixture'});await f.auth.passkeyVerify({flowId:start.flow_id,binding:'fixture',response:key.register(start,f.origins[0])});
    const page=await f.context.newPage();await page.goto(f.origins[0]+'/admin/users');await page.locator('[role=switch]').first().waitFor();assert.equal(await page.locator('input[type=checkbox]').count(),0);
    assert.equal(await page.locator('[role=switch][aria-checked=false]').count(),3);await page.locator('[role=switch]').first().click();assert.equal(await page.getByText('已启用',{exact:true}).count(),1);
    await page.getByRole('button',{name:'风险文件说明'}).hover();await page.locator('#riskTooltip').waitFor({state:'visible'});assert.match(await page.locator('#riskTooltip').innerText(),/\.html/);await page.locator('h1').hover();await page.locator('#riskTooltip').waitFor({state:'hidden'});
    await page.getByText('Passkey 管理',{exact:true}).click();await page.locator('dialog table').waitFor();assert.equal(await page.locator('dialog button').count(),2,'只有关闭和移除，无额外管理操作');
    page.on('dialog',dialog=>dialog.accept());await page.locator('dialog').getByText('移除',{exact:true}).click();await page.getByText('不能移除最后一个登录凭据',{exact:true}).waitFor();
    await page.screenshot({path:path.join(__dirname,'../.npm-cache/261123-admin-users.png'),fullPage:true});
    await page.locator('dialog').getByText('关闭',{exact:true}).click();
    await page.getByRole('button',{name:'ROR 域名配置',exact:true}).click();await page.locator('dialog textarea').waitFor();await page.waitForFunction(()=>!document.querySelector('dialog textarea').disabled&&!document.querySelector('dialog button').disabled);
    const updated=[f.origins[0],f.origins[1],'https://new.test'];await page.locator('dialog textarea').fill(updated.join('\n'));await page.locator('dialog').getByText('保存',{exact:true}).click();await page.getByText('ROR 域名配置已保存并生效',{exact:true}).waitFor();assert.deepEqual(f.auth.passkeyOrigins(),updated);
    await page.locator('dialog').getByText('关闭',{exact:true}).click();await page.reload();await page.getByRole('button',{name:'ROR 域名配置',exact:true}).click();await page.waitForFunction(()=>document.querySelector('dialog textarea')?.value.includes('new.test'));assert.equal(await page.locator('dialog textarea').inputValue(),updated.join('\n'));
    await page.screenshot({path:path.join(__dirname,'../.npm-cache/261123-passkey-origins.png'),fullPage:true});
});
