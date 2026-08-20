const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

test('YouTube Premium supports slash-separated artists, source-language reference fields and optional download sections', () => {
  const server = read('server.js');
  const page = read('pages/youtube-premium-dl.html');
  const service = read('server/youtube-premium.js');
  assert.match(server, /Array\.isArray\(meta\.artists\)[\s\S]{0,240}join\('\/'\)/);
  assert.ok(server.indexOf('Array.isArray(meta.artists)') < server.indexOf("typeof meta.artist === 'string'"));
  assert.match(server, /--download-sections/);
  assert.match(page, /id="downloadSectionsInput"/);
  assert.match(page, /sourceTitle: '源语言标题'/);
  assert.match(page, /sourceAlbum: '源语言专辑名'/);
  assert.match(page, /sourceArtist: '源语言艺术家'/);
  assert.match(server, /youtube:lang=\$\{String\(options\.youtubeLanguage\)/);
  assert.match(service, /downloadSections/);
});

test('device detail camera actions use WebRTC signalling bridge', () => {
  const page = read('pages/device.html');
  const camera = read('client/device-camera.js');
  const server = read('server.js');
  assert.match(page, /打开对方的摄像头/);
  assert.match(page, /共享我的摄像头/);
  assert.match(page, /DeviceCameraBridge/);
  assert.match(camera, /new RTCPeerConnection/);
  assert.match(camera, /getUserMedia/);
  assert.match(camera, /pendingIce/);
  for (const event of ['device-camera-request', 'device-camera-response', 'device-camera-signal', 'device-camera-stop']) {
    assert.ok(server.includes(`socket.on('${event}'`) || server.includes(`'${event}'`), event);
  }
});

test('light transfer uses one resumable block protocol for files and collections', () => {
  const light = read('client/light-transfer.js');
  const app = read('app.js');
  const index = read('pages/index.html');
  const server = read('server.js');
  assert.match(light, /const PROTOCOL = 'D2L1'/);
  assert.match(light, /const ATOMIC_BLOCK_SIZE = 256/);
  assert.match(light, /createObjectStore\('tasks'/);
  assert.match(light, /createObjectStore\('chunks'/);
  assert.match(light, /createObjectStore\('receipts'/);
  assert.match(light, /kind: bundle\.kind === 'collection' \? 'collection' : 'file'/);
  assert.match(light, /frameNo % 4 === 0/);
  assert.match(light, /senderSalt/);
  assert.match(light, /扫描到的摘要与上次残片任务不一致/);
  assert.match(light, /data-light-network> 使用网络加速/);
  assert.doesNotMatch(light, /data-light-network checked/);
  assert.match(index, /id="filePreviewLightShareBtn"[^>]*>✴↗</);
  assert.match(index, /id="receiveLightBtn">接收光媒</);
  assert.match(index, /id="scanTunnelCodeBtn">扫描隧道码</);
  assert.match(app, /shareHistoryMessageViaLight/);
  assert.match(app, /message\.type === 'collection'/);
  assert.match(server, /\/api\/light-transfer\/network\/:taskId/);
  assert.match(server, /\/light-file-parts/);
});

test('light file parts page is local-only resume and receipt UI', () => {
  const page = read('pages/light-file-parts.html');
  assert.match(page, /<title>继续光媒接收<\/title>/);
  assert.match(page, /仅保存在当前设备/);
  assert.match(page, /listTasks\(\)/);
  assert.match(page, /listReceipts\(\)/);
  assert.match(page, /light-transfer-resume/);
  assert.match(page, /light-parts-close/);
});

test('Telegram outbound proxy bootstrap and actionable error messages', () => {
  const server = read('server.js');
  assert.match(server, /function resolveTelegramProxyUrl/);
  assert.match(server, /NODE_USE_ENV_PROXY/);
  assert.match(server, /DR2T_PROXY_REEXEC/);
  assert.match(server, /DR2T_PROXY/);
  assert.match(server, /DR2T_ALL_PROXY/);
  assert.match(server, /function describeTelegramNetworkError/);
  assert.match(server, /UND_ERR_CONNECT_TIMEOUT/);
  assert.match(server, /describeTelegramNetworkError\(err\)/);
  assert.match(server, /yt-dlp-song-audio-missing/);
});

test('Telegram song-share runs as a progress-reporting job and persists links to the task', () => {
  const server = read('server.js');
  const service = read('server/youtube-premium.js');
  const page = read('pages/youtube-premium-dl.html');
  assert.match(server, /const telegramSongShareJobs = new Map\(\)/);
  assert.match(server, /async function runSongShareJob/);
  assert.match(server, /function publicSongShareJob/);
  assert.match(server, /setSongShareStep\(job, 'prepare'/);
  assert.match(server, /app\.get\('\/api\/telegram\/song-share\/:jobId'/);
  assert.match(server, /res\.json\(\{ ok: true, jobId: job\.jobId \}\)/);
  assert.match(server, /youtubePremiumService\.setTelegramShare\(job\.taskId/);
  assert.match(server, /function logSongShare\(job, message, details\)/);
  assert.match(server, /已获取 YouTube Premium 任务信息（读取任务缓存，不重复请求 YouTube）/);
  assert.match(server, /require\('\.\/server\/telegram-multipart'\)/);
  assert.match(server, /duplex: 'half'/);
  assert.match(server, /Telegram 音频上传进度/);
  assert.match(server, /Math\.floor\(percent \/ 5\)/);
  assert.match(server, /开始回滚已发送的 Telegram 消息/);
  assert.match(service, /setTelegramShare\(id, share\)/);
  assert.match(service, /telegramShare: task\.telegramShare \|\| null/);
  assert.match(service, /telegramShare: null/);
  assert.match(page, /id="tgProgressDialog"/);
  assert.match(page, /startTelegramSharePolling/);
  assert.match(page, /showTelegramShareResult/);
  assert.match(page, /已发到telegram/);
});

test('Telegram audio multipart streams exact bytes and reports final upload progress', async () => {
  const { buildTelegramAudioMultipart } = require('../server/telegram-multipart');
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'd2t-telegram-multipart-'));
  try {
    const audioPath = path.join(tempDir, 'song.m4a');
    const thumbnailPath = path.join(tempDir, 'thumbnail.jpg');
    const audio = Buffer.alloc(192 * 1024 + 17, 0x5a);
    const thumbnail = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
    fs.writeFileSync(audioPath, audio);
    fs.writeFileSync(thumbnailPath, thumbnail);
    const progress = [];
    const request = buildTelegramAudioMultipart({
      fields: { chat_id: '@channel', performer: '艺术家', title: '歌曲名' },
      audioPath,
      audioFileName: '测试歌曲.m4a',
      thumbnailPath,
      onAudioProgress: (uploaded, total) => progress.push({ uploaded, total })
    });
    const chunks = [];
    for await (const chunk of request.body) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks);
    assert.equal(body.length, request.contentLength);
    assert.equal(request.audioSize, audio.length);
    assert.equal(request.thumbnailSize, thumbnail.length);
    assert.match(request.contentType, /^multipart\/form-data; boundary=----Drop2Tunnel/);
    assert.ok(body.includes(audio));
    assert.ok(body.includes(thumbnail));
    assert.match(body.toString('utf8', 0, 1400), /filename="测试歌曲\.m4a"/);
    assert.deepEqual(progress.at(-1), { uploaded: audio.length, total: audio.length });
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('yt-dlp "page needs to be reloaded" is mapped and retried with a fallback player client', () => {
  const server = read('server.js');
  assert.match(server, /page needs to be reloaded\|must be reloaded\|reload the page/);
  assert.match(server, /player_client=\$\{String\(options\.playerClient\)/);
  assert.match(server, /playerClient: 'web_embedded,android,tv_embedded'/);
  assert.match(server, /playerClientFallback !== false/);
});

test('Telegram share panel always shows per-level caption/cover fields without the unified toggle', () => {
  const page = read('pages/youtube-premium-dl.html');
  assert.doesNotMatch(page, /id="tgCaptionUnified"/);
  assert.doesNotMatch(page, /id="tgCoverUnified"/);
  assert.doesNotMatch(page, /id="tgCoverSource"/);
  assert.match(page, /id="tgCoverUploadBtn"/);
  assert.match(page, /id="tgCaptionBaseSplit"/);
  assert.match(page, /id="tgCoverProSelect"/);
  assert.match(page, /\[hidden\] \{ display:none !important; \}/);
  assert.match(page, /let showPro = tgSharePro\.checked/);
});

test('external integrations expose a centralized dependency inventory and always-on failure diagnostics', () => {
  const server = read('server.js');
  const app = read('app.js');
  const media = read('client/media.js');
  const camera = read('client/device-camera.js');
  for (const dependency of [
    'telegram-bot-api',
    'youtube-yt-dlp',
    'sns-yt-dlp',
    'yt-dlp-remote-components',
    'webrtc-ice-services',
    'local-media-toolchain'
  ]) {
    assert.ok(server.includes(`id: '${dependency}'`), dependency);
  }
  assert.match(server, /function recordExternalDependencyEvent/);
  assert.match(server, /source: 'external-dependency'/);
  assert.match(server, /\/api\/admin\/external-dependencies/);
  assert.match(server, /function telegramFetchJson/);
  assert.match(server, /function auditExternalRuntimeDependencies/);
  assert.match(server, /youtube-music-album-search/);
  assert.match(server, /youtube-music-album-traverse/);
  assert.match(server, /No native or album-derived Track number was available; Track=1 was applied/);
  assert.match(app, /webrtc-ice-server-error/);
  assert.match(media, /media-ice-server-error/);
  assert.match(camera, /device-camera-ice-server-error/);
});

test('Ultimate trial record is a verified Telegram text_link to Pro Tp with preview disabled', () => {
  const server = read('server.js');
  assert.match(server, /const trialPrefix = '入选试行：\\n'/);
  assert.match(server, /type: 'text_link'/);
  assert.match(server, /offset: trialPrefix\.length/);
  assert.match(server, /length: captionUltimate\.length/);
  assert.match(server, /url: tpLink/);
  assert.match(server, /entities: \[trialEntity\]/);
  assert.match(server, /ultimate-trial-link-entity-missing/);
  assert.match(server, /String\(entity\.url \|\| ''\) === tpLink/);
  assert.match(server, /link_preview_options: \{ is_disabled: true \}/);
  assert.match(server, /disable_web_page_preview: true/);
  assert.doesNotMatch(server, /trialCaption = `入选试行/);
});


test('light transfer keeps the last valid QR visible and adaptively shrinks optical frames', () => {
  const light = read('client/light-transfer.js');
  assert.match(light, /const MANIFEST_PART_CHARS = 240/);
  assert.match(light, /normal: \{ label: '常规距离', blocksPerFrame: 1/);
  assert.match(light, /near: \{ label: '近距离', blocksPerFrame: 2/);
  assert.match(light, /far: \{ label: '远距离', blocksPerFrame: 1, fps: 4/);
  assert.match(light, /normal: \{ label: '常规距离', blocksPerFrame: 1, fps: 8/);
  assert.match(light, /near: \{ label: '近距离', blocksPerFrame: 2, fps: 12/);
  assert.match(light, /const displaySize = Math\.max\(120, Math\.min\(mode\.qrSize, availableWidth, availableHeight\)\)/);
  assert.match(light, /staging\.style\.padding = `\$\{quietPx\}px`/);
  assert.match(light, /const renderCostMs = performance\.now\(\) - renderStartedAt/);
  assert.match(light, /\(1000 \/ mode\.fps\) - renderCostMs/);
  assert.match(light, /const staging = document\.createElement\('div'\)/);
  assert.match(light, /Only replace the visible QR after the next frame has been generated/);
  assert.match(light, /qr\.replaceChildren\(staging\)/);
  assert.match(light, /createSummaryFrame\(share, networkToggle\.checked, true\)/);
  assert.match(light, /\[自动缩减\]/);
  assert.match(light, /当前帧容量异常，已保留上一帧/);
  assert.doesNotMatch(light, /帧过长已跳过/);
  assert.match(light, /body\.o = providerOrigin/);
  assert.match(light, /body\.pd = providerDeviceId/);
  assert.match(light, /JSON\.stringify\(body\)\.replace\(\/\[\\uD800-\\uDFFF\]\//);
  assert.match(light, /_makeFrame: makeFrame/);
});

test('light transfer QR frames escape surrogate pairs without changing parsed emoji titles', () => {
  const makeNode = () => ({
    children: [],
    setAttribute() {},
    setAttributeNS() {},
    appendChild(child) { this.children.push(child); return child; },
    removeChild(child) { this.children = this.children.filter(item => item !== child); return child; },
    hasChildNodes() { return this.children.length > 0; },
    get lastChild() { return this.children[this.children.length - 1] || null; }
  });
  const context = {
    TextEncoder,
    TextDecoder,
    Uint8Array,
    ArrayBuffer,
    encodeURI,
    navigator: { userAgent: '' },
    document: {
      documentElement: { tagName: 'svg' },
      getElementById: makeNode,
      createElementNS: makeNode
    },
    window: {
      addEventListener() {},
      location: { origin: 'https://example.test' }
    }
  };
  vm.createContext(context);
  vm.runInContext(`${read('client/qrcode-1.0.0.min.js')};window.QRCode=QRCode;`, context);
  vm.runInContext(read('client/light-transfer.js'), context);

  const title = '🎵'.repeat(20);
  const body = {
    v: 1, t: 'a'.repeat(64), k: 's', mh: 'b'.repeat(64),
    z: 999999999, bc: 99999, bs: 256, n: 1, q: title, ty: 'file',
    o: 'https://example.com', pd: 'device', ne: false
  };
  const legacyFrame = `D2L1:${JSON.stringify(body)}`;
  assert.throws(() => new context.window.QRCode(makeNode(), {
    text: legacyFrame,
    width: 500,
    height: 500,
    correctLevel: context.window.QRCode.CorrectLevel.L
  }), /code length overflow/);

  const safeFrame = context.window.Drop2TunnelLightTransfer._makeFrame(body);
  assert.match(safeFrame, /\\ud83c\\udfb5/);
  assert.equal(context.window.Drop2TunnelLightTransfer.parseFrame(safeFrame).q, title);
  assert.doesNotThrow(() => new context.window.QRCode(makeNode(), {
    text: safeFrame,
    width: 500,
    height: 500,
    correctLevel: context.window.QRCode.CorrectLevel.L
  }));
});

test('YouTube Premium song parsing and automatic download tolerate logged-in cookie format-set changes', () => {
  const server = read('server.js');
  const service = read('server/youtube-premium.js');
  assert.match(server, /ignoreNoFormats: true,[\s\S]*allowIgnoreNoFormatsFallback: false/);
  assert.match(server, /For songs, do not run a second metadata command with -f/);
  assert.match(server, /playerClient: 'web_safari,web,android_vr,tv_embedded'/);
  assert.match(server, /youtube-premium-audio-format-probe-recovered/);
  assert.match(server, /function isYtDlpRequestedFormatUnavailable/);
  assert.match(server, /bestaudio\/best\[acodec!=none\]\/best/);
  assert.match(server, /strictFormatSelection: Boolean\(customSelector\)/);
  assert.match(server, /allowFormatFallback: !customSelector/);
  assert.match(server, /YouTube 当前登录态\/播放器客户端返回的可用格式集合不完整/);
  assert.match(server, /function logYoutubePremiumTaskEvent\(event = \{\}\)/);
  assert.match(server, /\[YouTube Premium抓取\]\[task:/);
  assert.match(server, /基础元信息与格式库存获取完成/);
  assert.match(server, /格式库存已标准化/);
  assert.match(server, /最终格式选择已通过校验/);
  assert.match(server, /启动 yt-dlp 歌曲与封面下载/);
  assert.match(server, /歌曲成品校验完成/);
  assert.match(server, /启动 yt-dlp 媒体下载/);
  assert.match(server, /视频\/单轨成品校验并移动完成/);
  assert.match(service, /onLog = \(\) => \{\}/);
  assert.match(service, /percent - progressLog\.lastPercent >= 5/);
  assert.match(service, /now - progressLog\.lastAt >= 5000/);
  assert.match(service, /emitLog\(task, '下载进度'/);
});


test('YouTube song metadata consumes yt-dlp plural composer and genre fields', () => {
  const server = read('server.js');
  assert.match(server, /function getYoutubeComposerValue/);
  assert.match(server, /Array\.isArray\(meta\.composers\)/);
  assert.match(server, /composers\.join\('\/'\)/);
  assert.match(server, /function getYoutubeGenreValue/);
  assert.match(server, /Array\.isArray\(meta\.genres\)/);
  assert.match(server, /genres\.join\(', '\)/);
  assert.match(server, /composer: sanitizeString\(getYoutubeComposerValue\(meta\), 240\)/);
  assert.match(server, /genre: sanitizeString\(getYoutubeGenreValue\(meta\), 240\)/);
});

test('YouTube song credits can fall back to explicit credit lines in auto-generated music descriptions', () => {
  const server = read('server.js');
  assert.match(server, /function getYoutubeMusicDescriptionCredits/);
  assert.match(server, /Provided to YouTube by\|Auto-generated by YouTube\|℗/);
  assert.ok(server.includes('\\bcomposer\\b|作曲'));
  assert.ok(server.includes('\\bgenre\\b|ジャンル'));
  assert.match(server, /descriptionCredits\.composers\.join\('\/'\)/);
  assert.match(server, /descriptionCredits\.genres\.join\(', '\)/);
});

test('socket relay treats receiver-already-cached as idempotent skip instead of server error', () => {
  const serverAssets = read('server/file-assets.js');
  const clientAssets = read('client/file-assets.js');
  assert.match(serverAssets, /function emitWithAckResult/);
  assert.match(serverAssets, /rejectionReason === 'receiver-already-cached'/);
  assert.match(serverAssets, /ackOk\(ack, \{ skipped: true, reason: rejectionReason \}\)/);
  assert.match(serverAssets, /file-asset-relay-skipped/);
  assert.match(clientAssets, /startAck\?\.skipped && startAck\.reason === 'receiver-already-cached'/);
  assert.match(clientAssets, /relay-skipped-receiver-already-cached/);
});
