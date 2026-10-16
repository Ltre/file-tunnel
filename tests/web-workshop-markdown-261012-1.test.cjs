'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {webcrypto,createHash}=require('node:crypto');
const ROOT=path.join(__dirname,'..');
const read=file=>fs.readFileSync(path.join(ROOT,file),'utf8');
const data=text=>new TextEncoder().encode(text);
const text=entry=>new TextDecoder().decode(entry.data);
const file=(path,value='')=>({path,type:path.endsWith('/')?'application/x-directory':'text/plain',data:data(value)});
function tools(fetch,options={}){
    const window={crypto:options.crypto||webcrypto};
    vm.runInNewContext(read('client/web-workshop.js'),{window,Uint8Array,TextEncoder,TextDecoder,Blob,Map,Set,Date,Math,String,Number,Object,Array,RegExp,Error,Promise,URL,setTimeout,clearTimeout,AbortController,fetch,Worker:options.Worker});
    return window.WebWorkshop._test;
}
function support(){return tools().markdownSupportFiles.map(([name])=>({path:name,data:new Uint8Array(fs.readFileSync(path.join(ROOT,'client/vendor/web-markdown',name)))}));}

test('当前文件预览指定选中文件，生成的 Markdown 使用配套 HTML，不能误回默认入口',()=>{
    const {currentPreviewPath,prepareMarkdownPage}=tools();
    const files=[file('index.html','home'),file('中文/次页.html','other'),file('样式.css','body{}'),file('中文/')];
    assert.equal(currentPreviewPath(files,files[1]),'中文/次页.html');
    assert.equal(currentPreviewPath(files,files[2]),'样式.css');
    assert.throws(()=>currentPreviewPath(files,files[3]),/选择.*文件/);
    assert.throws(()=>currentPreviewPath(files,null),/选择.*文件/);
    const markdown=prepareMarkdownPage(files,files[3],support());
    assert.equal(currentPreviewPath(markdown.entries,file(markdown.markdownPath)),markdown.htmlPath);
});

test('编辑器新入口预览选中文件的未保存内容，旧预览继续选择默认入口',async()=>{
    const source=read('client/web-workshop.js'),api=tools(),textarea={value:''},toolbar={},previewCalls=[];let selectedPath;
    const nodes={'textarea':textarea,'.web-editor-toolbar':toolbar,'input[type=file]':{},'[data-web-hide-frame]':{},'[data-web-fullscreen]':{},'[data-web-save-status]':{}};
    const content={innerHTML:'',querySelector:selector=>nodes[selector]};
    const context=vm.createContext({content,activeDraft:null,editorSession:null,importMenuCleanup:null,document:{querySelector:()=>null},
        expandedPaths:new Set(),referenceBase:'',draftRevisions:new Map(),savedRevisions:new Map(),
        normalizeEntries:api.normalizeEntries,isDirectory:entry=>entry.path.endsWith('/'),isText:entry=>!entry.path.endsWith('/'),
        parentPath:value=>{const clean=value.replace(/\/$/,'');return clean.includes('/')?clean.slice(0,clean.lastIndexOf('/')+1):'';},escapeHtml:value=>value,
        renderTree:()=>'',bindTree(){},bindPackageName(){},revokePreviewUrls(){},setEditorSaveStatus(){},installMediaInsertion(){},commitPackageName(){},
        updateTextEntry:api.updateTextEntry,bytes:value=>value,TextDecoder,TextEncoder,Uint8Array,
        markdownPreviewPath:api.markdownPreviewPath,currentPreviewPath:api.currentPreviewPath,
        renderPreview:async(files,_name,_back,_actions,path='')=>previewCalls.push({path,body:text(files.find(f=>f.path===selectedPath))}),
        showError:error=>{throw error;}});
    const commit=source.slice(source.indexOf('    function commitEditorBuffer('),source.indexOf('    function saveDraft('));
    const render=source.slice(source.indexOf('function renderEditor('),source.indexOf('    async function renderPreview('));
    vm.runInContext(commit+'\n'+render+'\nthis.renderEditor=renderEditor;',context);
    const generated=api.prepareMarkdownPage([file('index.html','home'),file('子目录/次页.html','old')],file('子目录/'),support());
    const draft={id:'draft',name:'网页',files:generated.entries};
    for(selectedPath of ['子目录/次页.html',generated.markdownPath,generated.htmlPath]){
        previewCalls.length=0;context.renderEditor(draft,selectedPath);
        assert.match(content.innerHTML,/preview-current[^>]*>预览当前编辑文件<\/button><button data-editor-action="preview">/);
        // Preserve the Markdown loader metadata when editing its HTML carrier.
        textarea.value+='\n尚未保存的正文';
        await toolbar.onclick({target:{dataset:{editorAction:'preview-current'}}});
        assert.equal(previewCalls[0].path,selectedPath===generated.markdownPath?generated.htmlPath:selectedPath);assert.match(previewCalls[0].body,/尚未保存/);
        await toolbar.onclick({target:{dataset:{editorAction:'preview'}}});assert.equal(previewCalls[1].path,'','ZIP preview must ignore the selected file, including generated Markdown');
    }
});

