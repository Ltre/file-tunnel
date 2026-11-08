'use strict';
const {test,before,after}=require('node:test'),assert=require('node:assert/strict'),path=require('node:path'),os=require('node:os'),express=require('express');
const {chromium}=require(path.join(os.homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));
let browser,server,base;
before(async()=>{const app=express();app.use('/client',express.static(path.join(__dirname,'../client')));for(const name of ['sns-dl','youtube-premium-dl'])app.get('/'+name,(_q,res)=>res.sendFile(path.join(__dirname,'../pages/'+name+'.html')));server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));base='http://127.0.0.1:'+server.address().port;browser=await chromium.launch({channel:'chrome',headless:true});});
after(async()=>{await browser?.close();server?.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
for(const name of ['sns-dl','youtube-premium-dl'])test(name+' asks before marking handled; cancel writes nothing and confirm writes once',async()=>{
    const page=await browser.newPage();let writes=0,accepted=false;
    const task={id:'task',status:'failed',title:'isolated task',createdAt:1,handled:false,tags:[],hasFile:false,autoCacheEnabled:false};
    try{
        await page.route('**/api/**',async route=>{const request=route.request();if(request.method()==='PATCH'){writes++;assert.deepEqual(request.postDataJSON(),{handled:true});task.handled=true;return route.fulfill({json:{task}});}return route.fulfill({json:{tasks:[task],page:1,pages:1,total:1,ids:['task'],youtubePremiumCookie:{configured:true}}});});
        page.on('dialog',async dialog=>{assert.equal(dialog.type(),'confirm');assert.match(dialog.message(),/标记为已处理/);await(accepted?dialog.accept():dialog.dismiss());});
        await page.goto(base+'/'+name);const button=page.getByRole('button',{name:'✔标记为已处理',exact:true});await button.click();await page.waitForTimeout(100);assert.equal(writes,0);
        accepted=true;await button.click();await page.getByRole('button',{name:'标记为·待处理',exact:true}).waitFor();assert.equal(writes,1);
    }finally{await page.close();}
});
