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
