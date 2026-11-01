'use strict';
const assert=require('node:assert/strict'),path=require('node:path'),os=require('node:os'),fs=require('node:fs');
const {chromium}=require(process.argv[2]||path.join(os.homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));
const {createFixture}=require('./support/pending-save-261012-fixture.cjs');
(async()=>{
    const f=await createFixture();let browser;
    try{
        const cases=[];
        for(const exposure of ['collaboration','static'])for(const kind of ['file','directory']){
            const scope=exposure==='collaboration'?'协同开放':'静态开放',source=scope+'/甲-'+kind,destination=scope+'/乙';
            f.store.createDirectory('alice',source,30);f.store.createDirectory('alice',destination,30);
            const file=f.store.putMetadataObject(f.auth.user('alice'),source,exposure+'-'+kind+'.txt','text/plain',{},30);
            cases.push({exposure,kind,scope,source,destination,file});
        }
        require('../server/disk-static-resources').createDiskStaticResources({dataDir:f.dataDir}).create({userId:'alice',diskSpace:''},f.store,{preset:'permanent',items:[{kind:'directory',path:'静态开放'}]});
        browser=await chromium.launch({channel:'chrome',headless:true});const context=await browser.newContext({viewport:{width:1280,height:900},locale:'zh-CN'});
        await context.request.post(f.base+'/fixture-login',{form:{id:'alice'}});
        const grant=await context.request.post(f.base+'/api/telegram/drive/collaborations/invitations',{data:{kind:'directory',path:'协同开放'}});assert.equal(grant.status(),201);
        const page=await context.newPage(),errors=[],patches=[];page.setDefaultTimeout(12000);
        page.on('pageerror',error=>errors.push(error.message));page.on('request',request=>{if(request.method()==='PATCH')patches.push({url:request.url(),body:request.postDataJSON()});});
        await page.goto(f.base+'/disk');await page.evaluate(()=>DiskUI.open());await page.locator('.telegram-drive-space-picker').waitFor();
        fs.mkdirSync(path.resolve('.npm-cache/move-same-scope-261101'),{recursive:true});
        for(const test of cases){
            const current=test.kind==='file'?test.source:test.scope,name=test.kind==='file'?test.file.name:'甲-'+test.kind,before=patches.length;
            await page.getByRole('button',{name:'输入目录路径',exact:true}).click();const input=page.getByRole('textbox',{name:'目录完整路径',exact:true});await input.fill(current);await input.press('Enter');
            const more=page.getByRole('button',{name:name+' 更多操作',exact:true});await more.waitFor();
            const openMove=async()=>{
                await more.click();await page.locator('#telegramDriveItemMenu').getByRole('button',{name:'复制/移动',exact:true}).click();
                const transfer=page.locator('.telegram-drive-dialog-card').filter({hasText:'目标分区'});
                await transfer.getByRole('button',{name:'移动到',exact:true}).click();await transfer.getByRole('textbox',{name:'目标目录全路径',exact:true}).fill(test.destination);await transfer.getByRole('button',{name:'移动',exact:true}).click();
                const warning=page.locator('.telegram-drive-dialog-card').filter({hasText:'确认移出开放范围内的内容'});await warning.waitFor();return warning;
            };
            let warning=await openMove();assert.equal(patches.length,before);assert.equal(await page.locator('#diskLoading').evaluate(node=>node.hidden),true);
            assert.equal(f.store.get('alice',test.file.id).folderPath,test.source,'source must stay unchanged while awaiting acknowledgement');
            await warning.getByRole('button',{name:'取消',exact:true}).click();assert.equal(patches.length,before);
            warning=await openMove();await warning.getByRole('button',{name:'坚持移动',exact:true}).click();assert.equal(patches.length,before);assert.equal(await warning.isVisible(),true,'unchecked acknowledgement must not submit');
            await page.screenshot({path:path.resolve('.npm-cache/move-same-scope-261101/'+test.exposure+'-'+test.kind+'.png')});
            await warning.getByRole('checkbox').check();await warning.getByRole('button',{name:'坚持移动',exact:true}).click();
            const expected=test.kind==='file'?test.destination:test.destination+'/甲-directory';
            for(let i=0;i<100&&f.store.get('alice',test.file.id).folderPath!==expected;i++)await new Promise(resolve=>setTimeout(resolve,10));
            await page.waitForFunction(()=>document.getElementById('diskLoading').hidden);assert.equal(f.store.get('alice',test.file.id).folderPath,expected);assert.equal(patches.length,before+1);assert.equal(patches.at(-1).body.confirm_exposed_move,true);
            console.log('PASS '+test.exposure+' '+test.kind+': same-scope preflight, cancel, required checkbox, no premature loading or mutation, one acknowledged move');
        }
        assert.deepEqual(errors,[]);
    }finally{await browser?.close();await f.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
