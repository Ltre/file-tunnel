const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const page = fs.readFileSync(path.join(__dirname, '..', 'pages', 'youtube-premium-dl.html'), 'utf8');

test('Telegram share original-size cover resolves to real image data and custom upload is clearly labelled', () => {
    assert.match(page, /id="tgCoverUploadBtn">自定义封面上传<\/button>/);
    assert.match(page, /async function getTelegramOriginalCoverDataUrl\(task\)/);
    assert.match(page, /\/api\/youtube-premium\/tasks\/\$\{encodeURIComponent\(task\.id\)\}\/thumbnail/);
    assert.match(page, /method: 'POST', cache: 'no-store'/);
    assert.match(page, /tgOriginalCoverDataUrl = await fileToDataUrl\(blob\)/);
    assert.match(page, /if \(select\.value === 'original'\) return getTelegramOriginalCoverDataUrl\(tgShareTask\)/);
    assert.doesNotMatch(page, /if \(select\.value === 'original'\) return 'original'/);
});

test('Telegram share cover choices remain independent for Base Pro and Ultimate', () => {
    assert.match(page, /const coverBase = await resolveTelegramShareCover\(tgCoverBaseSelect\)/);
    assert.match(page, /const coverPro = await resolveTelegramShareCover\(tgCoverProSelect\)/);
    assert.match(page, /const coverUltimate = await resolveTelegramShareCover\(tgCoverUltimateSelect\)/);
    assert.doesNotMatch(page, /coverPro\s*=.*\|\|\s*coverBase/);
    assert.doesNotMatch(page, /coverUltimate\s*=.*\|\|\s*coverBase/);
});
