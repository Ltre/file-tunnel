'use strict';
// Real page/CSS and the real theme/menu functions, without a business server.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),express=require('express');
const {chromium}=require(process.argv[2]||'playwright');
const root=path.resolve(__dirname,'..'),out=path.join(root,'.npm-cache/theme-feedback-261029-1');
const read=file=>fs.readFileSync(path.join(root,file),'utf8');
async function run(){
    fs.mkdirSync(out,{recursive:true});
    const app=express(),source=read('app.js');app.use('/client',express.static(path.join(root,'client')));
    const themes=source.slice(source.indexOf('function applyTheme('),source.indexOf('function isTunnelOwner('));
    const menus=source.slice(source.indexOf('async function renderShortCodeSwitchMenu('),source.indexOf('function initMobileWorkspace('));
    app.get('/check',(_req,res)=>res.type('html').send(read('pages/index.html').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'').replace('</body>',`<script>
        const state={sessionId:'check-tunnel'},historyLog=()=>{},normalizeLocalShortCode=String,escapeHtml=String;
        const getAllFromStore=async()=>[{sessionId:'check-tunnel',shortCode:'12345',remark:'隔离隧道'}];
        ${themes}\n${menus}\ninitThemeSwitcher();
        document.getElementById('tunnelStartupLoading').remove();document.getElementById('sessionLanding').hidden=true;document.getElementById('appShell').hidden=false;document.getElementById('tunnelTopbar').hidden=false;
        document.getElementById('shortCodeSwitchBtn').onclick=toggleShortCodeSwitchMenu;
        const items=document.createElement('div');items.className='telegram-drive-items';items.dataset.view='list';items.id='feedback-drive';
        items.innerHTML='<div class="telegram-drive-item">第一行</div><div class="telegram-drive-item">第二行</div>';document.getElementById('telegramDriveOverlay').append(items);
        </script></body>`)));
    const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const base='http://127.0.0.1:'+server.address().port;
    let browser;const checks=[],check=(name,ok,actual)=>checks.push({name,ok:Boolean(ok),actual});
    try{
        browser=await chromium.launch({channel:'chrome',headless:true});const page=await browser.newPage({viewport:{width:1280,height:900},locale:'zh-CN'});
        await page.goto(base+'/check');
        const settle=async theme=>page.evaluate(async theme=>{applyTheme(theme);await new Promise(requestAnimationFrame);await Promise.all(document.getAnimations().filter(a=>a.effect?.getTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>{})));},theme);
        for(const theme of ['lumen','orbit','classic','atelier','social']){
            await settle(theme);await page.reload();
            const selection=await page.evaluate(()=>({theme:document.body.dataset.theme,active:[...document.querySelectorAll('#themeSwitcher .active')].map(b=>b.dataset.theme)}));
            check(theme+': selected theme survives reload',selection.active.length===1&&selection.active[0]===theme,selection);
            await page.evaluate(()=>document.getElementById('tunnelSettingsLayer').hidden=false);
            const highlight=await page.evaluate(()=>{const current=document.querySelector('#themeSwitcher .active'),other=[...current.parentElement.children].find(b=>!b.classList.contains('active'));return {current:getComputedStyle(current).backgroundColor,other:getComputedStyle(other).backgroundColor};});
            check(theme+': current theme has visible selected fill',highlight.current!==highlight.other,highlight);
            await page.evaluate(()=>document.getElementById('tunnelSettingsLayer').hidden=true);
            for(const width of [1100,1201,1280,1440]){
                await page.setViewportSize({width,height:900});await page.locator('#shortCodeSwitchBtn').click();
                const menu=await page.evaluate(()=>{const m=document.getElementById('shortCodeSwitchMenu').getBoundingClientRect(),p=document.querySelector('.connection-panel-header').closest('.panel').getBoundingClientRect();return {left:m.left,right:m.right,parentLeft:p.left,parentRight:p.right};});
                check(theme+': tunnel menu fits its panel at '+width,menu.left>=menu.parentLeft&&menu.right<=menu.parentRight,menu);
                await page.locator('#shortCodeSwitchBtn').click();
            }
            if(theme==='lumen'){
                const editor=await page.locator('#editor').evaluate(n=>({width:getComputedStyle(n).borderTopWidth,color:getComputedStyle(n).borderTopColor}));
                check('Lumen: editor has a visible boundary',parseFloat(editor.width)>0&&!editor.color.endsWith(', 0)'),editor);
                const bar=await page.locator('#tunnelTopbar').evaluate(n=>({background:getComputedStyle(n).backgroundImage,border:getComputedStyle(n).borderBottomColor,shadow:getComputedStyle(n).boxShadow}));
                check('Lumen: topbar slightly tinted with a subtle bottom boundary',!bar.background.includes('rgb(255, 255, 255)')&&(!bar.border.endsWith(', 0)')||bar.shadow.includes('inset')),bar);
            }
            if(['lumen','orbit'].includes(theme)){
                const row=await page.locator('#feedback-drive .telegram-drive-item').last().evaluate(n=>{const s=getComputedStyle(n);return {left:s.borderLeftColor,right:s.borderRightColor,top:s.borderTopColor,radius:s.borderBottomLeftRadius,shadow:s.boxShadow};});
                check(theme+': list rows use separators without card sides',row.left.endsWith(', 0)')&&row.right.endsWith(', 0)')&&parseFloat(row.radius)===0&&row.shadow==='none',row);
                await page.setViewportSize({width:390,height:844});
                await settle(theme);
                const tab=await page.locator('.mobile-workspace-button.active').evaluate(n=>{const s=getComputedStyle(n);return {image:s.backgroundImage,shadow:s.boxShadow,color:s.color};});
                check(theme+': mobile selected tab fades out without top rule',tab.image.includes('radial-gradient')&&tab.shadow==='none',tab);
                await page.screenshot({path:path.join(out,theme+'-mobile.png')});
                await page.setViewportSize({width:1280,height:900});await settle(theme);await page.screenshot({path:path.join(out,theme+'-desktop.png')});
            }
        }
        fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(checks,null,2));
        for(const c of checks)console.log((c.ok?'PASS ':'FAIL ')+c.name+' '+JSON.stringify(c.actual));
        assert.equal(checks.filter(c=>!c.ok).length,0,'see '+out);
    }finally{await browser?.close();server.closeAllConnections();await new Promise(r=>server.close(r));}
}
run().catch(e=>{console.error(e);process.exitCode=1;});
