'use strict';
require('./pending-save-261012-fixture.cjs').createFixture({ serverTransfers: true, listDelayMs: Number(process.env.FIXTURE_LIST_DELAY_MS) || 0 }).then(fixture => {
    fixture.app.get('/fixture-ready', (req, res) => { fixture.sessions.set(req, res, fixture.auth.user('alice')); res.redirect('/sns-dl'); });
    fixture.app.get('/fullscreen-check', (_req, res) => res.type('html').send('<!doctype html><html><body style="margin:0;background:#ddd"><iframe title="390像素播放器验收" src="/fullscreen-player-check" style="width:390px;height:800px;border:0;background:white"></iframe></body></html>'));
    fixture.app.get('/fullscreen-player-check', (_req, res) => res.type('html').send(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/client/index.css"><link rel="stylesheet" href="/client/streaming-console.css"></head><body>
        <section class="sc-overlay"><main class="sc-main"><div class="sc-page sc-viewer-page"><h1>串流台 · 12345 · 隔离播放器</h1><div id="fixture-player"></div></div></main></section>
        <script src="/client/streaming-player.js"></script><script>
        const value={id:'layout',loop:true,visibility:'public',configVersion:1,countdown:'bottom-right',items:[{id:'image',name:'隔离图片',kind:'image',stay:3600}],playback:{itemId:'image',status:'playing',position:0,version:1}};
        const player=StreamingPlayer.create({stationId:'layout',watchId:'fixture-layout',request:async url=>url.endsWith('/ticket')?{url:'/fixture-art.svg',type:'image/svg+xml',expiresAt:Date.now()+3600000}:url.endsWith('/report')?{station:value}: {},subscribe:()=>()=>{},onError:()=>{}});
        document.getElementById('fixture-player').append(player.element);player.apply(value);
        </script></body></html>`));
    fixture.app.get('/fixture-art.svg', (_req,res) => res.type('svg').send('<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360"><defs><linearGradient id="g"><stop stop-color="#271c46"/><stop offset="1" stop-color="#7053a1"/></linearGradient></defs><path fill="url(#g)" d="M0 0h640v360H0z"/><text x="320" y="185" text-anchor="middle" fill="white" font-size="26">Isolated player layout</text></svg>'));
    console.log(JSON.stringify({ base: fixture.base, isolatedDataDir: fixture.dataDir }));
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => fixture.close().then(() => process.exit()));
});
