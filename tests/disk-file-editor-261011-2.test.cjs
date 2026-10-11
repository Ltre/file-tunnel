'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const script=fs.readFileSync('client/disk-file-editor.js','utf8');
function model(){const window={};vm.runInNewContext(script,{window,Blob,Uint8Array,TextEncoder,TextDecoder});return window.DiskFileEditor._test;}
class Element {
    constructor(tag){this.tagName=tag;this.children=[];this.value='';this.selectionStart=this.selectionEnd=0;this.scrollTop=0;this.scrollHeight=1000;this.clientHeight=100;this.listeners=new Map();this.style={setProperty(){}};this.classList={toggle(){}};}
    append(...children){this.children.push(...children);}add(child){this.children.push(child);}setAttribute(){}closest(){return null;}
    addEventListener(type,listener){if(!this.listeners.has(type))this.listeners.set(type,new Set());this.listeners.get(type).add(listener);}
    removeEventListener(type,listener){this.listeners.get(type)?.delete(listener);}emit(type){for(const listener of this.listeners.get(type)||[])listener();}
    setSelectionRange(start,end){this.selectionStart=start;this.selectionEnd=end;}
}
async function editor({item,source=new Blob([]),run}){
    const saved=[],clipboard=[],window={addEventListener(){},removeEventListener(){},DiskClient:{context:()=>({diskSpace:'测试分区'}),read:async()=>source,raw:async(route,options)=>{saved.push({route,options});return {ok:true};}}};
    vm.runInNewContext(script,{window,innerHeight:700,Blob,Uint8Array,TextEncoder,TextDecoder,document:{createElement:tag=>new Element(tag)},Option:class{constructor(text,value){this.text=text;this.value=value;}},setTimeout,clearTimeout,navigator:{clipboard:{writeText:async text=>clipboard.push(text)}}});
    await window.DiskFileEditor.open({item,path:'新目录',openDialog:async options=>{
        const body=options.body,[name,mode,toolbar,,panes,state]=body.children,[edit,preview]=panes.children,offset=toolbar.children.find(n=>n.tagName==='input');
        const click=async label=>toolbar.children.find(n=>n.textContent===label).onclick();
        const changeMode=async value=>{mode.value=value;await mode.onchange();};
        await run({name,mode,edit,preview,offset,state,click,changeMode,save:()=>options.validate(),saved,clipboard});return null;
    }});
    return {saved,clipboard};
}
async function waitLoading(edit){for(let i=0;i<100&&edit.disabled;i++)await new Promise(resolve=>setImmediate(resolve));assert.equal(edit.disabled,false);}

test('各模式窗口至少覆盖 100KiB 原字节，UTF-8/CRLF 边界和尾段正确',async()=>{
    const {PAGE,HEX_PAGE,Document}=model();assert.equal(PAGE,102400);assert.equal(HEX_PAGE,102400);
    const bytes=new Uint8Array(250000);for(let i=0;i<bytes.length;i++)bytes[i]=i%256;
    const hex=new Document(new Blob([bytes]));const first=await hex.window(0,true);assert.equal(first.end-first.start,102400);assert.equal(first.raw.replace(/\s/g,'').length,204800);
    const second=await hex.window(first.end,true);assert.equal(second.start,102400);assert.equal(second.end-second.start,102400);
    const tail=await hex.window(second.end,true);assert.equal(tail.end-tail.start,45200);assert.deepEqual([...model().bytesFromHex(tail.text)],Array.from(bytes.slice(second.end)));
    const original='\uFEFF'+'x'.repeat(PAGE-4)+'中😀\r\n'+'后'.repeat(PAGE),doc=new Document(new Blob([original]));
    const text=await doc.window(0);assert.ok(text.end>=PAGE);assert.ok(text.end<=PAGE+4);assert.ok(text.raw.startsWith('\uFEFF'));assert.ok(!text.raw.includes('�'));
    const next=await doc.window(text.end);assert.ok(next.end-next.start>=PAGE);assert.ok(!next.raw.includes('�'));assert.equal((await doc.window(doc.blob.size)).raw,'');
});

