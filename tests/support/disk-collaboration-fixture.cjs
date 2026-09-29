'use strict';
// Isolated browser regression: synthetic files only, no real accounts, disk data or Telegram calls.
// Run: node tests/support/disk-collaboration-fixture.cjs, then open http://127.0.0.1:3196/?check=1
const express = require('express'), fs = require('node:fs'), path = require('node:path');
const root = path.join(__dirname, '../..'), app = express(); app.use(express.json());
const grant = { id: 'guest-project', kind: 'directory', path: '共享', name: '共享', owned: false };
let directories = ['共享', '共享/来源', '共享/来源/内层', '共享/目标', '私密'];
let files = [{ id: 'file-a', name: '内容.txt', folderPath: '共享', type: 'text/plain', size: 1 }];
let moves = [], report = { status: 'pending' };
const folders = () => directories.map(p => ({ kind: 'directory', name: p.split('/').pop(), path: p, parentPath: p.split('/').slice(0, -1).join('/') }));
app.get('/', (req, res) => {
    if (req.query.check) {
        directories = ['共享', '共享/来源', '共享/来源/内层', '共享/目标', '私密'];
        files = [{ id: 'file-a', name: '内容.txt', folderPath: '共享', type: 'text/plain', size: 1 }]; moves = []; report = { status: 'pending' };
    }
    let html = fs.readFileSync(path.join(root, 'pages/index.html'), 'utf8').replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '');
    html = html.replace('</body>', '<script src="/client/disk-client.js"></script><script src="/client/disk-directory-picker.js"></script><script src="/client/disk-ui.js"></script><script src="/fixture.js"></script></body>');
    res.type('html').send(html);
});
app.get('/disk-collab/view/:id', (req, res) => res.sendFile(path.join(root, 'pages/disk-collaboration.html')));
app.get('/api/telegram/drive/me', (req, res) => res.json({ identity: { id: 'fixture', name: '本地协同回归' }, enabled: true, configured: true }));
app.get('/api/telegram/drive/collaborations', (req, res) => res.json({ collaborations: [grant, { id: 'owned-project', kind: 'directory', name: '原网盘目录', path: '原网盘目录', owned: true }] }));
app.get('/api/telegram/drive/collaborations/:id', (req, res) => res.json({ collaboration: grant }));
app.get('/api/telegram/drive/spaces', (req, res) => res.json({ spaces: [] }));
for (const prefix of ['/api/telegram/drive', '/api/telegram/drive/collaboration-scope/guest-project']) {
    const scoped = prefix.includes('collaboration-scope');
    app.get(prefix + '/operations', (req, res) => res.json({ operations: [] }));
    app.get(prefix + '/list', (req, res) => {
        const p = req.query.path || '';
        const parts = p.split('/').filter(Boolean);
        res.json({ path: p, folders: scoped ? folders().filter(d => d.parentPath === p) : [{ kind: 'directory', name: '原网盘目录', path: '原网盘目录' }], files: scoped ? files.filter(f => f.folderPath === p) : [],
            breadcrumbs: parts.map((name, i) => ({ name, path: parts.slice(0, i + 1).join('/') })), summary: { folderCount: 2, fileCount: 1, size: 1 } });
    });
    app.get(prefix + '/directories', (req, res) => res.json({ directories: folders().filter(d => !scoped || d.path === '共享' || d.path.startsWith('共享/')) }));
    app.post(prefix + '/directories', (req, res) => {
        const parts = req.body.path.split('/').filter(Boolean), p = parts.join('/');
        for (let i = 1; i <= parts.length; i++) { const next = parts.slice(0, i).join('/'); if (!directories.includes(next)) directories.push(next); }
        res.json({ status: 'completed', result: { path: p }, operation_id: 'immediate-mkdir' });
    });
    app.patch(prefix + '/files/:id', (req, res) => { const file = files.find(f => f.id === req.params.id); moves.push(req.body); Object.assign(file, req.body); res.json(file); });
    app.patch(prefix + '/directories', (req, res) => {
        const from = req.body.path, to = req.body.destinationPath + '/' + from.split('/').pop();
        directories = directories.map(p => p === from || p.startsWith(from + '/') ? to + p.slice(from.length) : p);
        files.forEach(file => { if (file.folderPath === from || file.folderPath.startsWith(from + '/')) file.folderPath = to + file.folderPath.slice(from.length); });
        moves.push(req.body); res.json({ path: to });
    });
}
app.get('/fixture-state', (req, res) => res.json({ files, directories, moves }));
app.post('/fixture-report', (req, res) => { report = req.body; res.json({ ok: true }); });
app.get('/fixture-report', (req, res) => res.json(report));
app.get('/fixture.js', (req, res) => res.type('js').send(`
window.DiskUI.init({formatFileSize:bytes=>bytes+' B'});
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const until=async fn=>{for(let n=0;n<120;n++){const value=fn();if(value)return value;await sleep(40);}throw Error('等待界面超时');};
const assert=(condition,message)=>{if(!condition)throw Error(message);};
const named=(doc,selector,text)=>[...doc.querySelectorAll(selector)].find(node=>node.textContent===text);
const fileRow=doc=>[...doc.querySelectorAll('.row')].find(row=>row.querySelector('.name').textContent==='内容.txt');
const folderRow=(doc,name)=>[...doc.querySelectorAll('.row')].find(row=>row.querySelector('.name').textContent===name);
const drop=(row,target)=>{const data=new DataTransfer();row.dispatchEvent(new DragEvent('dragstart',{bubbles:true,cancelable:true,dataTransfer:data}));target.dispatchEvent(new DragEvent('dragover',{bubbles:true,cancelable:true,dataTransfer:data}));target.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:data}));};
const touch=(node,type,x,y)=>{const event=new Event(type,{bubbles:true,cancelable:true});Object.defineProperty(event,'touches',{value:type==='touchend'?[]:[{clientX:x,clientY:y}]});node.dispatchEvent(event);};
const results=[];
async function check(){
 await DiskUI.open();await until(()=>document.querySelector('#telegramDriveList .telegram-drive-item'));
 document.getElementById('telegramDriveCollaborationListBtn').click();await until(()=>document.querySelector('.disk-collaboration-entry'));
 [...document.querySelectorAll('.disk-collaboration-entry')].find(button=>button.textContent.includes('受邀加入')).click();
 const layer=await until(()=>document.querySelector('.disk-collaboration-frame[open]')),frame=layer.querySelector('iframe');
 await until(()=>frame.contentDocument?.querySelector('.row'));const doc=frame.contentDocument;
 const rect=layer.getBoundingClientRect();assert(rect.width===innerWidth&&rect.height===innerHeight,'协同 iframe 未覆盖整个视口');
 assert(doc.getElementById('returnHome').hidden,'iframe 未隐藏返回首页');results.push('全视口 iframe 与独立页 header 区分');
 named(fileRow(doc),'button','移动').click();const picker=await until(()=>doc.querySelector('.collab-action-dialog[open]'));
 assert(![...picker.querySelectorAll('[data-folder-path]')].some(node=>node.dataset.folderPath==='私密'),'目录树泄露授权外目录');
 const target=picker.querySelector('[data-folder-path="共享/目标"]');target.click();
 named(picker,'button','在所选目录新建子目录').click();const child=picker.querySelector('.disk-folder-editor');child.querySelector('input').value='新建/多级';named(child,'button','创建').click();
 await until(()=>picker.querySelector('[data-folder-path="共享/目标/新建/多级"]'));
 named(picker.querySelector('footer'),'button','移动').click();await until(()=>!fileRow(doc));results.push('目录树选择、新建多级子目录和移动');
 folderRow(doc,'目标').querySelector('.name button').click();await until(()=>folderRow(doc,'新建'));folderRow(doc,'新建').querySelector('.name button').click();await until(()=>folderRow(doc,'多级'));folderRow(doc,'多级').querySelector('.name button').click();await until(()=>fileRow(doc));
 drop(fileRow(doc),doc.querySelector('#breadcrumbs button'));const confirmation=await until(()=>doc.querySelector('.collab-action-dialog[open]'));
 named(confirmation.querySelector('footer'),'button','取消').click();assert(fileRow(doc),'取消拖放却移动了文件');await sleep(720);
 drop(fileRow(doc),doc.querySelector('#breadcrumbs button'));const confirmAgain=await until(()=>doc.querySelector('.collab-action-dialog[open]'));named(confirmAgain.querySelector('footer'),'button','移动').click();await until(()=>!fileRow(doc));results.push('文件拖到根面包屑、取消不执行');
 doc.querySelector('#breadcrumbs button').click();await until(()=>folderRow(doc,'来源'));
 drop(folderRow(doc,'来源'),folderRow(doc,'目标'));const dirConfirm=await until(()=>doc.querySelector('.collab-action-dialog[open]'));named(dirConfirm.querySelector('footer'),'button','移动').click();await until(()=>!folderRow(doc,'来源'));results.push('目录拖入目录并确认');
 await sleep(720);const row=fileRow(doc),r=row.getBoundingClientRect(),dest=folderRow(doc,'目标').getBoundingClientRect();
 touch(row,'touchstart',r.left+50,r.top+15);await sleep(480);touch(row,'touchmove',dest.left+50,dest.top+15);await sleep(80);touch(row,'touchend',dest.left+50,dest.top+15);
 const touchConfirm=await until(()=>doc.querySelector('.collab-action-dialog[open]'));named(touchConfirm.querySelector('footer'),'button','移动').click();await until(()=>!fileRow(doc));results.push('模拟单指长按拖放到目录');
 await sleep(720);folderRow(doc,'目标').querySelector('.name button').click();await until(()=>folderRow(doc,'来源'));
 drop(folderRow(doc,'来源'),doc.querySelector('#breadcrumbs button'));const back=await until(()=>doc.querySelector('.collab-action-dialog[open]'));named(back.querySelector('footer'),'button','移动').click();await until(()=>!folderRow(doc,'来源'));results.push('目录拖到根面包屑');
 document.querySelector('.disk-collaboration-frame-close').click();await until(()=>!document.querySelector('.disk-collaboration-frame'));
 assert(!document.getElementById('telegramDriveOverlay').hidden,'关闭协同 iframe 错关了原网盘');assert(document.getElementById('telegramDriveList').textContent.includes('原网盘目录'),'原目录状态被改动');results.push('关闭 iframe 返回原网盘');
 document.getElementById('telegramDriveCollaborationListBtn').click();await until(()=>document.querySelector('.disk-collaboration-entry'));
 [...document.querySelectorAll('.disk-collaboration-entry')].find(button=>button.textContent.includes('我创建的')).click();await until(()=>document.getElementById('telegramDriveBreadcrumbs').textContent.includes('根目录'));
 assert(!document.querySelector('.disk-collaboration-frame'),'所有者项目错误打开 iframe');results.push('所有者项目维持主网盘定位');
 await fetch('/fixture-report',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({status:'passed',results})});
}
if(new URLSearchParams(location.search).has('check'))check().catch(async error=>{await fetch('/fixture-report',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({status:'failed',results,error:error.message,stack:error.stack})});});
else DiskUI.open();
`));
app.use('/client', express.static(path.join(root, 'client')));
app.listen(3196, '127.0.0.1', () => console.log('Isolated collaboration fixture: http://127.0.0.1:3196/?check=1'));
