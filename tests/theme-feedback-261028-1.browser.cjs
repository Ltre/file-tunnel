'use strict';
// Focused CSS regression against the live page markup and production styles.
// No application database, account, network backend or design files are modified.
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), express = require('express');
const { chromium } = require(process.argv[2] || 'playwright');
const root = path.resolve(__dirname, '..'), out = path.join(root, '.npm-cache', 'theme-feedback-261028-1');
const read = name => fs.readFileSync(path.join(root, name), 'utf8');
async function run() {
    fs.mkdirSync(out, { recursive: true });
    const app = express(); app.use('/client', express.static(path.join(root, 'client')));
    app.get('/check', (_req, res) => {
        const html = read('pages/index.html').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
        res.type('html').send(html);
    });
    const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
    const base = 'http://127.0.0.1:' + server.address().port;
    let browser; const results = [];
    const check = (name, okay, detail) => results.push({ name, okay: Boolean(okay), detail });
    try {
        browser = await chromium.launch({ channel: 'chrome', headless: true });
        const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, locale: 'zh-CN' });
        await page.goto(base + '/check');
        await page.addScriptTag({url:base+'/client/i18n.js'});
        await page.evaluate(() => {
            document.getElementById('tunnelStartupLoading').remove();
            document.getElementById('sessionLanding').hidden = true;
            document.getElementById('appShell').hidden = false;
            document.getElementById('tunnelTopbar').hidden = false;
            const own = document.createElement('article'); own.className = 'message own';
            own.innerHTML = '<div class="message-bubble">我方消息</div>';
            document.getElementById('chatMessages').append(own);
            const nearby = document.querySelector('.contacts-panel');
            if (nearby) nearby.dataset.themeFeedback = 'nearby';
            const sc = document.createElement('div'); sc.id = 'streamingConsole'; sc.className = 'sc-overlay';
            sc.innerHTML = '<header class="sc-header"><strong>串流控制台</strong><button data-sc-minimize>_</button><button class="sc-close" data-sc-home>×</button></header><div class="sc-workspace"><main class="sc-main"><div class="sc-page sc-viewer-page"><h1 class="sc-list-heading">串流台 · 12 · 验证台<span class="sc-list-tools"><label class="sc-list-sort">排序<select><option>修改时间</option></select></label><button>刷新</button></span></h1><img class="sc-cover sc-viewer-cover" src="/client/icons/streaming.png"><div class="sc-watch-grid"><div class="sc-player"><div class="sc-stage"><div class="sc-media"><p class="message-content sc-audio-title">♪ 清晰的音频文件名.mp3</p></div></div></div><aside><p class="sc-watch-item sc-now-playing">▶ 当前节目</p></aside></div></div></main></div>';
            sc.hidden = true; document.body.append(sc);
        });
        const themes = ['lumen', 'orbit', 'classic', 'atelier', 'social'];
        const color = value => value !== 'transparent' && value !== 'rgba(0, 0, 0, 0)';
        for (const theme of themes) {
            await page.evaluate(async value => {
                document.body.dataset.theme = value;
                // Existing field hover/theme transitions are outside preview-entry scope.
                getComputedStyle(document.getElementById('dropZone')).borderRadius;
                await Promise.all(document.getAnimations().filter(a => a.effect.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {})));
            }, theme);
            const d = await page.evaluate(() => {
                const css = sel => getComputedStyle(document.querySelector(sel));
                const rect = sel => document.querySelector(sel).getBoundingClientRect();
                const b = css('.input-area #textInput');
                const a = document.querySelector('.editor-actions'), ac = getComputedStyle(a);
                const spans = [...a.querySelectorAll('button span')].filter(n => n.textContent.trim());
                const lines = spans.map(n => { const r = document.createRange(); r.selectNodeContents(n); return [...r.getClientRects()].filter(x => x.height > 1).length; });
                return { inputRadius: parseFloat(b.borderTopLeftRadius), dropRadius: parseFloat(css('#dropZone').borderTopLeftRadius),
                    header: css('.connection-panel-header').backgroundImage + css('.connection-panel-header').backgroundColor,
                    topbar: css('#tunnelTopbar').backgroundImage + css('#tunnelTopbar').backgroundColor,
                    menu: css('#connectionHeaderMenuBtn').backgroundColor,
                    ownBorder: css('.message.own .message-bubble').borderColor, ownShadow: css('.message.own .message-bubble').boxShadow,
                    panelBorder: css('.panel').borderColor, panelShadow: css('.panel-header').boxShadow,
                    short: css('.short-code-switch-button').backgroundColor, accent: css('body').getPropertyValue('--ui-accent'),
                    nearbyInset: rect('.contacts-panel-header').x - rect('.contacts-panel').x, lines,
                    mediaButtons: [...document.querySelectorAll('.media-control-btn')].map(n => ({ bg: getComputedStyle(n).backgroundColor, parent: getComputedStyle(n.parentElement).backgroundColor })),
                    send: css('#sendRichBtn').backgroundImage, editorActionWidth: a.getBoundingClientRect().width, scroll: a.scrollWidth };
            });
            check(theme + ': message input uses restrained corners', d.inputRadius <= d.dropRadius, {input:d.inputRadius,drop:d.dropRadius});
            check(theme + ': editor button labels remain on one line', d.lines.every(n => n <= 1), d.lines);
            check(theme + ': nearby has inner left breathing space', d.nearbyInset >= 8, d.nearbyInset);
            if (['lumen','orbit'].includes(theme)) {
                check(theme + ': connection menu shares header fill', !color(d.menu), d.menu);
                check(theme + ': short code has subdued fill', d.short !== (theme === 'lumen' ? 'rgb(83, 71, 232)' : 'rgb(179, 166, 255)'), d.short);
                check(theme + ': send emphasis avoids primary gradient', d.send === 'none', d.send);
            }
            if (theme === 'lumen') {
                check('lumen: workspace headers differ from topbar', d.header !== d.topbar, d.header);
                check('lumen: panel boundary is not an explicit line', /rgba\([^)]*, 0\)/.test(d.panelBorder), d.panelBorder);
                check('lumen: header has no inset accent stripe', !d.panelShadow.includes('inset'), d.panelShadow);
            }
            await page.evaluate(() => { document.getElementById('streamingConsole').hidden = false; });
            const sc = await page.evaluate(() => {
                const css = s => getComputedStyle(document.querySelector(s));
                const r = document.querySelector('.sc-viewer-cover').getBoundingClientRect();
                const label = document.querySelector('.sc-list-sort').getBoundingClientRect();
                const select = document.querySelector('.sc-list-sort select').getBoundingClientRect();
                const text = document.createRange(); text.selectNodeContents(document.querySelector('.sc-list-sort').firstChild);
                const tr = text.getBoundingClientRect();
                return { audio: css('.sc-audio-title').backgroundColor, audioColor: css('.sc-audio-title').color,
                    cover: { width: r.width, height:r.height, bg:css('.sc-viewer-cover').backgroundColor, filter:css('.sc-viewer-cover').filter },
                    close: css('[data-sc-home]').backgroundColor, minimize: css('[data-sc-minimize]').backgroundColor,
                    border: css('.sc-now-playing').borderBottomColor,
                    sortCenter: Math.abs((tr.top + tr.height/2) - (select.top + select.height/2)),
                    sortLabel: {height: label.height, select: select.height} };
            });
            check(theme + ': square viewer cover', Math.abs(sc.cover.width - sc.cover.height) <= 1, sc.cover);
            check(theme + ': close uses orangered', sc.close === 'rgb(255, 69, 0)', sc.close);
            check(theme + ': sorting label and control align', sc.sortCenter <= 4, sc.sortCenter);
            if (['lumen','orbit'].includes(theme)) {
                check(theme + ': audio title has no rectangular fill', !color(sc.audio), sc.audio);
                check(theme + ': now-playing bottom edge is not accent', sc.border !== (theme === 'lumen' ? 'rgb(83, 71, 232)' : 'rgb(179, 166, 255)'), sc.border);
            }
            if (theme === 'orbit') {
                check('orbit: minimize color', sc.minimize === 'rgb(58, 65, 67)', sc.minimize);
                check('orbit: default icon filter does not paint an opaque tile', !color(sc.cover.bg), sc.cover);
            }
            await page.screenshot({ path: path.join(out, theme + '-player.png') });
            await page.evaluate(() => { document.getElementById('streamingConsole').hidden = true; });
            await page.screenshot({ path: path.join(out, theme + '-home.png') });
        }
        const ids = await page.locator('.theme-option').evaluateAll(nodes => nodes.map(n => n.dataset.theme));
        check('Graphite removed from theme menus', !ids.includes('graphite'), ids);
        await page.evaluate(() => {
            document.getElementById('filePreviewViewer').classList.add('active');
            document.getElementById('richViewer').classList.add('active');
        });
        const animations = await page.evaluate(() => ['#filePreviewViewer','#richViewer'].map(s => getComputedStyle(document.querySelector(s)).transitionDuration));
        check('preview opening has no animated transition', animations.every(v => v.split(',').every(x => parseFloat(x) === 0)), animations);
        const logos=await page.evaluate(()=>{
            document.body.dataset.theme='orbit';
            const uploaded=document.createElement('img');uploaded.className='sc-cover';uploaded.src='data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg"/>';
            document.body.append(uploaded);const coverFilter=getComputedStyle(uploaded).filter;uploaded.remove();
            return {uploaded:coverFilter,ui:['#topbarStreamingBtn img','#streamingConsoleBtn img'].map(s=>getComputedStyle(document.querySelector(s)).filter)};
        });
        check('Orbit adapts system logos without filtering uploaded covers',logos.uploaded==='none'&&logos.ui.every(v=>v.includes('invert')),logos);
        await page.evaluate(() => {
            document.querySelectorAll('.modal-overlay,.rich-viewer-overlay').forEach(n => n.classList.remove('active'));
            const shell=document.getElementById('appShell');shell.dataset.mobileView='editor';
            shell.querySelector('.main-layout').style.setProperty('--workspace-index',2);
        });
        for (const width of [320,360,390,1100,1152,1200,1280,1366,1440]) {
            await page.setViewportSize({width,height:900});
            for (const theme of themes) {
                const row=await page.evaluate(theme => {
                    document.body.dataset.theme=theme;
                    const n=document.querySelector('.editor-actions');
                    return {width:n.clientWidth,scroll:n.scrollWidth,wrap:[...n.querySelectorAll('button')].some(b=>getComputedStyle(b).whiteSpace!=='nowrap')};
                },theme);
                check(theme+': editor actions fit '+width+'px',row.width>0&&row.scroll<=row.width+1&&!row.wrap,row);
            }
        }
        const translations=await page.evaluate(()=>Object.fromEntries(['zh-Hans','zh-Hant','en','ja','fr','ru','es','it','ko','ms','id','vi','th','fa','km','my'].map(lang=>[lang,TunnelI18n.t('19个节目',lang)])));
        check('program count uses the existing dynamic translation path',translations.en==='19 programs'&&translations['zh-Hant']==='19個節目'&&Object.values(translations).every(v=>v.includes('19')&&!/[{}]/.test(v)),translations);
        const countSwitch=await page.evaluate(()=>{
            const node=document.createElement('span');node.textContent='19个节目';document.body.append(node);
            const authored=document.createElement('div');authored.innerHTML='<p class="message-content">19个节目</p><pre>19个节目</pre><textarea>19个节目</textarea><div contenteditable="true">19个节目</div>';document.body.append(authored);
            TunnelI18n.setLanguage('en');const en=node.textContent;
            const protectedText=[...authored.children].map(n=>n.textContent);
            TunnelI18n.setLanguage('zh-Hans');const zh=node.textContent;
            node.remove();authored.remove();return {en,zh,protectedText};
        });
        check('program count follows live language changes without rebuilding its row or translating authored content',countSwitch.en==='19 programs'&&countSwitch.zh==='19个节目'&&countSwitch.protectedText.every(s=>s==='19个节目'),countSwitch);
        fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify({results}, null, 2));
        for (const result of results) console.log((result.okay ? 'PASS ' : 'FAIL ') + result.name + ' ' + JSON.stringify(result.detail));
        assert.equal(results.filter(r => !r.okay).length, 0, 'Visual feedback regression failures; see ' + out);
    } finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
}
run().catch(error => {console.error(error); process.exitCode=1;});