test('双栏按滚动比例双向同步，消耗程序事件，短预览和切段不会反复跳动',()=>{
    const {syncScrollablePanes}=model(),edit=new Element('textarea'),preview=new Element('div');edit.scrollHeight=1100;preview.scrollHeight=2100;
    let enabled=true;const sync=syncScrollablePanes(edit,preview,()=>enabled);
    edit.scrollTop=250;edit.emit('scroll');assert.equal(preview.scrollTop,500);
    // An asynchronous scroll event caused by the assignment must not echo back.
    preview.emit('scroll');assert.equal(edit.scrollTop,250);
    preview.scrollTop=1500;preview.emit('scroll');assert.equal(edit.scrollTop,750);edit.emit('scroll');assert.equal(preview.scrollTop,1500);
    // User movement takes precedence if it differs from the pending programmatic position.
    edit.scrollTop=100;edit.emit('scroll');assert.equal(preview.scrollTop,200);
    sync.reset();assert.equal(edit.scrollTop,0);assert.equal(preview.scrollTop,0);edit.emit('scroll');preview.emit('scroll');assert.equal(edit.scrollTop,0);
    preview.scrollHeight=preview.clientHeight;edit.scrollTop=200;edit.emit('scroll');assert.equal(preview.scrollTop,0);preview.emit('scroll');assert.equal(edit.scrollTop,200);
    enabled=false;preview.scrollHeight=2100;edit.scrollTop=500;edit.emit('scroll');assert.equal(preview.scrollTop,0);
    sync.destroy();enabled=true;edit.scrollTop=800;edit.emit('scroll');assert.equal(preview.scrollTop,0);assert.equal(edit.listeners.get('scroll').size,0);assert.equal(preview.listeners.get('scroll').size,0);
});

test('新建默认 UTF-8 无 BOM，切换 Markdown/Hex 后保存保留已输入内容',async()=>{
    const input='新建内容 😀\n# 标题\n结尾';
    await editor({run:async({name,mode,edit,preview,changeMode,save,saved})=>{
        assert.equal(mode.value,'text');assert.equal(name.value,'新建文件.txt');assert.equal(edit.value,'');assert.equal(preview.hidden,true);
        edit.value=input;edit.oninput();await changeMode('markdown');assert.equal(edit.value,input);assert.match(preview.innerHTML,/<h1>标题<\/h1>/);
        await changeMode('hex');assert.equal(mode.value,'hex');assert.deepEqual([...model().bytesFromHex(edit.value)],Array.from(Buffer.from(input)));
        await changeMode('text');assert.equal(edit.value,input);await save();
        const body=Buffer.from(await saved[0].options.body.arrayBuffer());assert.equal(body.toString('utf8'),input);assert.notDeepEqual([...body.subarray(0,3)],[0xef,0xbb,0xbf]);
        assert.match(saved[0].route,/^\/files\/content\?folderPath=/);assert.equal(saved[0].options.method,'POST');assert.equal(saved[0].options.headers['X-Disk-File-Type'],'text/plain;charset=utf-8');assert.equal(saved[0].options.headers['X-Disk-Expected-Version'],'0');
    }});
});

test('二进制追加 AA 后拒绝非法 UTF-8 切换，原字节及并发版本不丢失',async()=>{
    const original=Uint8Array.from([0x89,0x50,0x4e,0x47,0x00,0xff]),source=new Blob([original]);
    await editor({item:{id:'image-logical',name:'图片.png',type:'image/png',size:source.size,logicalContentVersion:9},source,run:async({mode,edit,state,changeMode,save,saved})=>{
        assert.equal(mode.value,'hex');edit.value+=' aa';edit.oninput();
        await changeMode('markdown');assert.equal(mode.value,'hex');assert.match(state.textContent,/不是有效 UTF-8/);assert.ok(edit.value.endsWith('aa'));
        await changeMode('text');assert.equal(mode.value,'hex');assert.ok(edit.value.endsWith('aa'));await save();
        assert.deepEqual([...new Uint8Array(await saved[0].options.body.arrayBuffer())],[...original,0xaa]);assert.equal(saved[0].options.headers['X-Disk-Expected-Version'],'9');assert.equal(saved[0].options.headers['X-Disk-File-Type'],'image/png');
    }});
});

