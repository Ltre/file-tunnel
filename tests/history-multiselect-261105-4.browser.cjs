'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { chromium } = require(path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));
const source = fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8');
const section = (a, b) => source.slice(source.indexOf(a), source.indexOf(b, source.indexOf(a)));
test('touch selection retains the touched row and Back exits selection in both viewport sizes', async t => {
    const browser = await chromium.launch({ channel: 'chrome', headless: true }); t.after(() => browser.close());
    for (const width of [390, 1200]) {
        const page = await browser.newPage({ viewport: { width, height: 740 }, hasTouch: true });
        await page.setContent(`<main style="height:650px;display:flex;flex-direction:column">
            <div id="chatMessages" class="chat-messages" style="flex:1;min-height:0">
            ${Array.from({length:140},(_,i)=>`<div class="message" data-message-id="r${i}" data-type="text" style="animation:none"><div class="message-header">Device</div><div class="message-bubble">Record ${i}</div><div class="message-record-actions"><button>☰</button></div></div>`).join('')}
            </div><div id="fileUploadComposer" style="height:70px;flex:none">Upload</div><div class="input-area"><input id="textInput" value="draft"></div>
            <div id="historySelectionActions" class="history-selection-actions" hidden></div></main>`);
        await page.addStyleTag({path:'client/index.css'});
        for (const file of ['themes-legacy','themes','themes-blamen','themes-lusns']) await page.addStyleTag({path:'client/'+file+'.css'});
        await page.addScriptTag({content:`const state={sessionId:'tunnel'}, musicPlayer={}, mediaFullscreenHistoryOpen=false, suppressNextFilePreviewPopstate=false, filePreviewHistoryOpen=false, richViewerHistoryOpen=false;
            const trapHomeBackNavigation=()=>{window.unexpectedBack=(window.unexpectedBack||0)+1;return true;};
            ${section('const selectedHistoryIds =', 'async function toggleTransferRecordFavorite(')}
            ${section("window.addEventListener('popstate', event => {", 'function normalizeRichHistory(')}
            initHistoryRecordSelection();`});
        const row = page.locator('[data-message-id="r90"]'), chat = page.locator('#chatMessages');
        await page.locator('#textInput').focus();
        await row.evaluate(node=>{const chat=document.getElementById('chatMessages');chat.scrollTop+=node.getBoundingClientRect().top-chat.getBoundingClientRect().top-80;});
        const before = (await row.boundingBox()).y;
        await row.dispatchEvent('pointerdown',{pointerType:'touch',pointerId:8,clientX:width-15,clientY:before+10});
        await page.locator('.history-selection-check').waitFor();
        await row.dispatchEvent('pointerup',{pointerType:'touch',pointerId:8});
        await page.waitForTimeout(150);
        assert.ok(Math.abs((await row.boundingBox()).y-before)<3, 'entering selection must retain the touched row');
        for (const theme of ['classic','graphite','atelier','social','lumen','orbit','blamen','lusns']) {
            await page.evaluate(theme=>document.body.dataset.theme=theme,theme);
            const colors=await page.evaluate(()=>['.history-selection-check','.history-selection-count','.history-selection-cancel'].map(selector=>{
                const style=getComputedStyle(document.querySelector(selector));return [style.color,style.borderColor];
            }));
            assert.equal(colors[1][0],colors[0][0],theme+' count');assert.equal(colors[2][0],colors[0][0],theme+' cancel');assert.equal(colors[2][1],colors[0][0],theme+' border');
        }
        await page.evaluate(()=>history.back());
        await page.locator('#historySelectionActions').waitFor({state:'hidden'});
        assert.equal(await page.locator('#textInput').inputValue(),'draft');
        assert.equal(await page.evaluate(()=>window.unexpectedBack||0),0);
        assert.ok(await chat.evaluate(node=>node.scrollTop>0));
        await row.click({button:'right',position:{x:width-45,y:10}});
        await page.locator('#historySelectionActions').getByRole('button',{name:'取消',exact:true}).click();
        await page.waitForTimeout(80);assert.equal(await page.evaluate(()=>window.unexpectedBack||0),0,'Cancel consumes its own history entry');
        await page.close();
    }
});

test('plain text rendering preserves line breaks, blank lines and spaces without interpreting HTML', async t=>{
    const browser=await chromium.launch({channel:'chrome',headless:true});t.after(()=>browser.close());const page=await browser.newPage();
    await page.setContent('<div id="chatMessages"></div>');await page.addStyleTag({path:'client/index.css'});
    await page.addScriptTag({content:`const state={sessionId:'tunnel'},isHistoryMessageDeleted=()=>false,isChatNearBottom=()=>false,getMessageElement=()=>null,
      escapeHtml=text=>text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'),formatTransferTimestamp=()=> 'time',
      syncTransferRecordFavoriteBadge=()=>{},syncTransferRecordSnsBadge=()=>{},renderMessageRecordActions=()=>{},insertMessageElementByTimestamp=(container,node)=>container.append(node);
      ${section('async function addMessageToChat(', 'function getFileInfoFromMessageElement(')}`});
    const text='第一行  保留空格\n\n  第二段 <b>原文</b>';
    await page.evaluate(text=>addMessageToChat({id:'plain',type:'text',text,senderName:'Device',timestamp:1},false,{scroll:false}),text);
    const bubble=page.locator('.message-bubble');assert.equal(await bubble.textContent(),text);assert.equal(await bubble.locator('b').count(),0);
    assert.equal(await bubble.evaluate(node=>getComputedStyle(node).whiteSpace),'pre-wrap');
    const height=await bubble.evaluate(node=>node.getBoundingClientRect().height);assert.ok(height>60);
});
