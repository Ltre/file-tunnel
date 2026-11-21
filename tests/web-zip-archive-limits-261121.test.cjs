'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync(require.resolve('../client/folder-archive.js'),'utf8');
test('ZIP extractor permits ordinary archives but rejects forged size and file-count inflation',async()=>{
    const context={window:{},TextEncoder,TextDecoder,Uint8Array,DataView,Blob,Date,Response,DecompressionStream};
    vm.runInNewContext(source,context);
    const archive=context.window.FolderArchive;
    const bytes=new TextEncoder().encode('<h1>trusted</h1>');
    const blob=await archive.createZip([{path:'index.html',arrayBuffer:async()=>bytes.buffer}]);
    const extracted=await archive.extractZip(blob);
    assert.equal(extracted[0].path,'index.html');assert.equal(new TextDecoder().decode(extracted[0].data),'<h1>trusted</h1>');
    const raw=new Uint8Array(await blob.arrayBuffer());
    const view=new DataView(raw.buffer),eocd=raw.length-22,central=view.getUint32(eocd+16,true);
    view.setUint32(central+24,256*1024*1024,true);
    await assert.rejects(archive.extractZip(new Blob([raw])),/安全上限/);
    view.setUint32(central+24,bytes.byteLength,true);
    view.setUint16(eocd+10,4097,true);
    await assert.rejects(archive.extractZip(new Blob([raw])),/文件项过多/);
});
