'use strict';
const {test,before,after}=require('node:test'),assert=require('node:assert/strict');
const path=require('node:path'),os=require('node:os'),express=require('express');
const {chromium}=require(path.join(os.homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));
let browser,server,base;
before(async()=>{
    const app=express();app.get('/case',(_req,res)=>res.type('html').send('<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/client/browser-logs.css"><script defer src="/client/i18n-catalog.js"></script><script defer src="/client/i18n.js"></script><script defer src="/client/browser-logs.js"></script><h3>系统日志管理</h3><button id="viewErrorLogsBtn">查看错误日志</button><button id="viewOperationLogsBtn">查看普通操作日志</button>'));
    app.use(express.static(path.resolve(__dirname,'..')));server=await require('./support/listen-http.cjs').listenHttp(app);base='http://127.0.0.1:'+server.address().port;
    browser=await chromium.launch({channel:'chrome',headless:true});
});
after(async()=>{await browser?.close();if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}});
async function pageFor(t){const context=await browser.newContext({locale:'zh-CN'});t.after(()=>context.close());const page=await context.newPage();await page.goto(base+'/case');return page;}
test('browser logs persist independently, separate types, paginate and redact credentials and binary bodies',async t=>{
    const page=await pageFor(t);
    await page.evaluate(async()=>{
        for(let i=0;i<125;i++)BrowserLogs.record('operation','fixture-case '+i,{token:'private-token',password:'password-secret',data:new Uint8Array(100000)});
        console.error('fixture-error',{cookie:'cookie-secret',accessGrant:'grant-secret'});await BrowserLogs.flush();
    });await page.reload();
    const result=await page.evaluate(async()=>{
        const filter={kind:'operation',keyword:'fixture-case',from:0,to:Date.now()},first=await BrowserLogs.query(filter),second=await BrowserLogs.query({...filter,before:first.at(-1).id});
        return{count:await BrowserLogs.count(filter),first:first.length,second:second.length,ids:new Set([...first,...second].map(x=>x.id)).size,
            serialized:JSON.stringify(first),errors:await BrowserLogs.count({kind:'error',keyword:'fixture-error'})};
    });
    assert.deepEqual({count:result.count,first:result.first,second:result.second,ids:result.ids,errors:result.errors},{count:125,first:100,second:25,ids:125,errors:1});
    assert.doesNotMatch(result.serialized,/private-token|password-secret|cookie-secret|grant-secret/);assert.match(result.serialized,/redacted/);assert.match(result.serialized,/omitted/);
});
test('time and keyword ranges export only matches and delete inclusive endpoints without touching other logs',async t=>{
    const page=await pageFor(t);
    const result=await page.evaluate(async()=>{
        const now=Date.now(),realNow=Date.now;
        for(let i=0;i<7;i++){Date.now=()=>now-(6-i)*60000;BrowserLogs.record('operation','fixture-selected '+i);}
        BrowserLogs.record('error','fixture-selected error');Date.now=realNow;await BrowserLogs.flush();
        const records=(await BrowserLogs.query({kind:'operation',keyword:'fixture-selected'})).reverse();
        const filter={kind:'operation',from:records[1].time,to:records[5].time,keyword:'fixture-selected',firstId:records[2].id,lastId:records[4].id};
        const exported=(await (await BrowserLogs.exportLogs(filter)).text()).trim().split('\n').map(line=>JSON.parse(line));
        const removed=await BrowserLogs.remove(filter);
        return{exported,removed,remaining:await BrowserLogs.count({kind:'operation',keyword:'fixture-selected'}),errors:await BrowserLogs.count({kind:'error',keyword:'fixture-selected'})};
    });
    assert.equal(result.exported[0].format,'TunnelBrowserLogs');assert.equal(result.exported.length,4);
    assert.deepEqual(result.exported.slice(1).map(x=>x.message),['fixture-selected 4','fixture-selected 3','fixture-selected 2']);
    assert.equal(result.removed,3);assert.equal(result.remaining,4);assert.equal(result.errors,1);
});
test('all time presets and minute-accurate custom endpoints are valid, including calendar month ends',async t=>{
    const page=await pageFor(t);
    const result=await page.evaluate(()=>{
        const now=new Date(2026,2,31,12,30).getTime();return{
            presets:['m15','h1','h3','d1','d3','w1','w2','month','quarter','half','year','all'].map(value=>BrowserLogs.timeRange(value,now)),
            month:new Date(BrowserLogs.timeRange('month',now).from).getDate(),custom:BrowserLogs.timeRange('custom',now,'2026-03-31T12:00','2026-03-31T12:01')};
    });
    assert.ok(result.presets.every(x=>x.from<x.to));assert.equal(result.month,28);assert.equal(result.custom.to-result.custom.from,119999);
});
test('export pagination remains complete when another tab or a clock change writes timestamps out of ID order',async t=>{
    const page=await pageFor(t);
    const result=await page.evaluate(async()=>{
        const now=Date.now(),realNow=Date.now;
        try {
            for(let batch=0;batch<6;batch++) {
                for(let i=0;i<100;i++){Date.now=()=>now-((batch*100+i)%300)*1000;BrowserLogs.record('operation','fixture-clock '+(batch*100+i));}
                Date.now=realNow;await BrowserLogs.flush();
            }
        } finally {Date.now=realNow;}
        const records=(await (await BrowserLogs.exportLogs({kind:'operation',keyword:'fixture-clock',to:now})).text()).trim().split('\n').slice(1).map(line=>JSON.parse(line));
        return{count:records.length,unique:new Set(records.map(entry=>entry.id)).size};
    });
    assert.deepEqual(result,{count:600,unique:600});
});
test('log manager UI filters, exports and confirms inclusive range deletion',async t=>{
    const page=await pageFor(t);page.on('dialog',dialog=>dialog.accept());
    await page.evaluate(async()=>{for(let i=0;i<5;i++)BrowserLogs.record('operation','fixture-ui '+i);await BrowserLogs.flush();});
    await page.getByRole('button',{name:'查看普通操作日志',exact:true}).click();
    await page.getByRole('searchbox',{name:'关键词检索'}).fill('fixture-ui');await page.getByRole('button',{name:'筛选日志',exact:true}).click();
    await page.waitForFunction(()=>document.querySelector('.browser-log-list')?.children.length===5);
    await page.getByRole('button',{name:'设为首条',exact:true}).nth(1).click();await page.getByRole('button',{name:'设为尾条',exact:true}).nth(3).click();
    const download=page.waitForEvent('download');await page.getByRole('button',{name:'导出检索结果'}).click();assert.match((await download).suggestedFilename(),/operation-logs.*\.jsonl$/);
    await page.getByRole('button',{name:'删除首尾范围',exact:true}).click();
    await page.waitForFunction(()=>document.querySelector('.browser-log-status')?.textContent.includes('已删除 3 条日志'));
    assert.equal(await page.locator('.browser-log-list li').count(),2);
    await page.getByRole('button',{name:'关闭',exact:true}).click();assert.equal(await page.locator('.browser-log-layer').count(),0);
});
test('log UI uses the real localization runtime and formats counts after translating the message',async t=>{
    const page=await pageFor(t);
    await page.evaluate(async()=>{BrowserLogs.record('operation','fixture-english');await BrowserLogs.flush();TunnelI18n.setLanguage('en');BrowserLogs.open('operation');});
    await page.getByRole('button',{name:'Filter logs',exact:true}).waitFor();
    await page.waitForFunction(()=>/\d+ entries on this page/.test(document.querySelector('.browser-log-status')?.textContent));
    assert.doesNotMatch(await page.locator('.browser-log-status').textContent(),/\{\d\}/);
    assert.equal(await page.getByRole('heading',{name:'View operation logs',exact:true}).count(),1);
});
