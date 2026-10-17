'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),vm=require('node:vm');
const {createTunnelAccess}=require('../server/tunnel-access');
const {createFixture}=require('./support/media-library-fixture.cjs');
test('QR join credentials are scoped, survive restart, and are invalidated by code rotation without exposing the code',t=>{
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dr2t-qr-261017-4-'));t.after(()=>{const target=path.resolve(dir);assert.equal(path.dirname(target),path.resolve(os.tmpdir()));assert.ok(path.basename(target).startsWith('dr2t-qr-261017-4-'));fs.rmSync(target,{recursive:true,force:true});});
    const access=createTunnelAccess(dir),token=access.issueJoin('tunnel','OLD51');
    assert.equal(createTunnelAccess(dir).verifyJoin(token,'tunnel','OLD51'),true);
    assert.equal(access.verifyJoin(token,'other','OLD51'),false);assert.equal(access.verifyJoin(token,'tunnel','NEW51'),false);
    assert.equal(access.verifyJoin(token+'x','tunnel','OLD51'),false);
    assert.equal(access.verifyJoin(access.issue('tunnel','device'),'tunnel','OLD51'),false);
    assert.equal(access.verify(token,'tunnel','device'),false);
    assert.equal(Buffer.from(token.split('.')[0],'base64url').toString().includes('OLD51'),false);
});
test('copying record text appends newline-wrapped names for single files and every collection member',()=>{
    const source=fs.readFileSync('app.js','utf8'),context=vm.createContext({});
    vm.runInContext(source.slice(source.indexOf('function getCollectionFiles('),source.indexOf('async function createCollectionTileHtml('))+source.slice(source.indexOf('function recordTextPayload('),source.indexOf('async function copyTransferRecordText(')),context);
    assert.equal(context.recordTextPayload({type:'text',text:'正文'}).text,'正文');
    assert.equal(context.recordTextPayload({type:'file',remark:'备注',fileInfo:{name:'文件甲.txt'}}).text,'备注\n文件甲.txt\n');
    assert.equal(context.recordTextPayload({type:'collection',collection:{files:[{id:'a',name:'甲.txt'},{id:'b',name:'乙.txt'}]}}).text,'\n甲.txt\n\n乙.txt\n');
    assert.equal(context.recordTextPayload({type:'file',fileInfo:{name:'空备注.mp4'}}).text,'\n空备注.mp4\n');
});

test('dense frame points reuse an existing short work segment even when the same batch has a distant point',async t=>{
    const f=createFixture();t.after(()=>f.close());const s=f.service;
    s.processing.probe=async()=>({format:{duration:'4',start_time:'0'},streams:[{codec_type:'video',duration:'4'}]});
    const resource=s.createImport({kind:'disk',...f.put('source')},{id:'alice'});await s.pump();assert.equal(s.get('import',resource.id).state,'ready');
    const session=s.createSession(resource.id,'cluster'),work=s.clip(session.id,{start:0,end:1},true);await s.pump();
    const inputs=[],frame=s.processing.frame;s.processing.frame=async(input,...args)=>{inputs.push(input);return frame(input,...args);};
    const task=s.extract(session.id,{mode:'random',count:3});s.db.patch('batch',task.batch.id,'alice',{times:[.1,.2,3.9]});await s.pump();
    assert.equal(s.get('job',task.job.id).state,'completed');assert.equal(inputs.length,3);assert.equal(inputs[0],inputs[1]);assert.equal(/^http:/.test(inputs[0]),false);assert.match(inputs[2],/^http:/);
    const lease=s.cache.acquire('alice',s.get('job',work.id).result.cacheId);assert.equal(lease.record.status,'ready');lease.release();
});
