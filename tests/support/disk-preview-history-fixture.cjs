'use strict';
// Browser regression against the real UI and History API, using only local data.
// Run: node tests/support/disk-preview-history-fixture.cjs
const express = require('express'), fs = require('node:fs'), path = require('node:path');
const root = path.join(__dirname, '../..'), app = express(); app.use(express.json());
const reportFile = path.join(require('node:os').tmpdir(), 'file-tunnel-disk-preview-history-report.json');
let report = { status: 'pending' };
const image = '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="90"><rect width="160" height="90" fill="cornflowerblue"/></svg>';
app.get('/', (req, res) => {
    let html = fs.readFileSync(path.join(root, 'pages/index.html'), 'utf8').replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '');
    html = html.replace('</body>', '<script src="/client/disk-client.js"></script><script src="/client/disk-ui.js"></script><script src="/fixture.js"></script></body>');
    res.type('html').send(html);
});
app.get('/api/telegram/drive/me', (req, res) => res.json({ identity: { id: 'fixture', name: '本地历史回归' }, enabled: true, configured: true }));
app.get('/api/telegram/drive/list', (req, res) => {
    const current = String(req.query.path || ''), parts = current.split('/').filter(Boolean);
    res.json({ path: current, breadcrumbs: parts.map((name, index) => ({ name, path: parts.slice(0, index + 1).join('/') })),
        summary: { folderCount: 1, fileCount: 1 }, folders: [{ kind: 'directory', name: '下一层', path: [current, '下一层'].filter(Boolean).join('/') }],
        files: [{ id: 'fixture-image', kind: 'file', name: '测试图片.svg', path: current, type: 'image/svg+xml', size: Buffer.byteLength(image) }] });
});
app.get('/api/telegram/drive/files/fixture-image/stream', (req, res) => res.type('svg').send(image));
app.get('/api/telegram/drive/files/fixture-image', (req, res) => res.type('svg').send(image));
app.get('/api/telegram/drive/operations', (req, res) => res.json({ operations: [] }));
app.get('/report', (req, res) => res.json(report));
app.post('/report', (req, res) => { report = req.body; fs.writeFileSync(reportFile, JSON.stringify(report)); console.log(JSON.stringify(report)); res.json({ ok: true }); });
app.get('/fixture.js', (req, res) => res.type('js').send(`
(async () => {
    const results=[], sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
    const until=async check=>{for(let n=0;n<100;n++){if(check())return;await sleep(25)}throw Error('等待 UI 超时')};
    let hostEvents=[];
    window.addEventListener('popstate',event=>{hostEvents.push({state:event.state,phase:event.eventPhase,driveHidden:document.getElementById('telegramDriveOverlay').hidden})}); // registered BEFORE DiskUI.init
    window.DiskUI.init(); window.DiskUI.init(); // repeated initialization must be harmless
    const row=name=>[...document.querySelectorAll('#telegramDriveList .telegram-drive-item')].find(el=>el.querySelector('.telegram-drive-item-name').textContent===name);
    const enter=async name=>{const previous=window.DiskUI.path;row(name).dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));await until(()=>window.DiskUI.path!==previous);await window.DiskUI.render();await until(()=>row('测试图片.svg'))};
    const preview=async()=>{row('测试图片.svg').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));await until(()=>!document.getElementById('diskPreview').hidden);await until(()=>document.querySelector('#diskPreviewBody img')?.complete)};
    const assert=(ok,message)=>{if(!ok)throw Error(message)};
    try {
        await window.DiskUI.open();
        hostEvents=[];
        for(const reopen of [false,true]) {
            await enter('下一层');await enter('下一层');
            const current=window.DiskUI.path;
            if(reopen){document.getElementById('closeTelegramDriveBtn').click();await window.DiskUI.open()}
            await preview();document.getElementById('diskPreviewClose').click();document.getElementById('diskPreviewClose').click();
            await until(()=>!history.state?.telegramDrivePreview);await sleep(150);
            assert(!document.getElementById('telegramDriveOverlay').hidden,'关闭预览误关网盘');assert(window.DiskUI.path===current,'关闭预览误跳目录');
            results.push(reopen?'关闭再打开网盘后预览关闭：通过':'连续切换目录后预览关闭：通过');
            await enter('下一层');history.back();await until(()=>window.DiskUI.path===current);await sleep(50);
            results.push('关闭预览后的下一次返回导航：通过');
            await preview();history.back();await until(()=>document.getElementById('diskPreview').hidden);await sleep(50);
            assert(window.DiskUI.path===current,'返回预览误跳目录');
            results.push('返回键只关闭预览：通过');
        }
        assert(hostEvents.length===0,'首页监听器重复处理网盘返回：'+JSON.stringify(hostEvents));results.push('脚本加载时注册监听器隔离首页历史：通过');
        document.getElementById('closeTelegramDriveBtn').click();
        const output=document.createElement('pre');output.textContent='PASS\\n'+results.join('\\n');output.style.cssText='position:fixed;inset:20px;background:white;color:black;padding:20px;z-index:99999';document.body.append(output);
        await fetch('/report',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({status:'passed',results})});
    }catch(error){await fetch('/report',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({status:'failed',error:error.message,path:window.DiskUI.path,results})});document.body.textContent='FAIL: '+error.message}
})();
`));
app.use('/client', express.static(path.join(root, 'client')));
app.listen(3188, '127.0.0.1', () => console.log('History regression fixture: http://127.0.0.1:3188/'));
