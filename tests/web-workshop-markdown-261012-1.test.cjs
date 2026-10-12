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
function tools(fetch){
    const window={crypto:webcrypto};
    vm.runInNewContext(read('client/web-workshop.js'),{window,Uint8Array,TextEncoder,TextDecoder,Blob,Map,Set,Date,Math,String,Number,Object,Array,RegExp,Error,Promise,URL,setTimeout,clearTimeout,AbortController,fetch});
    return window.WebWorkshop._test;
}
function support(){return tools().markdownSupportFiles.map(([name])=>({path:name,data:new Uint8Array(fs.readFileSync(path.join(ROOT,'client/vendor/web-markdown',name)))}));}

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
