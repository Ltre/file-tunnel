'use strict';
const {test,before,after}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {chromium}=require(path.join(os.homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));
const root=path.resolve(__dirname,'..'),app=fs.readFileSync(path.join(root,'app.js'),'utf8'),part=(a,b)=>app.slice(app.indexOf(a),app.indexOf(b,app.indexOf(a)));let browser;
before(async()=>browser=await chromium.launch({channel:'chrome',headless:true}));after(()=>browser.close());
async function fixture(){const page=await browser.newPage();await page.setContent('<body data-theme="orbit"><button id="start">start</button></body>');for(const file of ['index','themes'])await page.addStyleTag({path:path.join(root,'client/'+file+'.css')});
    await page.addScriptTag({content:`const records=Array.from({length:3},(_,n)=>({id:'record-'+n,type:'text',text:'设置 演示 '+n+' '+('long content '.repeat(50))})),replies=new Map(),saved=[],state={sessionId:'A',deviceId:'actor',deviceName:'test',socket:{timeout(){return this;},emit(event,data,ack){replies.set(data.message.forwardedFrom.messageId,{data,ack});}}};
    let sequence=0;const LAST_FORWARD_SESSION_STORAGE_KEY='last',localStorage={setItem(){}},generateId=()=> 'target-'+(++sequence),tunnelDeviceId=()=> 'actor',savedTunnelGrant=()=> 'proof',getFromStore=async(_store,id)=>records.find(record=>record.id===id),saveToStore=async(_store,message)=>saved.push(message),showAppToast=()=>{},historyLog=()=>{};
    ${part('function showForwardHistoryProgress(','async function downloadFileFromMessage(')}
    window.fixture={records,replies,saved,complete:false,start(){this.promise=forwardHistoryMessages(records,'B').then(result=>{this.complete=true;return result;});},release(id,ok=true){const reply=replies.get(id);reply.ack(null,ok?{ok:true,message:reply.data.message}:{ok:false,error:'permission-denied'});}};`});return page;}

test('forward dialog retains raw one-line summaries, IDs and individual results until the user closes it',async()=>{const page=await fixture();try{
    await page.evaluate(()=>fixture.start());await page.locator('[data-record-id="record-0"][data-state="sending"]').waitFor();assert.equal(await page.locator('[data-state="waiting"]').count(),2);
    const layout=await page.locator('.history-forward-row').first().evaluate(row=>{const excerpt=row.querySelector('.history-forward-excerpt'),id=row.querySelector('.history-forward-id');return{overflow:getComputedStyle(excerpt).textOverflow,whiteSpace:getComputedStyle(excerpt).whiteSpace,idStyle:getComputedStyle(id).fontStyle,idAlign:getComputedStyle(id).textAlign,text:excerpt.textContent};});assert.equal(layout.overflow,'ellipsis');assert.equal(layout.whiteSpace,'nowrap');assert.equal(layout.idStyle,'italic');assert.equal(layout.idAlign,'right');assert.match(layout.text,/设置 演示 0/);
    await page.evaluate(()=>fixture.release('record-0'));await page.locator('[data-record-id="record-1"][data-state="sending"]').waitFor();await page.evaluate(()=>fixture.release('record-1',false));await page.locator('[data-record-id="record-2"][data-state="sending"]').waitFor();await page.evaluate(()=>fixture.release('record-2'));await page.waitForFunction(()=>fixture.complete);
    assert.equal(await page.locator('.history-forward-results').count(),1);assert.equal(await page.locator('[data-state="confirmed"]').count(),2);assert.equal(await page.locator('[data-state="failed"]').count(),1);assert.equal(await page.locator('.history-forward-spinner').count(),0);
    await page.getByRole('button',{name:'关闭',exact:true}).click();assert.equal(await page.locator('.history-forward-results').count(),0);
}finally{await page.close();}});

test('user closing the results dialog during sending does not cancel or duplicate the batch',async()=>{const page=await fixture();try{
    await page.evaluate(()=>fixture.start());await page.locator('[data-state="sending"]').waitFor();await page.getByRole('button',{name:'关闭',exact:true}).click();
    for(let n=0;n<3;n++){await page.waitForFunction(id=>fixture.replies.has(id),'record-'+n);await page.evaluate(id=>fixture.release(id),'record-'+n);}await page.waitForFunction(()=>fixture.complete);
    assert.equal(await page.evaluate(()=>fixture.saved.length),3);assert.equal(await page.locator('.history-forward-results').count(),0);
}finally{await page.close();}});