test('Markdown 在选中目录、文件父目录或根创建，多个页面共享一套完整资源',()=>{
    const {prepareMarkdownPage}=tools(),resources=support();
    const first=prepareMarkdownPage([file('index.html'),file('中文/日本語/')],file('中文/日本語/'),resources);
    assert.equal(first.markdownPath,'中文/日本語/markdown.md');
    const second=prepareMarkdownPage(first.entries,file(first.markdownPath),resources);
    assert.equal(second.markdownPath,'中文/日本語/markdown_1.md');
    assert.equal(second.bundleDirectory,first.bundleDirectory);
    const third=prepareMarkdownPage(second.entries,null,resources);
    assert.equal(third.markdownPath,'markdown.md');
    assert.equal(third.entries.filter(entry=>entry.path.endsWith('marked-18.0.14.umd.js')).length,1);
    assert.equal(third.entries.filter(entry=>entry.path.endsWith('THIRD-PARTY-LICENSES.txt')).length,1);
    assert.equal(third.entries.find(entry=>entry.path==='index.html').data.length,0);
    assert.ok(third.entries.some(entry=>entry.path==='assets/'));
});

test('任一 HTML、MD 名称和目录占用均整对递增，避免大小写冲突且不覆盖',()=>{
    const {prepareMarkdownPage}=tools(),original=[file('markdown.html','old'),file('MARKDOWN_1.MD','another'),file('markdown_2.html/')];
    const result=prepareMarkdownPage(original,null,support());
    assert.equal(result.htmlPath,'markdown_3.html');
    assert.equal(result.markdownPath,'markdown_3.md');
    assert.equal(text(result.entries.find(entry=>entry.path==='markdown.html')),'old');
    assert.equal(original.length,3);
});

test('公共资源目录冲突及被修改的旧支持资源不覆盖，完整路径层级遵循 20 层',()=>{
    const {prepareMarkdownPage}=tools();
    assert.throws(()=>prepareMarkdownPage([file('assets','keep me')],null,support()),/assets.*同名文件/);
    const collision=[file('assets/drop2tunnel-markdown-v1/marked-18.0.14.umd.js','custom')];
    const first=prepareMarkdownPage(collision,null,support());
    assert.equal(first.bundleDirectory,'assets/drop2tunnel-markdown-v1-1/');
    assert.equal(text(first.entries.find(entry=>entry.path===collision[0].path)),'custom');
    const modified=first.entries.map(entry=>entry.path===first.bundleDirectory+'markdown-page.css'?{...entry,data:data('custom css')}:entry);
    const second=prepareMarkdownPage(modified,null,support());
    assert.equal(second.bundleDirectory,'assets/drop2tunnel-markdown-v1-2/');
    assert.equal(text(second.entries.find(entry=>entry.path===first.bundleDirectory+'markdown-page.css')),'custom css');
    const allowed='层/'.repeat(20),blocked=allowed+'21/';
    assert.equal(prepareMarkdownPage([file(allowed)],file(allowed),support()).markdownPath,allowed+'markdown.md');
    assert.throws(()=>prepareMarkdownPage([file(blocked)],file(blocked),support()),/20 层/);
});

test('生成页脚本完整闭合、以相对路径引用资源，移动 MD 后仅更新已确认的源文件 href',()=>{
    const {prepareMarkdownPage,renameEntry,markdownPreviewPath}=tools();
    const result=prepareMarkdownPage([file('日本語/中文/'),file('index.html','<!doctype html>old')],file('日本語/中文/'),support());
    const html=text(result.entries.find(entry=>entry.path===result.htmlPath));
    assert.equal((html.match(/<script /g)||[]).length,3);
    assert.equal((html.match(/<\/script>/g)||[]).length,3);
    assert.match(html,/href="markdown.md"/);
    assert.match(html,/src="\.\.\/\.\.\/assets\/drop2tunnel-markdown-v1\/marked-18.0.14.umd.js"/);
    assert.doesNotMatch(html,/https?:\/\/|cdn\./);
    assert.equal(markdownPreviewPath(result.entries,file(result.markdownPath)),result.htmlPath);
    assert.equal(markdownPreviewPath(result.entries,file(result.htmlPath)),result.htmlPath);
    assert.equal(markdownPreviewPath(result.entries,file('index.html')),'');
    const renamed=renameEntry(result.entries,result.markdownPath,'文档.md');
    assert.match(text(renamed.entries.find(entry=>entry.path===result.htmlPath)),/href="%E6%96%87%E6%A1%A3.md"/);
});

