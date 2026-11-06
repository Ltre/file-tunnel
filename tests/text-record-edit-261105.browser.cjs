'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { chromium } = require(path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));
const source = fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8');
const section = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
test('text menu opens the existing modal, retains failed input and applies only a confirmed edit', async t => {
    const browser = await chromium.launch({ channel: 'chrome', headless: true }); t.after(() => browser.close());
    const page = await browser.newPage();
    await page.setContent('<div class="message"><div class="message-bubble">old</div></div>');
    await page.addStyleTag({ path: 'client/index.css' });
    await page.addScriptTag({ content: `
        const state={sessionId:'tunnel'}, message={id:'record',type:'text',sessionId:'tunnel',text:'old'};
        const getFromStore=async()=>message, escapeHtml=text=>text.replace(/[&<>"']/g,'_'), RECORD_REMARK_MAX_LENGTH=1000;
        const showAppToast=text=>window.toast=text, markSelectedHistoryRow=()=>{};
        window.fail=true; window.payloads=[];
        state.socket={connected:true,timeout:()=>({emit:(_event,data,ack)=>{
            window.payloads.push(data); setTimeout(()=>ack(null,window.fail?{ok:false,error:'text-conflict'}:{ok:true,message:{...message,text:data.text}}),25);
        }})};
        const applyHistoryMessageUpdate=async value=>{Object.assign(message,value);document.querySelector('.message-bubble').textContent=value.text;};
        function createFileActionButton(text,title,run){const button=document.createElement('button');button.textContent=text;button.className='history-action';button.onclick=run;return button;}
        ${section('function createRecordActionButton(', 'const selectedHistoryIds =')}
        ${section('function openMessageRecordActionMenu(', 'async function editTransferRecordText(')}
        ${section('async function editTransferRecordText(', 'async function editTransferRecordRemark(')}
        ${section('let transferRecordEditorBack = null;', 'async function chooseForwardTargetSession(')}
        renderMessageRecordActions(document.querySelector('.message'),message);
    ` });
    await page.locator('.message-record-menu-trigger').click();
    const menu = page.getByRole('menu');
    assert.deepEqual((await menu.locator('.history-action').allTextContents()).slice(0, 2), ['ℹ详情', '✎编辑文本']);
    await menu.getByText('编辑文本', { exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.locator('textarea').fill('新文本\n<plain> 😀');
    await dialog.getByRole('button', { name: '保存', exact: true }).click();
    await dialog.getByRole('status').waitFor();
    assert.equal(await dialog.locator('textarea').inputValue(), '新文本\n<plain> 😀');
    assert.equal(await page.locator('.message-bubble').textContent(), 'old');
    await page.evaluate(() => window.fail = false);
    await dialog.getByRole('button', { name: '保存', exact: true }).click();
    await dialog.waitFor({ state: 'detached' });
    assert.equal(await page.locator('.message-bubble').textContent(), '新文本\n<plain> 😀');
    assert.equal(await page.evaluate(() => toast), '已保存文本');
    assert.equal(await page.evaluate(() => payloads[0].baseText), 'old');
});
