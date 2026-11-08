'use strict';
const {test,before,after}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {chromium}=require(path.join(os.homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));
const root=path.resolve(__dirname,'..');let browser;
before(async()=>{browser=await chromium.launch({channel:'chrome',headless:true});});after(async()=>{await browser?.close();});
async function fixture({locale='ja-JP',preference}={}){
    const context=await browser.newContext({locale});await context.addInitScript(value=>{if(value)localStorage.setItem('drop2tunnel.language',value);},preference);
    const page=await context.newPage();await page.route('http://i18n.test/**',route=>{const url=new URL(route.request().url());if(url.pathname.startsWith('/client/'))return route.fulfill({contentType:'application/javascript',body:fs.readFileSync(path.join(root,url.pathname),'utf8')});return route.fulfill({contentType:'text/html',body:'<!doctype html><html translate="no"><head><meta charset="utf-8"></head><body><select id="appLanguageSelect"></select><h1>加入数据隧道</h1><button id="scan">扫描隧道码</button><p id="or">或进入已加入的隧道</p><button id="create">我没有暗号，创建一个隧道</button><p id="error">没有找到该传输隧道，或它已经被删除。</p><div id="system">设置</div><code id="code">设置</code><pre id="trace">来源隧道尚未获得访问权</pre><span class="telegram-drive-item-name" title="设置" id="filename">设置</span><p class="message-content" id="authored">扫描隧道码</p><button data-action="设置" id="action">扫描隧道码</button><script src="/client/i18n-catalog.js"></script><script src="/client/sns-post-i18n.js"></script><script src="/client/streaming-i18n.js"></script><script src="/client/i18n.js"></script></body></html>'});});await page.goto('http://i18n.test/');return{page,close:()=>context.close()};
}
test('Japanese route labels use the unified native catalog and never translate authored content or program identifiers',async()=>{
    const f=await fixture();try{
        const {page}=f;assert.equal(await page.locator('#appLanguageSelect').inputValue(),'system');assert.equal(await page.locator('h1').textContent(),'データトンネルに参加');assert.equal(await page.locator('#scan').textContent(),'トンネルコードをスキャン');assert.equal(await page.locator('#or').textContent(),'または参加済みのトンネルに入る');assert.equal(await page.locator('#create').textContent(),'コードがありません。トンネルを作成');assert.equal(await page.locator('#error').textContent(),'転送トンネルが見つからないか、削除されています。');
        for(const [id,value]of [['code','设置'],['filename','设置'],['authored','扫描隧道码'],['trace','来源隧道尚未获得访问权']])assert.equal(await page.locator('#'+id).textContent(),value);
        assert.equal(await page.locator('#filename').getAttribute('title'),'设置');assert.equal(await page.locator('#action').getAttribute('data-action'),'设置');
    }finally{await f.close();}
});
test('an unsupported system locale renders English while retaining the translated system-language preference',async()=>{
    const f=await fixture({locale:'pl-PL'});try{const {page}=f;assert.equal(await page.locator('h1').textContent(),'Join a data tunnel');assert.equal(await page.locator('#appLanguageSelect').inputValue(),'system');assert.equal(await page.locator('option[value="system"]').textContent(),'Use system language');assert.equal(await page.evaluate(()=>localStorage.getItem('drop2tunnel.language')),null);assert.equal(await page.locator('html').getAttribute('lang'),'en');}finally{await f.close();}
});
test('explicit preferences win over system locale and switching to system stays distinct from English',async()=>{
    const f=await fixture({locale:'en-US',preference:'ja'});try{const {page}=f;assert.equal(await page.locator('h1').textContent(),'データトンネルに参加');assert.equal(await page.locator('#appLanguageSelect').inputValue(),'ja');await page.locator('#appLanguageSelect').selectOption('system');assert.equal(await page.locator('h1').textContent(),'Join a data tunnel');assert.equal(await page.evaluate(()=>localStorage.getItem('drop2tunnel.language')),'system');await page.locator('#appLanguageSelect').selectOption('zh-Hans');assert.equal(await page.locator('h1').textContent(),'加入数据隧道');assert.equal(await page.locator('#appLanguageSelect').inputValue(),'zh-Hans');}finally{await f.close();}
});