test('实际捆绑的 Marked 支持表格、列表、代码块和非 ASCII 资源引用',()=>{
    const marked=require('../client/vendor/web-markdown/marked-18.0.14.umd.js');
    const output=marked.parse('# 中文\n\n![封面](图片/猫.png)\n\n|列|值|\n|---|---|\n|甲|乙|\n\n- [x] 完成\n\n```js\nalert("code")\n```');
    assert.match(output,/<h1>中文<\/h1>/);
    assert.match(output,/<table>/);
    assert.match(output,/<input.*checked.*type="checkbox"/);
    assert.match(decodeURI(output),/src="图片\/猫.png"/);
    assert.match(output,/class="language-js"/);
});

test('支持资源按固定哈希检查，一次加载可复用；失败后可重试且不接受 HTML 错页',async()=>{
    let calls=0,fail=true;
    const api=tools(async url=>{calls++;const name=url.split('/').at(-1);const actual=fs.readFileSync(path.join(ROOT,'client/vendor/web-markdown',name));return {ok:true,arrayBuffer:async()=>fail&&name==='markdown-page.css'?data('<html>bad</html>').buffer:actual.buffer.slice(actual.byteOffset,actual.byteOffset+actual.byteLength)};});
    await assert.rejects(api.readMarkdownSupport(),/版本不一致/);
    fail=false;
    const result=await api.readMarkdownSupport();
    assert.equal(result.length,5);
    assert.equal(calls,10);
    await api.readMarkdownSupport();assert.equal(calls,10);
    for(const [name,hash] of api.markdownSupportFiles)assert.equal(createHash('sha256').update(fs.readFileSync(path.join(ROOT,'client/vendor/web-markdown',name))).digest('hex'),hash);
});

test('Markdown 加载器将图片、链接相对于实际 MD URL 解析，渲染后清理 Loading',async()=>{
    const source={getAttribute:()=>encodeURI('../资料/文档.md')};
    const nodes=[
        {tagName:'IMG',attrs:{src:'图片/猫.png'}},
        {tagName:'A',attrs:{href:'../其它页.html',target:'_blank'}},
        {tagName:'A',attrs:{href:'#本页锚点'}},
        {tagName:'SOURCE',attrs:{src:'音频.m4a'}}
    ].map(node=>({...node,hasAttribute(name){return name in this.attrs;},getAttribute(name){return this.attrs[name];},setAttribute(name,value){this.attrs[name]=value;},removeAttribute(name){delete this.attrs[name];}}));
    let fetched='',sanitized='',content=null,busy=true;
    const fragment={querySelectorAll:()=>nodes};
    const output={replaceChildren(value){content=value;},removeAttribute(){busy=false;},querySelector:()=>({textContent:'测试页面'}),classList:{add(){}}};
    const document={title:'',querySelector:selector=>selector==='[data-markdown-source]'?source:output};
    vm.runInNewContext(read('client/vendor/web-markdown/markdown-page.js'),{window:{marked:{parse:value=>value},DOMPurify:{sanitize(value){sanitized=value;return fragment;}}},document,location:{href:'https://example.test/web-zip-runtime/test/pages/markdown.html'},URL,fetch:async url=>{fetched=url.href;return {ok:true,text:async()=>'<p>正文</p>'};}});
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(fetched,'https://example.test/web-zip-runtime/test/%E8%B5%84%E6%96%99/%E6%96%87%E6%A1%A3.md');
    assert.equal(nodes[0].attrs.src,'https://example.test/web-zip-runtime/test/%E8%B5%84%E6%96%99/%E5%9B%BE%E7%89%87/%E7%8C%AB.png');
    assert.equal(nodes[1].attrs.href,'https://example.test/web-zip-runtime/test/%E5%85%B6%E5%AE%83%E9%A1%B5.html');
    assert.equal(nodes[1].attrs.rel,'noopener noreferrer');
    assert.equal(nodes[2].attrs.href,'#本页锚点');
    assert.match(nodes[3].attrs.src,/%E8%B5%84%E6%96%99\/%E9%9F%B3%E9%A2%91.m4a$/);
    assert.equal(sanitized,'<p>正文</p>');assert.equal(content,fragment);assert.equal(busy,false);assert.equal(document.title,'测试页面');
});

