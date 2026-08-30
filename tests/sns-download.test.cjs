'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createSnsDownloadService, normalizeSnsDownloadUrl } = require('../server/sns-downloader');

const ROOT = path.join(__dirname, '..');
const read = relative => fs.readFileSync(path.join(ROOT, relative), 'utf8');

function waitFor(check, timeoutMs = 3000) {
    const startedAt = Date.now();
    return new Promise((resolve, reject) => {
        const tick = () => {
            const value = check();
            if (value) return resolve(value);
            if (Date.now() - startedAt >= timeoutMs) return reject(new Error('wait-timeout'));
            setTimeout(tick, 15);
        };
        tick();
    });
}

test('SNS URL normalization accepts only the dedicated non-YouTube platforms', () => {
    assert.equal(normalizeSnsDownloadUrl('https://www.tiktok.com/@demo/video/123?utm_source=x').platform, 'tiktok');
    assert.equal(normalizeSnsDownloadUrl('https://mobile.x.com/demo/status/123?s=20').platform, 'x');
    assert.equal(normalizeSnsDownloadUrl('https://www.threads.net/@demo/post/abc').platform, 'threads');
    assert.throws(() => normalizeSnsDownloadUrl('https://youtube.com/watch?v=abc'), /sns-download-url-required/);
});

test('SNS task service persists and downloads independently from YouTube Premium', async t => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'drop2tunnel-sns-download-'));
    t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
    const service = createSnsDownloadService({
        dataDir,
        analyze: async url => ({
            url, platform: 'tiktok', title: '独立 SNS 成品', cover: '', mediaType: 'video',
            formats: [{ id:'best', kind:'video_audio' }], referenceInfo: { extractor:'TikTok' },
            selection: { ids:['best'], formats:[{ id:'best', kind:'video_audio' }], formatSelector:'best', outputContainer:'mp4', summary:{ finalFormat:'best' } }
        }),
        download: async ({ taskDir }) => {
            const outputPath = path.join(taskDir, 'sns.mp4');
            fs.writeFileSync(outputPath, 'sns-output');
            return { outputPath, outputFileName:'sns.mp4', outputFileSize:10, title:'独立 SNS 成品' };
        }
    });
    const created = service.create({ url:'https://www.tiktok.com/@demo/video/123' });
    const completed = await waitFor(() => service.get(created.id)?.status === 'completed' && service.get(created.id));
    assert.equal(completed.platform, 'tiktok');
    assert.equal(completed.referenceInfo.extractor, 'TikTok');
    assert.ok(fs.existsSync(path.join(dataDir, 'sns-download-tasks.json')));
    assert.ok(fs.existsSync(path.join(dataDir, 'sns-downloads', created.id, 'sns.mp4')));
    assert.equal(fs.existsSync(path.join(dataDir, 'youtube-premium-tasks.json')), false);
    assert.equal(fs.existsSync(path.join(dataDir, 'youtube-premium-downloads')), false);
});

test('/sns-dl uses ordinary SNS cookies, its own parse cache, and an empty tag preset', () => {
    const server = read('server.js');
    const page = read('pages/sns-dl.html');
    const service = read('server/sns-downloader.js');
    assert.match(server, /SNS_DOWNLOAD_METADATA_CACHE_PATH/);
    assert.match(server, /getSnsCookieFileForUrl\(normalized\.url\)/);
    assert.match(server, /createSnsDownloadService\(\{/);
    assert.match(server, /app\.get\(\['\/sns-dl', '\/sns-dl\.html'\]/);
    assert.match(page, /const SNS_PREDEFINED_TAGS = Object\.freeze\(\[\s*\/\/ '示例标签一'/);
    assert.doesNotMatch(page, /AlarmClock|８９０／Mugen/);
    assert.match(page, /抓取标签/);
    assert.match(page, /\/client\/sns-download-cache\.js/);
    assert.doesNotMatch(service, /youtube-premium|require\('\.\/youtube-premium'\)/i);
});

test('contact voice has ring tones, speech capture processing and ICE recovery', () => {
    const app = read('app.js');
    const media = read('client/media.js');
    const page = read('pages/index.html');
    assert.match(page, /id="callRingtoneSelect"/);
    assert.match(page, /经典双音铃/);
    assert.match(page, /轻柔提示铃/);
    assert.match(page, /数字短促铃/);
    assert.match(page, /id="callRingtoneFileInput"[^>]+accept="audio\/\*"/);
    assert.match(app, /call\?\.state === 'dialing' \? 'ringback'/);
    assert.match(app, /call\?\.state === 'incoming' \? 'ringtone'/);
    assert.match(app, /createDynamicsCompressor\(\)/);
    assert.match(app, /gain\.gain\.value = 1\.35/);
    for (const constraint of ['echoCancellation', 'noiseSuppression', 'autoGainControl', 'sampleRate', 'channelCount']) {
        assert.match(media, new RegExp(`${constraint}:`));
    }
    assert.match(media, /setCodecPreferences\(preferred\)/);
    assert.match(media, /createOffer\(\{ iceRestart: true \}\)/);
    assert.match(media, /跨蜂窝网络通常需要在 tunnel\.config\.json 配置可用 TURN/);
});
