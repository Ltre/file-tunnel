'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { listDataUsage, resolveDataUsageDirectory } = require('../server/data-usage');
const source = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

test('数据占用页只遍历 .tunnel-data 内目录并按占用大小倒序返回', async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'data-usage-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.mkdirSync(path.join(root, 'small')); fs.mkdirSync(path.join(root, 'large'));
    fs.writeFileSync(path.join(root, 'small', 'a'), Buffer.alloc(10));
    fs.writeFileSync(path.join(root, 'large', 'b'), Buffer.alloc(30000));
    const listing = await listDataUsage(root);
    assert.deepEqual(listing.entries.map(entry => entry.name), ['large', 'small']);
    assert.equal((await listDataUsage(root, 'large')).entries[0].name, 'b');
    assert.throws(() => resolveDataUsageDirectory(root, '../outside'), /INVALID_DATA_USAGE_PATH/);
});

test('Step3 网盘交互包含 ESC、属性历史、原生媒体右键、控件手势隔离及选择器顶层模式', () => {
    const ui = source('client/disk-ui.js'), css = source('client/disk.css');
    assert.match(ui, /event\.key === 'Escape'.*closeDiskPreview\(\)/);
    assert.match(ui, /historyEntry: true, dismissOnBackdrop: true/);
    assert.match(ui, /telegramDriveDialogHistoryOpen.*closeTelegramDriveDialog\(null, \{ fromHistory: true \}\)/s);
    assert.doesNotMatch(ui, /wrapper\.oncontextmenu/);
    assert.match(ui, /\.disk-media-controls,\.disk-media-action-row,input,button/);
    assert.match(css, /telegram-drive-picker-mode\{z-index:/);
    assert.match(css, /disk-media-seek-loader:before/);
    assert.match(css, /\.disk-media-stage video\{[^}]*position:absolute;[^}]*inset:0;[^}]*object-fit:contain;[^}]*object-position:center center/);
    assert.match(css, /telegram-drive-manager:not\(\.telegram-drive-has-selection\).*telegram-drive-item-check/);
});

test('媒体进度持久化、缩略图和播放结束补全浏览器缓存均已接入', () => {
    const ui = source('client/disk-ui.js');
    assert.match(ui, /telegram-drive-media-progress-v1/);
    assert.match(ui, /localStorage\.setItem\(diskMediaProgressKey/);
    assert.match(ui, /putThumbnail\(item\.id, blob\)/);
    assert.match(ui, /media\.addEventListener\('ended'.*DiskClient\.read\(item, \{ silentLoading: true \}\)/s);
});

test('播放器不再用重载 URL 冒充 Range 恢复，预览返回只消费网盘自己的历史项', () => {
    const ui = source('client/disk-ui.js');
    assert.doesNotMatch(ui, /purpose:\s*'media-retry'/);
    assert.doesNotMatch(ui, /recoverMediaRequest/);
    assert.match(ui, /history\.replaceState\(base[\s\S]*history\.pushState\(\{ \.\.\.base, telegramDrivePreview: true \}/);
    assert.match(ui, /diskPreviewHistoryOpen[\s\S]*event\.stopImmediatePropagation\(\)[\s\S]*closeDiskPreview\(\{ fromHistory: true \}\)/);
    assert.match(ui, /Math\.min\(99,/);
});

test('移动端长按进入拖动模式并以双指单击打开上下文菜单', () => {
    const ui = source('client/disk-ui.js'), page = source('pages/index.html');
    assert.match(ui, /function installContextGesture\(element, open, beginTouchDrag = null\)/);
    assert.match(ui, /touches\.size === 2/);
    assert.match(ui, /function beginTouchDiskDrag/);
    assert.match(ui, /dataset\.diskDropPath/);
    assert.match(page, /telegram-drive-touch-drag/);
});

test('SNS 预览关闭会释放媒体，参考信息交互会暂停刷新；Premium 支持创建前备注', () => {
    const sns = source('pages/sns-dl.html'), premium = source('pages/youtube-premium-dl.html');
    assert.match(sns, /previewDialog\.addEventListener\('close', disposePreview\)/);
    assert.match(sns, /media\.pause\(\)[\s\S]*media\.removeAttribute\('src'\)/);
    assert.match(sns, /data-reference-interacting|referenceInteracting/);
    assert.match(sns, /isTaskRefreshPaused/);
    assert.match(premium, /id="preDownloadRemarkInput"/);
    assert.match(premium, /remark: preDownloadRemarkInput\.value\.trim\(\)/);
});

test('网盘菜单、播放器释放、缩略图调度和预览层级的回归保护', () => {
    const ui = source('client/disk-ui.js'), css = source('client/disk.css');
    assert.match(ui, /telegramDriveMenuHistoryClosing/);
    assert.match(ui, /button\.onclick = event => \{\s*event\.preventDefault\(\);\s*event\.stopPropagation\(\);/);
    assert.match(ui, /if \(driveMenu && !driveMenu\.hidden/);
    assert.match(ui, /media\._disposeDiskMedia = \(\) => \{[\s\S]*media\.pause\(\)[\s\S]*media\.removeAttribute\('src'\)[\s\S]*media\.load\(\)/);
    assert.match(ui, /queueMicrotask\(\(\) => scheduleTelegramDriveThumbnail\(item, icon\)\)/);
    assert.match(ui, /driveDialog\.parentElement !== document\.body/);
    assert.match(css, /body>\.telegram-drive-subdialog\{position:fixed;z-index:2147483170\}/);
    assert.match(css, /disk-media-seek-loader\{[^}]*left:var\(--seek-thumb-position\)/);
    assert.match(ui, /7 - ratio \* 14/);
    assert.match(css, /disk-preview-image-spinner/);
});

test('管理后台暴露受鉴权保护的数据占用页面和 API', () => {
    const server = source('server.js'), admin = source('pages/admin.html');
    assert.match(server, /app\.get\('\/data-usage'/);
    assert.match(server, /app\.get\('\/api\/admin\/data-usage', adminAuth\.requireAuth/);
    assert.match(admin, /href="\/data-usage"/);
});