test('MD 文件缺失时显示清晰读取错误；部署固定路径保留完整资源',async()=>{
    let busy=true,failed=false;
    const output={textContent:'',removeAttribute(){busy=false;},classList:{add(){failed=true;}}};
    vm.runInNewContext(read('client/vendor/web-markdown/markdown-page.js'),{window:{marked:{},DOMPurify:{}},document:{querySelector:selector=>selector==='[data-markdown-source]'?{getAttribute:()=>'/missing.md'}:output},location:{href:'https://example.test/page.html'},URL,fetch:async()=>({ok:false,status:404})});
    await new Promise(resolve=>setImmediate(resolve));
    assert.match(output.textContent,/HTTP 404/);assert.equal(busy,false);assert.equal(failed,true);
    assert.match(read('tools/deploy/build.mjs'),/copyDirRelative\('client\/vendor\/web-markdown', outRoot\)/);
});

test('压缩部署重建 Service Worker 时仍缓存原字节的 Markdown 支持资源',async()=>{
    const source=read('tools/deploy/build.mjs');
    const fixed=source.match(/const MARKDOWN_SUPPORT_ASSETS = \[[\s\S]*?\];/)?.[0];
    const builder=source.match(/async function buildServiceWorker\([\s\S]*?\n}\n/)?.[0];
    assert.ok(fixed&&builder);
    let written='';
    const context={ROOT,fs:{readFile:async()=>read('service-worker.js'),writeFile:async(_path,value)=>{written=value;}},path,
        PAGE_ROUTES:{'index.html':['/','/index.html','/disk']},replaceScriptReferences:value=>value,sizeStat:()=>({})};
    vm.runInNewContext(fixed+'\n'+builder+'\nglobalThis.buildWorker = buildServiceWorker;',context);
    const result=await context.buildWorker('release','test-build',{'client/web-workshop.js':'/assets/workshop.hash.js'},{});
    for(const [name] of tools().markdownSupportFiles)assert.ok(result.appShell.includes('/client/vendor/web-markdown/'+name),name);
    assert.match(written,/client\/vendor\/web-markdown\/marked-18\.0\.14\.umd\.js/);
    assert.match(written,/instant-tunnel-test-build/);
});

test('部署核验只允许精确 Markdown 固定路径，不放宽其它源 JS 检查',()=>{
    const source=read('tools/deploy/verify.mjs');
    const fixed=source.match(/const MARKDOWN_SUPPORT_ASSETS = \[[\s\S]*?\];/)?.[0];
    const strip=source.match(/function stripBundledMarkdownPaths\([\s\S]*?\n}\n/)?.[0];
    assert.ok(fixed&&strip);
    const context={};
    vm.runInNewContext(fixed+'\n'+strip+'\nglobalThis.strip = stripBundledMarkdownPaths;',context);
    const assets=tools().markdownSupportFiles.map(([name])=>'/client/vendor/web-markdown/'+name);
    assert.doesNotMatch(context.strip(assets.map(JSON.stringify).join('\n')),/\/client\//);
    assert.match(context.strip(assets.map(JSON.stringify).join('\n')+'\n/client/unbundled.js'),/\/client\/unbundled.js/);
    assert.match(context.strip('/client/vendor/web-markdown/unknown.js'),/\/client\//);
    assert.match(context.strip(JSON.stringify(assets[0]+'.unknown')),/\/client\//);
    assert.match(source,/!original\.equals\(deployed\)/);
});

test('Android HTTP origin without Web Crypto uses the existing SHA-256 worker and still checks all support bytes',async()=>{
    let terminated=0;const {Sha256}=require('../client/disk-content-hash-worker');
    class Worker{constructor(url){assert.equal(url,'/client/disk-content-hash-worker.js');}postMessage({file}){file.arrayBuffer().then(data=>this.onmessage({data:{sha256:new Sha256().update(new Uint8Array(data)).digest()}}));}terminate(){terminated++;}}
    const api=tools(async url=>({ok:true,arrayBuffer:async()=>{const file=fs.readFileSync(path.join(ROOT,url.slice(1)));return file.buffer.slice(file.byteOffset,file.byteOffset+file.byteLength);}}),{crypto:{},Worker});
    assert.equal((await api.readMarkdownSupport()).length,5);assert.equal(terminated,5);
});
