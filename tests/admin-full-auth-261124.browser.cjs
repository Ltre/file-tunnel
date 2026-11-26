'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),net=require('node:net'),http=require('node:http'),https=require('node:https'),crypto=require('node:crypto'),{spawn,execFileSync}=require('node:child_process');
const {chromium}=require(path.join(os.homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));
const root=path.resolve(__dirname,'..'),pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const appRoot=process.env.TEST_APP_ROOT?path.resolve(process.env.TEST_APP_ROOT):root;
function totp(){const counter=Buffer.alloc(8);counter.writeBigUInt64BE(BigInt(Math.floor(Date.now()/30000)));const digest=crypto.createHmac('sha1',Buffer.from('48656c6c6f21deadbeef','hex')).update(counter).digest(),offset=digest[19]&15;return String((digest.readUInt32BE(offset)&0x7fffffff)%1000000).padStart(6,'0');}
async function fixture(t){
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'admin-full-261124-'));let child,proxy,browser,output='';
    async function stop(){if(child&&child.exitCode===null&&child.signalCode===null){const exited=new Promise(resolve=>child.once('exit',resolve));child.kill('SIGTERM');await exited;}}
    t.after(async()=>{await browser?.close();if(proxy){proxy.closeAllConnections();await new Promise(resolve=>proxy.close(resolve));}await stop();const target=path.resolve(dir);assert.equal(path.dirname(target),path.resolve(os.tmpdir()));assert.ok(path.basename(target).startsWith('admin-full-261124-'));fs.rmSync(target,{recursive:true,force:true,maxRetries:10,retryDelay:100});});
    fs.writeFileSync(path.join(dir,'.gauth-admin.json'),JSON.stringify({secret:'JBSWY3DPEHPK3PXP',createdAt:'isolated-administrator'}));
    const probe=net.createServer();await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve));const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
    async function start(){child=spawn(process.execPath,['server.js'],{cwd:appRoot,env:{...process.env,PORT:String(port),TUNNEL_DATA_DIR:dir,TELEGRAM_OIDC_MOCK_ENABLED:'1'},stdio:['ignore','pipe','pipe']});for(const stream of [child.stdout,child.stderr])stream.on('data',value=>output=(output+value).slice(-4000));for(let i=0;i<150;i++){try{if((await fetch('http://127.0.0.1:'+port+'/api/admin/auth/status')).ok)return;}catch(_){}if(child.exitCode!==null)break;await pause(40);}throw Error(output);}
    await start();let tls;
    if(process.platform==='win32'){const pfx=path.join(dir,'test.pfx'),script=`$rsa=[System.Security.Cryptography.RSA]::Create(2048); $req=[System.Security.Cryptography.X509Certificates.CertificateRequest]::new('CN=admin.test',$rsa,[System.Security.Cryptography.HashAlgorithmName]::SHA256,[System.Security.Cryptography.RSASignaturePadding]::Pkcs1); $cert=$req.CreateSelfSigned([DateTimeOffset]::UtcNow.AddMinutes(-1),[DateTimeOffset]::UtcNow.AddDays(1)); [System.IO.File]::WriteAllBytes('${pfx.replaceAll("'","''")}',$cert.Export([System.Security.Cryptography.X509Certificates.X509ContentType]::Pfx)); $cert.Dispose(); $rsa.Dispose()`;execFileSync('pwsh.exe',['-NoProfile','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{windowsHide:true});tls={pfx:fs.readFileSync(pfx)};}
    else{execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-subj','/CN=admin.test','-keyout',path.join(dir,'key.pem'),'-out',path.join(dir,'cert.pem')],{stdio:'ignore'});tls={key:fs.readFileSync(path.join(dir,'key.pem')),cert:fs.readFileSync(path.join(dir,'cert.pem'))};}
    proxy=https.createServer(tls,(req,res)=>{const upstream=http.request({host:'127.0.0.1',port,path:req.url,method:req.method,headers:{...req.headers,'x-forwarded-proto':'https'}},response=>{res.writeHead(response.statusCode,response.headers);response.pipe(res);});upstream.on('error',()=>{if(!res.headersSent)res.writeHead(503);res.end();});req.pipe(upstream);});await new Promise(resolve=>proxy.listen(0,'127.0.0.1',resolve));
    browser=await chromium.launch({channel:'chrome',headless:true,args:['--ignore-certificate-errors','--no-proxy-server','--host-resolver-rules=MAP admin.test 127.0.0.1']});
    const context=await browser.newContext({ignoreHTTPSErrors:true,locale:'zh-CN'}),page=await context.newPage(),cdp=await context.newCDPSession(page);
    await cdp.send('WebAuthn.enable');await cdp.send('WebAuthn.addVirtualAuthenticator',{options:{protocol:'ctap2',transport:'internal',hasResidentKey:true,hasUserVerification:true,isUserVerified:true,automaticPresenceSimulation:true}});
    const origin='https://admin.test:'+proxy.address().port;
    const apiFor=page=>Object.fromEntries(['get','post','put','delete'].map(method=>[method,async(url,options={})=>{const cookies=await page.context().cookies(origin);return page.request[method](url.replace('admin.test','127.0.0.1'),{...options,headers:{Host:new URL(origin).host,Cookie:cookies.map(value=>value.name+'='+value.value).join(';'),...options.headers}});} ]));
    return{dir,page,context,browser,origin,http:'http://127.0.0.1:'+port,port,api:apiFor(page),apiFor,restart:async()=>{await stop();await start();}};
}
test('真实 server.js + HTTPS Chrome：TOTP→能力确认→管理员首绑→每周补验→策略保存→撤销/新设备',{timeout:90000},async t=>{
    const f=await fixture(t),errors=[];f.page.on('pageerror',error=>errors.push(error.message));
    await f.page.goto(f.origin+'/admin-auth?next=/admin/security');await f.page.locator('#token').waitFor({state:'visible'});
    assert.equal((await f.api.get(f.origin+'/api/admin/security/passkeys')).status(),401);
    await f.page.locator('#token').fill(totp());await f.page.locator('#form button').click();
    await f.page.locator('#dbscLoading').waitFor({state:'visible'});assert.equal(await f.page.locator('#dbscLoading').getAttribute('aria-busy'),'true');
    assert.equal(await f.page.locator('.admin-auth-spinner').evaluate(node=>getComputedStyle(node).animationName),'admin-auth-spin');
    await f.page.screenshot({path:path.join(root,'.npm-cache/261124-dbsc-loading.png')});
    await f.page.locator('#dbscFallback').waitFor({state:'visible'});
    assert.equal((await f.api.get(f.origin+'/api/admin/security/passkeys')).status(),401,'仅 TOTP 不得进入后台');
    await f.page.locator('#dbscFallback').click();await f.page.locator('#adminPasskeyRemark').waitFor({state:'visible'});
    assert.equal(await f.page.locator('#dbscLoading').isHidden(),true);
    await f.page.locator('#adminPasskeyRemark').fill('手机密码管理器');await f.page.locator('#passkeyContinue').click();
    await f.page.waitForURL(url=>url.pathname==='/admin/security');await f.page.locator('#adminPasskeys').getByText('手机密码管理器',{exact:true}).waitFor();
    assert.equal((await f.api.get(f.origin+'/api/admin/auth/status')).ok(),true);
    const before=JSON.parse(fs.readFileSync(path.join(f.dir,'.admin-factor-sessions.json'))).sessions[0];assert.ok(before.passkeyVerifiedAt);assert.ok(before.totpVerifiedAt);
    const sessionCookie=(await f.context.cookies(f.origin)).find(value=>value.name==='__Host-tunnel_admin_factors');assert.ok(Math.abs(sessionCookie.expires*1000-before.totpLimit)<3000,'浏览器会话 Cookie 不超出 TOTP 有效期');
    const data=await (await f.api.get(f.origin+'/api/admin/security/sessions')).json();assert.ok(data.sessions.some(value=>value.independentAuth&&value.authMethod==='totp-passkey'));
    await f.page.screenshot({path:path.join(root,'.npm-cache/261124-admin-security.png'),fullPage:true});
    assert.equal(JSON.stringify(data).includes('secretHash'),false);
    await f.page.locator('#totpMonths').fill('1');await f.page.locator('#passkeyDays').fill('1');await f.page.locator('#saveAdminPolicy').click();await f.page.getByText('管理员验证有效期已保存',{exact:true}).waitFor();
    const savedPolicy=await (await f.api.get(f.origin+'/api/admin/security/auth-policy')).json();
    assert.equal((await f.api.put(f.origin+'/api/admin/security/auth-policy',{data:{totpMonths:1,passkeyDays:28,revision:savedPolicy.revision}})).status(),403);
    assert.equal((await f.api.put(f.origin+'/api/admin/security/auth-policy',{data:{totpMonths:1,passkeyDays:7,revision:'stale'}})).status(),403);
    assert.equal((await f.api.put(f.origin+'/api/admin/security/auth-policy',{headers:{Origin:'https://evil.test'},data:{totpMonths:24,passkeyDays:1}})).status(),403);
    // Change only an isolated fixture's verification time; never system time.
    const stateFile=path.join(f.dir,'.admin-factor-sessions.json'),state=JSON.parse(fs.readFileSync(stateFile));state.sessions[0].passkeyVerifiedAt=Date.now()-2*86400000;fs.writeFileSync(stateFile,JSON.stringify(state));
    await f.page.goto(f.origin+'/admin/security');await f.page.waitForURL(url=>url.pathname==='/admin-auth');await f.page.locator('#passkeyStep').waitFor({state:'visible'});
    assert.equal(await f.page.locator('#form').isHidden(),true);assert.equal(await f.page.locator('#adminPasskeyRemark').isHidden(),true);
    await f.page.locator('#passkeyContinue').click();await f.page.waitForURL(url=>url.pathname==='/admin/security');
    const renewed=JSON.parse(fs.readFileSync(stateFile)).sessions[0];assert.equal(renewed.totpVerifiedAt,before.totpVerifiedAt);assert.ok(renewed.passkeyVerifiedAt>state.sessions[0].passkeyVerifiedAt);
    await f.restart();await f.page.reload();await f.page.locator('#adminPasskeys').getByText('手机密码管理器',{exact:true}).waitFor();
    const second=await f.browser.newContext({ignoreHTTPSErrors:true,locale:'zh-CN'}),newPage=await second.newPage();await newPage.goto(f.origin+'/admin-auth');await newPage.locator('#token').fill(totp());await newPage.locator('#form button').click();await newPage.locator('#dbscFallback').waitFor({state:'visible'});await newPage.locator('#dbscFallback').click();
    assert.equal(await newPage.locator('#adminPasskeyRemark').isHidden(),true,'新设备已有管理员凭据时不能只用 TOTP 新注册');
    assert.equal((await f.apiFor(newPage).post(f.origin+'/api/admin/auth/passkey/register/options',{data:{remark:'forged'}})).status(),403);
    assert.equal((await f.apiFor(newPage).get(f.origin+'/api/admin/security/sessions')).status(),401);await second.close();
    const current=await (await f.api.get(f.origin+'/api/admin/security/sessions')).json();assert.equal((await f.api.delete(f.origin+'/api/admin/security/sessions/'+current.currentSessionId)).status(),200);
    assert.equal((await f.api.get(f.origin+'/api/admin/auth/status')).ok(),true);assert.equal((await (await f.api.get(f.origin+'/api/admin/auth/status')).json()).authenticated,false);
    await f.page.goto(f.origin+'/admin-auth');await f.page.locator('#form').waitFor({state:'visible'});assert.equal(await f.page.locator('#passkeyStep').isHidden(),true);
    await f.page.locator('#token').fill(totp());await f.page.locator('#form button').click();await f.page.locator('#passkeyStep').waitFor({state:'visible'});
    assert.equal(await f.page.locator('#dbscFallback').isHidden(),true,'已记住不支持时直接双因素，不反复等待 DBSC');assert.equal((await (await f.api.get(f.origin+'/api/admin/auth/status')).json()).authenticated,false);
    assert.deepEqual(errors,[]);
});
test('真实局域网 IP HTTP Chrome：TOTP 测试会话可登录，非 Secure 测试 Cookie 只在直连上下文使用',{timeout:30000},async t=>{
    const ip=Object.values(os.networkInterfaces()).flat().find(value=>value.family==='IPv4'&&!value.internal&&require('../server/admin-request-context').privateIp(value.address))?.address;
    if(!ip){t.skip('本机没有可用的私网 IPv4 接口，未冒充完成局域网测试');return;}
    const f=await fixture(t),page=await f.context.newPage();await page.goto('http://'+ip+':'+f.port+'/admin-auth?next=/admin/security');await page.locator('#token').fill(totp());await page.locator('#form button').click();await page.waitForURL(url=>url.pathname==='/admin/security');
    assert.equal(await page.locator('#passkeyStep').count(),0);const data=await (await page.request.get('http://'+ip+':'+f.port+'/api/admin/security/sessions')).json();assert.ok(data.sessions.some(value=>value.localNetworkTest&&value.localTest&&!value.dbscBound));
    const cookies=await f.context.cookies('http://'+ip+':'+f.port);assert.ok(cookies.some(value=>value.name==='tunnel_admin_local_test'&&!value.secure));
});
