const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
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
  assert.match(service, /setTelegramShare\(id, share\)/);
  assert.match(service, /telegramShare: task\.telegramShare \|\| null/);
  assert.match(service, /telegramShare: null/);
  assert.match(page, /id="tgProgressDialog"/);
  assert.match(page, /startTelegramSharePolling/);
  assert.match(page, /showTelegramShareResult/);
  assert.match(page, /已发到telegram/);
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

test('Ultimate trial record is a clickable Pro Tp hyperlink with link preview disabled', () => {
  const server = read('server.js');
  assert.match(server, /const trialCaption = `入选试行：\\n<a href="\$\{escapeHtmlServer\(tpLink\)\}">\$\{escapeHtmlServer\(captionUltimate\)\}<\/a>`/);
  assert.match(server, /parse_mode: 'HTML'/);
  assert.match(server, /link_preview_options: \{ is_disabled: true \}/);
  assert.match(server, /disable_web_page_preview: true/);
});

test('light transfer keeps the last valid QR visible and adaptively shrinks optical frames', () => {
  const light = read('client/light-transfer.js');
  assert.match(light, /const MANIFEST_PART_CHARS = 240/);
  assert.match(light, /normal: \{ label: '常规距离', blocksPerFrame: 1/);
  assert.match(light, /near: \{ label: '近距离', blocksPerFrame: 2/);
  assert.match(light, /const staging = document\.createElement\('div'\)/);
  assert.match(light, /Only replace the visible QR after the next frame has been generated/);
  assert.match(light, /qr\.replaceChildren\(\.\.\.Array\.from\(staging\.childNodes\)\)/);
  assert.match(light, /createSummaryFrame\(share, networkToggle\.checked, true\)/);
  assert.match(light, /\[自动缩减\]/);
  assert.match(light, /当前帧容量异常，已保留上一帧/);
  assert.doesNotMatch(light, /帧过长已跳过/);
  assert.match(light, /body\.o = providerOrigin/);
  assert.match(light, /body\.pd = providerDeviceId/);
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