test('system follows the browser current language before the alternate content-language list, including mobile layout',async()=>{
    const f=await fixture({locale:'en-US'});try{const {page}=f;await page.setViewportSize({width:390,height:844});
        await page.evaluate(()=>{Object.defineProperty(navigator,'languages',{configurable:true,value:['zh-CN','en-US']});TunnelI18n.setLanguage('system');});
        assert.equal(await page.locator('html').getAttribute('lang'),'en');assert.equal(await page.locator('h1').textContent(),'Join a data tunnel');assert.equal(await page.locator('#appLanguageSelect').inputValue(),'system');assert.equal(await page.locator('option[value="system"]').textContent(),'Use system language');
        await page.locator('#appLanguageSelect').selectOption('ja');assert.equal(await page.locator('h1').textContent(),'データトンネルに参加');
    }finally{await f.close();}
});
test('every supported language has native system and route entries with one runtime after compatibility scripts load',async()=>{
    const f=await fixture();try{const {page}=f;const result=await page.evaluate(()=>{const missing=[];for(const [language]of TunnelI18n.languages){if(language==='zh-Hans')continue;for(const key of ['使用系统语言','加入数据隧道','扫描隧道码','我没有暗号，创建一个隧道','没有找到该传输隧道，或它已经被删除。'])if(!Drop2TunnelI18nCatalog[key]?.[language])missing.push(language+':'+key);}return missing;});assert.deepEqual(result,[]);}finally{await f.close();}
});
test('dynamic labels retain raw parameters and can switch language after being formatted',async()=>{
    const f=await fixture();try{const {page}=f;const raw='sendFile:{权限字段}';await page.evaluate(raw=>{const node=document.createElement('p');node.id='formatted';node.textContent=TunnelI18n.format('已确认转发 {0} / {1} 条记录',raw,20);document.body.append(node);},raw);assert.ok((await page.locator('#formatted').textContent()).includes(raw));await page.locator('#appLanguageSelect').selectOption('en');assert.equal(await page.locator('#formatted').textContent(),'Confirmed '+raw+' / 20 forwarded records');}finally{await f.close();}
});

test('central action-slot rules translate system actions and retain a destination whose name equals a system label',async()=>{
    const f=await fixture();try{const {page}=f;await page.locator('#appLanguageSelect').selectOption('en');
        const result=await page.evaluate(()=>({formatted:TunnelI18n.format('已{0} {1} 项到“{2}”','移动',2,'设置'),dynamic:TunnelI18n.t('已移动 2 项到“设置”')}));
        assert.equal(result.formatted,'Move: 2 items to “设置”');assert.equal(result.dynamic,result.formatted);
    }finally{await f.close();}
});

test('dynamic source names and diagnostic payloads remain raw even when they equal a system label',async()=>{
    const f=await fixture({locale:'en-US'});try{
        const values=await f.page.evaluate(()=>['解析失败：设置','获取SNS媒体失败：设置','来源为 设置 获取','已配置 · 设置'].map(text=>TunnelI18n.t(text)));
        assert.deepEqual(values,['Parsing failed: 设置','SNS media retrieval failed: 设置','Fetched from 设置 ','Configured · 设置']);
    }finally{await f.close();}
});

test('central UI error composition translates explanations and request captions while retaining codes, paths and IDs',async()=>{
    const f=await fixture({locale:'en-US'});try{
        await f.page.addScriptTag({url:'http://i18n.test/client/disk-error-messages.js'});
        const result=await f.page.evaluate(()=>{
            const error=DiskErrorMessages.format({code:'CONTENT_COPY_SCOPE_INVALID',errorDetails:{requestId:'trace-设置'}});
            return {error,translated:TunnelI18n.t(error),position:TunnelI18n.t('位置“/设置”：'+DiskErrorMessages.describe('DISK_NAME_CONFLICT'))};
        });
        assert.equal(result.translated,"The source and destination scopes do not meet this operation's requirements. Choose them again. [CONTENT_COPY_SCOPE_INVALID] · Request ID: trace-设置");
        assert.equal(result.position,'Location “/设置”: The destination name is used by a file, folder, mount or active upload. Rename it or choose another location.');
    }finally{await f.close();}
});

