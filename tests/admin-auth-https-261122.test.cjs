'use strict';

const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');

const html=fs.readFileSync(path.join(__dirname,'../pages/admin-auth.html'),'utf8');
const script=[...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)]
    .map(match=>match[1]).filter(value=>value.trim()).join('\n');
const httpsRequired='管理员 DBSC 登录需要证书有效的 HTTPS。请通过 HTTPS 地址重新打开；HTTP localhost 不会触发浏览器原生注册。';
const bindingFailed='DBSC 绑定未完成，尚未取得管理员权限。请确认浏览器支持并已启用原生 DBSC、设备安全密钥可用，以及 HTTPS 证书有效，再重新验证。';
const localTestNotice='本机 HTTP 测试模式：TOTP 验证后使用临时测试会话，未进行原生 DBSC 绑定。该会话仅适用于本机回环地址。';

// This executes the real login-page script with a simulated location, clock and
// HTTP responses. It verifies UI gating, not native Chrome DBSC registration.
async function page({protocol='https:',respond}={}){
    const elements=new Map(),requests=[],navigations=[],qrCodes=[];
    const element=id=>{
        if(!elements.has(id)){
            const classes=new Set(id==='setup'?['hidden']:[]);
            elements.set(id,{value:'',textContent:'',disabled:false,listeners:new Map(),
                classList:{add:name=>classes.add(name),remove:name=>classes.delete(name),contains:name=>classes.has(name)},
                addEventListener(name,handler){this.listeners.set(name,handler);},replaceChildren(){}});
        }
        return elements.get(id);
    };
    element('token').value='123456';
    const location={protocol,hostname:'localhost',search:'?next=%2Fadmin%3Ftab%3Dsecurity',
        replace:target=>navigations.push(target)};
    let now=0;
    const QRCode=function(_element,options){qrCodes.push(options);};
    QRCode.CorrectLevel={M:0};
    const context=vm.createContext({
        document:{getElementById:element,querySelector:selector=>{
            assert.equal(selector,'#form button');return element('submit');
        }},location,URLSearchParams,QRCode,isSecureContext:true,
        Date:{now:()=>now},clearTimeout(){},setTimeout(callback,delay){now+=delay;queueMicrotask(callback);return now;},
        fetch:async(url,options={})=>{
            requests.push({url,options,navigations:navigations.slice(),status:element('status').textContent});
            if(!respond)throw Error('Unexpected fetch: '+url);
            const response=respond(url,options,requests.length);
            return {ok:response.ok!==false,json:async()=>response.body};
        }
    });
    await vm.runInContext(script,context,{filename:'pages/admin-auth.html'});
    return {element,requests,navigations,qrCodes,location,
        submit:()=>element('form').listeners.get('submit')({preventDefault(){}})};
}

test('HTTP localhost is blocked unless the server permits local testing, even when isSecureContext is true',async()=>{
    const ui=await page({protocol:'http:',respond:()=>({body:{localHttpTestAllowed:false}})});
    assert.equal(ui.element('status').textContent,httpsRequired);
    assert.equal(ui.element('token').disabled,true);
    assert.equal(ui.element('issuer').disabled,true);
    assert.equal(ui.element('submit').disabled,true);
    assert.deepEqual(ui.requests.map(request=>request.url),['/api/admin/auth/status']);
    // A programmatic submit must also be blocked after DOM controls are enabled.
    ui.element('token').disabled=false;ui.element('submit').disabled=false;
    await ui.submit();
    assert.equal(ui.element('submit').disabled,true);
    assert.deepEqual(ui.requests.map(request=>request.url),['/api/admin/auth/status']);
    assert.deepEqual(ui.navigations,[]);
});

