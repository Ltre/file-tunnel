'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {chromium}=require(process.argv[2]||'playwright');
const {createFixture}=require('./support/pending-save-261012-fixture.cjs');
async function run(){
    const f=await createFixture(),out=path.resolve(__dirname,'../.npm-cache/disk-ui-261028-3');fs.mkdirSync(out,{recursive:true});
    let browser;const results=[],check=(name,ok,data)=>results.push({name,ok:Boolean(ok),data});
    try{
        browser=await chromium.launch({channel:'chrome',headless:true});const context=await browser.newContext({viewport:{width:1440,height:1000},locale:'zh-CN'});
        await context.request.post(f.base+'/fixture-login',{form:{id:'alice'}});
        const file=f.store.putMetadataObject(f.auth.user('alice'),'','保护测试.txt','text/plain',{},30);
        await context.request.post(f.base+'/api/telegram/drive/collaborations/invitations',{data:{kind:'file',fileId:file.id}});
        const page=await context.newPage();await page.goto(f.base+'/disk');await page.evaluate(()=>DiskUI.open());
        await page.locator('.telegram-drive-space-picker').waitFor();
        const themeReady=async theme=>page.evaluate(async t=>{
            document.body.dataset.theme=t;
            await new Promise(requestAnimationFrame);
            await Promise.all(document.getAnimations().filter(a=>a.effect?.getTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>{})));
        },theme);
        for(const theme of ['classic','atelier','social','lumen','orbit']){
            await themeReady(theme);
            const info=await page.evaluate(()=>{
                const select=document.querySelector('.telegram-drive-space-picker'),filters=[];
                for(let n=select;n;n=n.parentElement){const c=getComputedStyle(n);if(c.backdropFilter!=='none'||c.filter!=='none')filters.push({id:n.id,filter:c.filter,backdrop:c.backdropFilter});}
                return {filters,close:getComputedStyle(document.querySelector('#closeTelegramDriveBtn')).backgroundColor};
            });
            check(theme+': native partition popup has no filtered ancestors',!info.filters.length,info.filters);
            check(theme+': close is orangered',info.close==='rgb(255, 69, 0)',info.close);
        }
        await themeReady('lumen');
        await page.getByRole('button',{name:'保护测试.txt 更多操作',exact:true}).click();
        await page.locator('#telegramDriveItemMenu').getByRole('button',{name:/移入回收站|删除/}).click();
        await page.getByRole('button',{name:'移入回收站',exact:true}).click();
        const dialog=page.locator('.telegram-drive-dialog-card').filter({hasText:'确认删除开放范围内的内容'});await dialog.waitFor();
        const alignment=await dialog.locator('label').evaluate(label=>{const cb=label.querySelector('input'),r=cb.getBoundingClientRect(),range=document.createRange();range.selectNodeContents(label.lastChild);const t=range.getBoundingClientRect();return {checkboxWidth:r.width,centerDelta:Math.abs(r.y+r.height/2-t.y-t.height/2),checkboxX:r.x,textX:t.x};});
        check('acknowledgement checkbox aligns beside its label',alignment.checkboxWidth<25&&alignment.centerDelta<4&&alignment.textX>alignment.checkboxX,alignment);
        await page.screenshot({path:path.join(out,'delete-lumen.png')});
        await dialog.getByRole('button',{name:'取消',exact:true}).click();
        await page.evaluate(()=>DiskUI.close());
        await page.evaluate(()=>{document.getElementById('sessionLanding').hidden=true;document.getElementById('appShell').hidden=false;document.getElementById('tunnelTopbar').hidden=false;});
        for(const theme of ['lumen','orbit']){
            await themeReady(theme);
            const home=await page.evaluate(()=>{const c=s=>getComputedStyle(document.querySelector(s)),r=s=>document.querySelector(s).getBoundingClientRect();return {shortWidth:r('.short-code-switch').width,infoWidth:r('.session-info').width,dropBorder:c('#dropZone').borderColor,dropStyle:c('#dropZone').borderStyle,dropBg:c('#dropZone').backgroundColor,inputBg:c('#textInput').backgroundColor};});
            check(theme+': tunnel code surface aligns with adjacent information',Math.abs(home.shortWidth-home.infoWidth)<1,home);
            if(theme==='lumen'){check('Lumen upload keeps its dashed border',home.dropStyle.includes('dashed')&&!home.dropBorder.includes(', 0)'),home);check('Lumen upload and message backgrounds are equally light',home.dropBg===home.inputBg&&home.dropBg==='rgb(250, 251, 255)',home);}
            await page.screenshot({path:path.join(out,theme+'-home.png')});
        }
        fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(results,null,2));for(const r of results)console.log((r.ok?'PASS ':'FAIL ')+r.name+' '+JSON.stringify(r.data));
        assert.equal(results.filter(r=>!r.ok).length,0,'see '+out);
    }finally{await browser?.close();await f.close();}
}
run().catch(e=>{console.error(e);process.exitCode=1;});
