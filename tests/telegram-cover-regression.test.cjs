const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const page = fs.readFileSync(path.join(__dirname, '..', 'pages', 'youtube-premium-dl.html'), 'utf8');
const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

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
    assert.match(page, /const coverPro = sendPro \? await resolveTelegramShareCover\(tgCoverProSelect\) : '';/);
    assert.match(page, /const coverUltimate = sendUltimate && ultimateMode === 'formal'[\s\S]*\? await resolveTelegramShareCover\(tgCoverUltimateSelect\)[\s\S]*: '';/);
    assert.doesNotMatch(page, /coverPro\s*=.*\|\|\s*coverBase/);
    assert.doesNotMatch(page, /coverUltimate\s*=.*\|\|\s*coverBase/);
});


test('Telegram share shows original-cover acquisition before channel-send steps', () => {
    assert.match(page, /label: '获取原尺寸封面'/);
    assert.match(page, /tgProgressPrefixSteps/);
    assert.match(page, /const allSteps = \[\.\.\.tgProgressPrefixSteps, \.\.\.\(steps \|\| \[\]\)\]/);
    assert.match(page, /if \(!tgProgressDialog\.open\) tgProgressDialog\.showModal\(\)/);
    assert.match(page, /status: 'done',[\s\S]*detail: `已获取，供 \$\{originalCoverLevels\.join\(' \/ '\)\} 使用`/);
});

test('Server preserves explicit square cover instead of inheriting Base cover', () => {
    assert.match(server, /const coverBase = String\(body\.coverBase \|\| ''\)\.trim\(\);/);
    assert.match(server, /const coverPro = String\(body\.coverPro \|\| ''\)\.trim\(\);/);
    assert.match(server, /const coverUltimate = String\(body\.coverUltimate \|\| ''\)\.trim\(\);/);
    assert.doesNotMatch(server, /const coverPro = String\(body\.coverPro \|\| ''\)\.trim\(\) \|\| coverBase/);
    assert.doesNotMatch(server, /const coverUltimate = String\(body\.coverUltimate \|\| ''\)\.trim\(\) \|\| coverBase/);
});

test('Frontend only resolves covers for selected photo-producing levels', () => {
    assert.match(page, /const coverPro = sendPro \? await resolveTelegramShareCover\(tgCoverProSelect\) : '';/);
    assert.match(page, /const coverUltimate = sendUltimate && ultimateMode === 'formal'[\s\S]*\? await resolveTelegramShareCover\(tgCoverUltimateSelect\)[\s\S]*: '';/);
});