for(const setup of [false,true]){
    const mode=setup?'setup':'login';
    test(`server-approved HTTP ${mode} confirms the test session with GET status before navigating`,async()=>{
        const ui=await page({protocol:'http:',respond:(_url,_options,number)=>({body:number===1?
            {configured:!setup,authenticated:false,localHttpTestAllowed:true,setupAllowed:true,
                setup:{secret:'fixture-secret',uri:'otpauth://totp/fixture',issuer:'Fixture admin'}}:
            number===2?{authenticated:true,localTest:true,dbscRequired:false}:
                {authenticated:true,localHttpTestAllowed:true}})});
        assert.equal(ui.element('description').textContent,localTestNotice);
        assert.equal(ui.element('token').disabled,false);
        assert.equal(ui.element('submit').disabled,false);
        assert.equal(ui.qrCodes.length,setup?1:0);
        await ui.submit();
        assert.deepEqual(ui.requests.map(request=>request.url),[
            '/api/admin/auth/status',`/api/admin/auth/${mode}`,'/api/admin/auth/status'
        ]);
        assert.equal(ui.requests[1].options.method,'POST');
        assert.equal(ui.requests[2].options.method,undefined);
        assert.ok(ui.requests.every(request=>request.navigations.length===0));
        assert.equal(ui.requests[2].status,'正在验证...');
        assert.deepEqual(ui.navigations,['/admin?tab=security']);
    });

    test(`HTTPS ${mode} UI waits for authenticated status before navigating (simulated responses)`,async()=>{
        const ui=await page({respond:(_url,_options,number)=>({body:number===1?
            {configured:!setup,authenticated:false,setupAllowed:true,
                setup:{secret:'fixture-secret',uri:'otpauth://totp/fixture',issuer:'Fixture admin'}}:
            number===2?{pending:true,dbscRequired:true}:{authenticated:number===4}})});
        assert.equal(ui.element('submit').disabled,false);
        assert.equal(ui.qrCodes.length,setup?1:0);
        if(setup)assert.equal(ui.element('setup').classList.contains('hidden'),false);
        await ui.submit();
        assert.deepEqual(ui.requests.map(request=>request.url),[
            '/api/admin/auth/status',`/api/admin/auth/${mode}`,
            '/api/admin/auth/status','/api/admin/auth/status'
        ]);
        const submission=ui.requests[1];
        assert.equal(submission.options.method,'POST');
        assert.deepEqual(JSON.parse(submission.options.body),{token:'123456',issuer:setup?'Fixture admin':''});
        assert.ok(ui.requests.every(request=>request.navigations.length===0));
        assert.equal(ui.requests[2].status,'动态验证码已通过，正在等待浏览器完成 DBSC 安全设备绑定…');
        assert.deepEqual(ui.navigations,['/admin?tab=security']);
    });

    test(`${mode} submit rechecks HTTPS before sending any TOTP (simulated protocol change)`,async()=>{
        const ui=await page({respond:()=>({body:{configured:!setup,authenticated:false,setupAllowed:true,
            setup:{secret:'fixture-secret',uri:'otpauth://totp/fixture',issuer:'Fixture admin'}}})});
        assert.equal(ui.requests.length,1);
        ui.location.protocol='http:';
        await ui.submit();
        assert.equal(ui.requests.length,1);
        assert.equal(ui.element('status').textContent,httpsRequired);
        assert.equal(ui.element('submit').disabled,true);
        assert.deepEqual(ui.navigations,[]);
    });
}

test('HTTP POST authenticated=true cannot navigate without GET status confirming authentication',async()=>{
    const ui=await page({protocol:'http:',respond:(_url,_options,number)=>({body:number===1?
        {configured:true,authenticated:false,localHttpTestAllowed:true}:
        number===2?{authenticated:true,localTest:true,dbscRequired:false}:
            {authenticated:false,localHttpTestAllowed:true}})});
    await ui.submit();
    assert.equal(ui.requests.length,3);
    assert.deepEqual(ui.navigations,[]);
    assert.equal(ui.element('status').textContent,'验证失败，请稍后重试');
    assert.equal(ui.element('submit').disabled,false);
    assert.equal(ui.element('description').textContent,localTestNotice);
});

test('HTTP status permission must be an actual boolean and cannot enable another non-HTTPS scheme',async()=>{
    for(const [protocol,allowed] of [['http:','true'],['http:',undefined],['file:',true]]){
        const ui=await page({protocol,respond:()=>({body:{localHttpTestAllowed:allowed}})});
        await ui.submit();
        assert.equal(ui.requests.length,1);
        assert.equal(ui.element('submit').disabled,true);
        assert.equal(ui.element('status').textContent,httpsRequired);
        assert.deepEqual(ui.navigations,[]);
    }
});

test('HTTP test session confirmation also rechecks the server local-test permission',async()=>{
    const ui=await page({protocol:'http:',respond:(_url,_options,number)=>({body:number===1?
        {configured:true,authenticated:false,localHttpTestAllowed:true}:
        number===2?{authenticated:true,localTest:true,dbscRequired:false}:
            {authenticated:true,localHttpTestAllowed:false}})});
    await ui.submit();
    assert.equal(ui.requests.length,3);
    assert.deepEqual(ui.navigations,[]);
    assert.equal(ui.element('status').textContent,httpsRequired);
    assert.equal(ui.element('submit').disabled,true);
});

test('HTTPS binding timeout states that administrator access was not obtained (simulated clock)',async()=>{
    const ui=await page({respond:(_url,_options,number)=>({body:number===1?
        {configured:true,authenticated:false}:number===2?{pending:true,dbscRequired:true}:{authenticated:false}})});
    await ui.submit();
    assert.equal(ui.element('status').textContent,bindingFailed);
    assert.equal(ui.element('submit').disabled,false);
    assert.equal(ui.requests.filter(request=>request.options.method==='POST').length,1);
    assert.equal(ui.requests.filter(request=>request.url==='/api/admin/auth/status').length,81);
    assert.deepEqual(ui.navigations,[]);
});
