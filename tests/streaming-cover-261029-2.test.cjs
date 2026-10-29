'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm');
const source = process.env.STREAM_COVER_BASELINE ? require('node:child_process').execFileSync('git',['show','HEAD:client/streaming-console.js'],{encoding:'utf8'}) : fs.readFileSync('client/streaming-console.js','utf8');
function fixture({ readFails=false, bitmapFails=false, defer=false, controlledTimeouts=false }={}) {
    const images=[],released=[],urls=[],waiters=[],timers=new Map();let timerId=0;
    class Node {
        constructor(tag){this.tag=tag;this.children=[];this.classList={add(){},remove(){}};this.isConnected=true;}
        append(...nodes){this.children.push(...nodes);} prepend(node){this.children.unshift(node);} after(node){this.inserted=node;} setAttribute(){}
        getContext(){return {drawImage:image=>{this.token=image.token;}};}
        toBlob(run){run(new Blob(['crop:'+this.token],{type:'image/png'}));}
    }
    class Reader {
        readAsArrayBuffer(file){queueMicrotask(()=>{if(readFails)this.onerror?.();else{this.result=file.bytes.slice(0);this.onload?.();}});}
        readAsDataURL(){queueMicrotask(()=>{this.result='data:image/jpeg;base64,Zml4dHVyZQ==';this.onload?.();});}
    }
    class Image {set src(_value){queueMicrotask(()=>this.onerror?.());}}
    const form=new Node('section');form.children.push(new Node('label'));
    const pendingCovers=new Map(),draft={coverId:''};
    const ctx={document:{createElement:tag=>new Node(tag)},Image,FileReader:Reader,Blob,ArrayBuffer,queueMicrotask,
        setTimeout:controlledTimeouts?(run=>{timers.set(++timerId,run);return timerId;}):setTimeout,
        clearTimeout:controlledTimeouts?(id=>timers.delete(id)):clearTimeout,
        URL:{createObjectURL:blob=>{const value='blob:fixture-'+urls.length;urls.push({value,blob});return value;},revokeObjectURL:value=>released.push(value)},
        global:{async createImageBitmap(blob){
            if(bitmapFails)throw Error('fixture decoder rejected');
            const token=new Uint8Array(await blob.arrayBuffer())[0],image={width:120,height:80,token,close(){released.push('bitmap:'+token);}};images.push(image);
            if(defer)await new Promise(resolve=>waiters.push({token,resolve}));return image;
        }},
        pendingCovers,t:value=>value,ui:{stationId:'station'},uid:()=> 'token-'+urls.length,saveUi(){},main:new Node('main'),coverImage:()=>new Node('img'),button:(title,run)=>({title,run})};
    const start=source.includes('    async function decodeCover(')?source.indexOf('    async function decodeCover('):source.indexOf('    function coverEditor(');
    vm.runInNewContext(source.slice(start,source.indexOf('    function title(')),ctx);ctx.coverEditor(form,draft,'station');
    const field=form.children.find(node=>node.tag==='label').inserted,input=field.children[0].children[0];
    return {ctx,input,draft,pendingCovers,images,urls,released,waiters,timers,status:()=>field.children[2].textContent,
        remove:()=>field.children.find(node=>node.title==='移除封面').run(),
        choose(token){input.files=[{type:'image/jpeg',size:3,bytes:new Uint8Array([token,2,3]).buffer}];return input.onchange();}};
}
const flush=()=>new Promise(setImmediate);
test('cover uses owned bytes and independent bitmap decoding when HTML image URLs fail',async()=>{
    const f=fixture();await f.choose(7);
    assert.ok(f.pendingCovers.has('station'),f.status());assert.equal(await f.pendingCovers.get('station').blob.text(),'crop:7');
    assert.deepEqual(f.released,['bitmap:7']);assert.equal(f.urls.length,1,'only the cropped preview needs an object URL');
});
test('a selected file read failure is distinct and cannot replace an existing cover',async()=>{
    const f=fixture({readFails:true});await f.choose(7);
    assert.equal(f.pendingCovers.size,0);assert.match(f.status(),/STREAM_COVER_READ_FAILED/);assert.equal(f.urls.length,0);
});
test('late previous cover selection closes its bitmap without replacing the current selection',async()=>{
    const f=fixture({defer:true}),first=f.choose(1);await flush();const second=f.choose(2);await flush();
    f.waiters.find(w=>w.token===2).resolve();await second;
    const current=f.pendingCovers.get('station');assert.equal(await current.blob.text(),'crop:2');
    f.waiters.find(w=>w.token===1).resolve();await first;
    assert.equal(f.pendingCovers.get('station'),current);assert.deepEqual(f.released,['bitmap:2','bitmap:1']);assert.equal(f.urls.length,1);
});
test('removing a cover during decode prevents its late result from restoring it',async()=>{
    const f=fixture({defer:true}),selection=f.choose(1);await flush();
    f.remove();f.waiters[0].resolve();await selection;
    assert.equal(f.pendingCovers.size,0);assert.deepEqual(f.released,['bitmap:1']);
});
test('a replacement revokes only the preceding preview URL and closes both bitmaps',async()=>{
    const f=fixture();await f.choose(1);const old=f.pendingCovers.get('station').url;await f.choose(2);
    assert.equal(await f.pendingCovers.get('station').blob.text(),'crop:2');assert.ok(f.released.includes(old));assert.ok(!f.released.includes(f.pendingCovers.get('station').url));
    assert.ok(f.released.includes('bitmap:1')&&f.released.includes('bitmap:2'));
});
test('a timed-out bitmap that completes later is closed instead of leaked or published',async()=>{
    const f=fixture({defer:true,controlledTimeouts:true}),selection=f.choose(1);await flush();
    const [id,expire]=[...f.timers][0];f.timers.delete(id);expire();await selection;
    assert.equal(f.pendingCovers.size,0);f.waiters[0].resolve();await flush();assert.ok(f.released.includes('bitmap:1'));assert.equal(f.timers.size,0);
});
test('invalid image bytes remain rejected when both independent decoders fail',async()=>{
    const f=fixture({bitmapFails:true});await f.choose(7);
    assert.equal(f.pendingCovers.size,0);assert.match(f.status(),/STREAM_COVER_DECODE_FAILED/);assert.equal(f.urls.length,1);assert.deepEqual(f.released,['blob:fixture-0']);
});
