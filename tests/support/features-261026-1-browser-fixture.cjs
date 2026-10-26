'use strict';
// Synthetic station/UI fixtures only; no production data, tunnels or Telegram.
const fs = require('node:fs'), path = require('node:path');
const { createFixture } = require('./streaming-console-fixture.cjs');
async function start() {
    const f = await createFixture(), root = path.resolve(__dirname, '../..');
    const appSource = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
    const excerpt = (start, end) => appSource.slice(appSource.indexOf(start), appSource.indexOf(end, appSource.indexOf(start)));
    const device = 'markdown-browser-device';
    f.streaming.service.register(device, 'visual-fixture-key'.repeat(4), '设备-2d66');
    const actor = { deviceId: device, userId: 'alice', logins: [{ id: 'alice', hash: 'fixture-only', expiresAt: Date.now() + 86400000 }] };
    for (let i = 0; i < 3; i++) f.streaming.service.create(actor, { name: ['窄屏布局与长名称测试串流台', 'dell无账号', '第三个串流台'][i] });
    f.app.get('/review-console', (req,res)=>{
        f.sessions.set(req,res,f.auth.user('alice'));
        const setup='<script>localStorage.setItem("deviceId","'+device+'");localStorage.setItem("streaming:'+device+':key","'+ 'visual-fixture-key'.repeat(4) +'");</script>';
        res.type('html').send(fs.readFileSync(path.join(root,'pages/index.html'),'utf8').replace('<head>','<head>'+setup+'<script src="/fixture-bootstrap.js"></script>'));
    });
    f.app.get('/mobile-review', (req, res) => {
        const width = Math.max(320, Math.min(1024, Number(req.query.width) || 390));
        const target=req.query.kind==='menu'?'/interaction-review':'/review-console';
        res.type('html').send('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0;background:#ddd}iframe{border:0;width:' + width + 'px;height:844px;background:white}</style><iframe title="窄屏交互验收" src="'+target+'"></iframe>');
    });
    f.app.get('/interaction-review', (_req, res) => res.type('html').send(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/client/index.css"><link rel="stylesheet" href="/client/streaming-console.css"></head><body style="padding:20px">
        <h1>隔离菜单与转发交互验收</h1><button id="record-menu">记录菜单</button><button id="forward">发到其他隧道</button><button id="perf">对比背景模糊重绘</button><button id="sample-cover">生成封面测试台</button><output id="result"></output>
        <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:12px">${Array.from({length:90},(_,i)=>'<article style="padding:20px;background:#f0f4fa;border:1px solid #ddd;border-radius:12px">传输记录 '+i+'<p>用于验证宽屏背景下的下拉交互</p><img width="36" src="/client/icons/streaming.png"></article>').join('')}</div>
        <script>
        const state={sessionId:'current'},LAST_FORWARD_SESSION_STORAGE_KEY='fixture-last-forward',generateId=()=>crypto.randomUUID();
        const sessions=Array.from({length:16},(_,i)=>({sessionId:'target-'+i,shortCode:String(10000+i),remark:'隔离隧道 '+i}));
        const getAllFromStore=async()=>sessions,escapeHtml=value=>String(value).replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
        function createFileActionButton(text,title,run){const b=document.createElement('button');b.className='history-action';b.textContent=text;b.title=title;b.onclick=run;return b;}
        ${excerpt('function createRecordActionButton(', 'function renderMessageRecordActions(')}
        ${excerpt('function openMessageRecordActionMenu(', 'async function editTransferRecordRemark(')}
        ${excerpt('async function chooseForwardTargetSession()', 'async function cloneForwardFileInfo(')}
        document.getElementById('record-menu').onclick=event=>openMessageRecordActionMenu(event.currentTarget,['详情','复制此锚点','复制文本','收藏','备注','发到其他隧道','创建串流台','添加到串流台','保存到网盘','删除'].map(text=>createRecordActionButton(text.includes('串流台')?'/client/icons/streaming.png':'☰',text,text,()=>document.getElementById('result').textContent=text)));
        document.getElementById('forward').onclick=async()=>{document.getElementById('result').textContent=await chooseForwardTargetSession()||'已取消';};
        document.getElementById('perf').onclick=async()=>{
            const overlay=document.createElement('div');overlay.className='send-mode-overlay';overlay.innerHTML='<div class="send-mode-dialog">隔离渲染测量中</div>';document.body.append(overlay);
            const cards=[...document.querySelectorAll('article')],results=[];
            for(const blur of ['blur(10px)','none']){
                overlay.style.backdropFilter=blur;const gaps=[];let previous;
                await new Promise(resolve=>{const frame=now=>{if(previous!==undefined)gaps.push(now-previous);previous=now;for(let i=0;i<cards.length;i++)cards[i].style.transform='translateX('+Math.sin(now/100+i)*8+'px)';if(gaps.length<100)requestAnimationFrame(frame);else resolve();};requestAnimationFrame(frame);});
                const sorted=gaps.sort((a,b)=>a-b);results.push(blur+': median '+sorted[50].toFixed(1)+'ms / p95 '+sorted[95].toFixed(1)+'ms / max '+sorted[99].toFixed(1)+'ms');
            }
            cards.forEach(card=>card.style.transform='');overlay.remove();document.getElementById('result').textContent=results.join(' | ');
        };
        document.getElementById('sample-cover').onclick=()=>location.href='/fixture-account/alice';
        </script></body></html>`));
    // A second listener exposes this isolated fixture over plain LAN HTTP too.
    const lan = f.app.listen(0, '0.0.0.0'); await new Promise(resolve => lan.once('listening', resolve));
    console.log(JSON.stringify({ base: f.base, lanPort: lan.address().port, dataDir: f.dataDir }));
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { lan.closeAllConnections(); await new Promise(r => lan.close(r)); await f.close(); process.exit(); });
}
if (require.main === module) start().catch(error => { console.error(error); process.exit(1); });