test('跨 100KiB 段编辑、整段复制、大粘贴与撤销重做保持完整正文和 BOM/CRLF',async()=>{
    const {PAGE}=model(),original='\uFEFFBEGIN\r\n'+'x'.repeat(PAGE*3)+'\r\nEND',source=new Blob([original]);source.arrayBuffer=()=>{throw new Error('不可整份读取 ArrayBuffer');};
    await editor({item:{id:'multi-window',name:'多段.md',size:source.size,logicalContentVersion:2},source,run:async({mode,edit,preview,offset,click,changeMode,save,saved,clipboard})=>{
        assert.equal(mode.value,'markdown');assert.ok(Buffer.byteLength(edit.value)>=PAGE-1);edit.value=edit.value.replace('BEGIN','START');edit.oninput();
        edit.setSelectionRange(0,0);await click('记住选区起点');await click('下一段');assert.equal(edit.scrollTop,0);assert.equal(preview.scrollTop,0);
        edit.setSelectionRange(0,0);await click('复制到此光标');assert.ok(clipboard[0].startsWith('START\r\n'));assert.ok(Buffer.byteLength(clipboard[0])>=PAGE-3);
        // Switching mode keeps the full underlying bytes, not just the current window.
        await changeMode('hex');await changeMode('markdown');offset.value=String(source.size-5);await click('定位');
        edit.setSelectionRange(edit.value.length,edit.value.length);const paste='尾部粘贴😀\n'.repeat(18000);
        edit.onpaste({preventDefault(){},clipboardData:{getData:()=>paste}});await waitLoading(edit);await click('撤销');await click('重做');await save();
        const data=new TextDecoder('utf-8',{ignoreBOM:true}).decode(await saved[0].options.body.arrayBuffer());assert.equal(data,original.replace('BEGIN','START')+paste.replace(/\n/g,'\r\n'));assert.equal(saved[0].options.headers['X-Disk-Expected-Version'],'2');
    }});
});

test('Markdown 与 Hex 控制器的实际滚动事件同步，切段复位且关闭解绑',async()=>{
    const source=new Blob(['a\n'.repeat(120000)]);let oldEdit,oldPreview;
    await editor({item:{id:'scroll-doc',name:'长文件.md',size:source.size},source,run:async({edit,preview,changeMode,click})=>{
        oldEdit=edit;oldPreview=preview;edit.scrollHeight=1100;preview.scrollHeight=2100;
        edit.scrollTop=400;edit.emit('scroll');assert.equal(preview.scrollTop,800);preview.emit('scroll');assert.equal(edit.scrollTop,400);
        preview.scrollTop=1200;preview.emit('scroll');assert.equal(edit.scrollTop,600);edit.emit('scroll');
        await click('下一段');assert.equal(edit.scrollTop,0);assert.equal(preview.scrollTop,0);
        await changeMode('hex');preview.scrollTop=1600;preview.emit('scroll');assert.equal(edit.scrollTop,800);
        await click('上一段');assert.equal(edit.scrollTop,0);assert.equal(preview.scrollTop,0);
    }});
    assert.equal(oldEdit.listeners.get('scroll').size,0);assert.equal(oldPreview.listeners.get('scroll').size,0);
});

test('中文 composition 期间不提交半成品，结束后模式切换与保存保留完整 UTF-8',async()=>{
    await editor({run:async({mode,edit,changeMode,save,saved})=>{
        edit.emit('compositionstart');edit.value='中';edit.oninput();await changeMode('hex');assert.equal(mode.value,'text');
        edit.value='中文输入';edit.emit('compositionend');await changeMode('hex');assert.deepEqual([...model().bytesFromHex(edit.value)],Array.from(Buffer.from('中文输入')));
        await changeMode('text');await save();assert.equal(await saved[0].options.body.text(),'中文输入');
    }});
});