test('system error action labels translate but error payloads and tooltip parameters remain unchanged',async()=>{
    const f=await fixture();try{const {page}=f;
        const result=await page.evaluate(()=>{const error='设置/转发失败/HTTP_429';return [TunnelI18n.t('转发失败：'+error),TunnelI18n.t('unknown-action失败：'+error)];});
        assert.equal(result[0],'転送に失敗：设置/转发失败/HTTP_429');assert.equal(result[1],'unknown-action失败：设置/转发失败/HTTP_429');
        assert.equal(await page.evaluate(()=>TunnelI18n.format('资源准备失败：{0}','HTTP_429')),'リソースの準備に失敗：HTTP_429');
        await page.evaluate(()=>{const button=document.createElement('button');button.id='dynamic-tip';button.title='文件：用户设置.log';document.body.append(button);});
        await page.waitForFunction(()=>document.getElementById('dynamic-tip').title==='ファイル：用户设置.log');await page.locator('#appLanguageSelect').selectOption('en');assert.equal(await page.locator('#dynamic-tip').getAttribute('title'),'File: 用户设置.log');
    }finally{await f.close();}
});

test('a new unknown status or filename replaces the old translated value rather than being overwritten by stale source text',async()=>{
    const f=await fixture();try{const {page}=f;
        await page.evaluate(()=>{const node=document.createElement('button');node.id='reused-label';node.textContent='保存';node.title='文件预览';document.body.append(node);});
        await page.waitForFunction(()=>document.getElementById('reused-label').title==='ファイルプレビュー');
        await page.evaluate(()=>{const node=document.getElementById('reused-label');node.firstChild.nodeValue='task-finished HTTP_429';node.title='user-file.log';});
        await page.waitForTimeout(40);assert.equal(await page.locator('#reused-label').textContent(),'task-finished HTTP_429');assert.equal(await page.locator('#reused-label').getAttribute('title'),'user-file.log');
        await page.locator('#appLanguageSelect').selectOption('en');assert.equal(await page.locator('#reused-label').textContent(),'task-finished HTTP_429');assert.equal(await page.locator('#reused-label').getAttribute('title'),'user-file.log');
        await page.evaluate(()=>{for(const className of ['web-tree-name','web-draft-title']){const node=document.createElement('div');node.className=className;if(className==='web-draft-title')node.innerHTML='<strong>保存</strong>';else node.textContent='保存';document.body.append(node);}});await page.waitForTimeout(30);assert.equal(await page.locator('.web-tree-name').textContent(),'保存');assert.equal(await page.locator('.web-draft-title strong').textContent(),'保存');
    }finally{await f.close();}
});

test('textarea and editor labels localize while document contents, filenames and technical previews remain raw',async()=>{
    const f=await fixture();try{const {page}=f;
        await page.evaluate(()=>{const area=document.createElement('textarea');area.id='raw-editor';area.placeholder='文件预览';area.value='保存';document.body.append(area);const editable=document.createElement('div');editable.id='editable';editable.contentEditable='true';editable.setAttribute('aria-label','选择在线设备');editable.textContent='保存';document.body.append(editable);for(const name of ['disk-editor-preview','file-preview-title-name','remote-preview-file-name']){const node=document.createElement('div');node.className=name;node.textContent='保存';node.title='保存';document.body.append(node);}});
        await page.waitForFunction(()=>document.getElementById('raw-editor').placeholder==='ファイルプレビュー');assert.equal(await page.locator('#raw-editor').inputValue(),'保存');assert.equal(await page.locator('#editable').getAttribute('aria-label'),'オンラインの端末を選択');assert.equal(await page.locator('#editable').textContent(),'保存');
        await page.locator('#editable').evaluate(node=>node.innerHTML='<span id="authored-title" title="保存">保存</span>');await page.waitForTimeout(30);assert.equal(await page.locator('#authored-title').getAttribute('title'),'保存');
        for(const name of ['disk-editor-preview','file-preview-title-name','remote-preview-file-name']){assert.equal(await page.locator('.'+name).textContent(),'保存');assert.equal(await page.locator('.'+name).getAttribute('title'),'保存');}
    }finally{await f.close();}
});
