'use strict';
// Production markup and CSS in an isolated origin; no real database or account.
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), os = require('node:os'), express = require('express');
const { execFileSync } = require('node:child_process');
const { chromium } = require(path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));
const root = path.resolve(__dirname, '..'), read = file => fs.readFileSync(path.join(root, file), 'utf8');
const out = path.join(root, '.npm-cache/visual-261031-1');
(async () => {
    fs.mkdirSync(out, {recursive:true});
    const app = express(); app.use('/client', express.static(path.join(root, 'client')));
    const baseline = file => execFileSync('git',['show','HEAD:'+file],{cwd:root,encoding:'utf8',maxBuffer:8*1024*1024});
    app.get('/baseline/index.css', (_req,res) => res.type('css').send(baseline('client/index.css')));
    app.get('/baseline/themes.css', (_req,res) => res.type('css').send(baseline('client/themes.css')));
    app.get('/original', (_req,res) => res.type('html').send(baseline('pages/index.html').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'').replaceAll('/client/index.css','/baseline/index.css').replaceAll('/client/themes.css','/baseline/themes.css')));
    app.get('/home', (_req, res) => res.type('html').send(read('pages/index.html').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')));
    app.get('/entry', (_req, res) => res.type('html').send(read('pages/tunnel-entry.html').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')));
    const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
    const base = 'http://127.0.0.1:' + server.address().port, checks = [];
    const check = (name, okay, actual) => checks.push({name,okay:Boolean(okay),actual});
    let browser;
    try {
        browser = await chromium.launch({channel:'chrome',headless:true});
        const home = await browser.newPage({viewport:{width:390,height:844}}), entry = await browser.newPage({viewport:{width:390,height:844}}), originalPage=await browser.newPage({viewport:{width:390,height:844}});
        await home.goto(base + '/home'); await entry.goto(base + '/entry');await originalPage.goto(base+'/original');
        const musicSource = read('app.js'), musicStart = musicSource.indexOf('function ensureMusicPlayerOverlay()');
        const musicMarkup = musicSource.slice(musicSource.indexOf('overlay.innerHTML = `', musicStart) + 'overlay.innerHTML = `'.length, musicSource.indexOf('`;', musicSource.indexOf('overlay.innerHTML = `', musicStart)));
        await home.evaluate(markup => { document.getElementById('tunnelStartupLoading').remove(); const overlay=document.createElement('div');overlay.id='musicPlayerOverlay';overlay.className='music-player-overlay';overlay.innerHTML=markup;document.body.append(overlay); }, musicMarkup);
        for (const theme of ['lumen','orbit','classic','atelier','social']) {
            for (const page of [home,entry,originalPage]) await page.evaluate(async theme => {
                document.body.dataset.theme = theme; document.documentElement.dataset.theme = theme;
                document.getElementById('sessionLanding').hidden = false;
                document.getElementById('landingSessionPicker').hidden = false;
                document.getElementById('landingSessionSelect').innerHTML = '<option>66666 · 密码器了6 · 最近使用</option>';
                const recent=document.getElementById('landingRecentBtn');recent.hidden=false;recent.textContent='进入所选隧道';
                getComputedStyle(recent).color;
                await Promise.all(document.getAnimations().filter(a=>a.effect?.getTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>{})));
            }, theme);
            for (const width of [390,600,768,1280]) {
                await home.setViewportSize({width,height:844});await entry.setViewportSize({width,height:844});await originalPage.setViewportSize({width,height:844});
                const geometry = page => page.evaluate(() => ['.tunnel-landing-topbar strong','#sessionLanding h1','#tunnelCodeInputs input','#landingSessionSelect','#landingRecentBtn','#landingCreateBtn'].map(selector => {const node=document.querySelector(selector);if(!node)return null;const r=node.getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height};}));
                const original=await geometry(originalPage),lightweight=await geometry(entry),current=await geometry(home);
                check(`${theme}: ${width}px lightweight route matches original layout`,original.every((a,i)=>a&&lightweight[i]&&Object.keys(a).every(k=>Math.abs(a[k]-lightweight[i][k])<1)),{original,lightweight});
                check(`${theme}: ${width}px existing route geometry preserved`,original.every((a,i)=>a&&current[i]&&Object.keys(a).every(k=>Math.abs(a[k]-current[i][k])<1)),{original,current});
                const surfaces=page=>page.evaluate(()=>['.tunnel-landing','.tunnel-landing-topbar','#tunnelCodeInputs input','#landingSessionSelect','#landingRecentBtn','#landingCreateBtn'].map(selector=>{const s=getComputedStyle(document.querySelector(selector));return Object.fromEntries(['color','backgroundColor','backgroundImage','borderColor','borderRadius','boxShadow','fontSize','fontFamily','fontWeight'].map(k=>[k,s[k]]));}));
                const expected=await surfaces(originalPage),entryStyles=await surfaces(entry),currentStyles=await surfaces(home);
                check(`${theme}: ${width}px route colors and typography preserved`,JSON.stringify(expected)===JSON.stringify(entryStyles)&&JSON.stringify(expected)===JSON.stringify(currentStyles),{expected,entryStyles,currentStyles});
                if(width===390&&['lumen','orbit'].includes(theme))await entry.screenshot({path:path.join(out,theme+'-route.png')});
            }
            await home.setViewportSize({width:390,height:844});
            await home.evaluate(()=>{document.getElementById('sessionLanding').hidden=true;document.getElementById('appShell').hidden=false;document.getElementById('tunnelTopbar').hidden=false;document.getElementById('appShell').dataset.mobilePanel='transfer';});
            const md=await home.evaluate(()=>{
                const input=document.getElementById('textInput'), button=document.getElementById('sendMarkdownBtn'),send=document.getElementById('sendTextBtn');
                const r=button.getBoundingClientRect(), range=document.createRange();range.selectNodeContents(button);const text=range.getBoundingClientRect();
                return {input:input.getBoundingClientRect().height,md:r.height,send:send.getBoundingClientRect().height,dx:Math.abs(text.x+text.width/2-r.x-r.width/2),dy:Math.abs(text.y+text.height/2-r.y-r.height/2)};
            });
            check(`${theme}: narrow MD matches composer height and centers label`,Math.abs(md.input-md.md)<1&&Math.abs(md.send-md.md)<1&&md.dx<1&&md.dy<3,md);
            if(['lumen','orbit'].includes(theme)) {
                await home.evaluate(()=>{document.getElementById('musicPlayerOverlay').classList.add('active');document.getElementById('musicPlayerTitle').textContent='抓泥鳅 (31周年修复版)';document.getElementById('musicPlayerSubtitle').textContent='七仙女 Seven Fairies Official';});
                const music=await home.evaluate(()=>{
                    const css=s=>getComputedStyle(document.querySelector(s)),bar=css('.music-player-topbar'),drawer=css('.music-player-queue-drawer');
                    return {barBackground:bar.backgroundColor,barImage:bar.backgroundImage,barShadow:bar.boxShadow,drawerShadow:drawer.boxShadow,drawerBackground:drawer.backgroundColor,drawerImage:drawer.backgroundImage,drawerBlur:drawer.backdropFilter};
                });
                check(`${theme}: music header and queue share continuous background`,music.barBackground==='rgba(0, 0, 0, 0)'&&music.barImage==='none'&&music.barShadow==='none'&&music.drawerShadow==='none'&&music.drawerImage.includes('gradient'),music);
                await home.screenshot({path:path.join(out,theme+'-music.png')});await home.evaluate(()=>document.getElementById('musicPlayerOverlay').classList.remove('active'));
            }
            await home.evaluate(()=>document.getElementById('appShell').hidden=true);
        }
        fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(checks,null,2));
        for(const c of checks)console.log((c.okay?'PASS ':'FAIL ')+c.name+(c.okay?'':' '+JSON.stringify(c.actual)));
        assert.equal(checks.filter(c=>!c.okay).length,0,'see '+out);
    } finally {await browser?.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
})().catch(error=>{console.error(error);process.exitCode=1;});
