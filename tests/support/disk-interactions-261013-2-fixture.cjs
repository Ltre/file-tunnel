'use strict';
// Isolated browser verification: real drive API, no user data or Telegram traffic.
const {createFixture}=require('./pending-save-261012-fixture.cjs');
const fs=require('node:fs'),path=require('node:path');
(async()=>{
    const f=await createFixture();f.store.createDirectory('alice','56',30);
    f.app.get('/fixture-login/:id',(req,res)=>{f.sessions.set(req,res,f.auth.user(req.params.id));res.redirect('/disk');});
    f.app.get('/fixture-wrap',(_req,res)=>{
        const page=fs.readFileSync(path.join(__dirname,'../../pages/index.html'),'utf8'),styles=[...page.matchAll(/<style\b[^>]*>[\s\S]*?<\/style>|<link\b[^>]*\brel=["']stylesheet["'][^>]*>/gi)].map(match=>match[0]).join('\n');
        const name='file_00000000e03c61f68d09cea2d1a10cba'.repeat(3)+'.png';
        res.type('html').send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${styles}<body class="telegram-drive-dialog-open"><div id="telegramDriveDialog" class="telegram-drive-subdialog"><div class="telegram-drive-dialog-card"><div class="telegram-drive-dialog-header"><strong>待上传文件重名</strong><button>×</button></div><div class="telegram-drive-dialog-body"><p>本次上传中有 1 个文件与同一目标目录中的其它待上传文件重名。自动追加序号后上传？\n/1561653/${name} → ${name.replace('.png',' (2).png')}\n不会修改设备原文件；取消将停止整次上传。</p></div><div class="telegram-drive-dialog-actions"><button>取消</button><button>自动重命名并上传</button></div></div></div></body>`);
    });
    console.log(JSON.stringify({url:f.base+'/fixture-login/alice',dataDir:f.dataDir}));
    process.once('SIGINT',()=>f.close().then(()=>process.exit()));
})().catch(error=>{console.error(error);process.exitCode=1;});
