'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = name => fs.readFileSync(path.join(__dirname, '..', name), 'utf8');

test('网页 ZIP 使用 Service Worker 虚拟目录运行完整文件树', () => {
    const window = { crypto:{ randomUUID:()=>'runtime-id' } };
    vm.runInNewContext(source('client/web-zip-runtime.js'), {
        window, Uint8Array, Date, Math, String, Number, Object, Array, Error, Promise,
        setTimeout, clearTimeout
    });
    assert.equal(window.WebZipRuntime._test.normalizePath('../site/assets/app.js'), 'site/assets/app.js');
    assert.match(window.WebZipRuntime._test.guessType('app.mjs'), /javascript/);
    assert.equal(window.WebZipRuntime._test.guessType('module.wasm'), 'application/wasm');

    const worker = source('service-worker.js');
    assert.match(worker, /url\.pathname\.startsWith\('\/web-zip-runtime\/'\)/);
    assert.match(worker, /handleWebZipRuntime/);
    assert.match(worker, /getWebZipRuntimeReferrer/);
    assert.match(worker, /runtimeReferrerId/);
    assert.match(source('client/web-zip-runtime.js'), /entryPath:entry\.path, rootPath/);
    assert.match(worker, /redirectWebZipRuntimeRoot/);
    assert.match(worker, /Response\.redirect\(target\.href, 307\)/);
    assert.match(worker, /Access-Control-Allow-Origin/);
    assert.match(worker, /Cross-Origin-Resource-Policy/);
    assert.match(worker, /status:206/);
    assert.match(worker, /web-zip-runtime-ping/);
    assert.match(worker, /instant-tunnel-v61/);

    const standalone = source('pages/web-zip-preview.html');
    assert.match(standalone, /WebZipRuntime\.mount\(entries,/);
    assert.match(standalone, /viewer\.src=runtime\.url/);
    assert.doesNotMatch(standalone, /\.srcdoc\s*=/);
    assert.doesNotMatch(standalone, /createObjectURL/);
});

test('网页工坊预览读取当前草稿并强制解包传输记录的当前 ZIP', () => {
    const workshop = source('client/web-workshop.js');
    assert.match(workshop, /commitEditorBuffer\(activeDraft\);revokePreviewUrls\(\)/);
    assert.match(workshop, /global\.WebZipRuntime\.mount\(files,/);
    assert.match(workshop, /packageSandbox\(fileInfo,blob,true\)/);
    assert.match(workshop, /网页 ZIP 解压后没有可编辑文件/);
    assert.match(workshop, /data-web-package-name/);
    assert.match(workshop, /function commitPackageName\(draft\)/);
    assert.doesNotMatch(workshop, /web-workshop-current-name/);
    assert.doesNotMatch(workshop, /\.srcdoc\s*=/);
});

test('草稿支持改名和来源传输记录锚点', () => {
    const workshop = source('client/web-workshop.js');
    const app = source('app.js');
    assert.match(workshop, /data-action="rename">改名/);
    assert.match(workshop, /🔗 原记录/);
    assert.match(workshop, /config\.focusMessage/);
    assert.match(app, /focusMessage: messageId => focusTransferRecordById/);
});

test('网页 ZIP 更新先验证本机新版本缓存并让远端设备自动拉取', () => {
    const app = source('app.js');
    assert.match(app, /网页 ZIP 新版本未能完整写入本机缓存/);
    assert.match(app, /await refreshFileMessage\(fileInfo\.id\)/);
    assert.match(app, /!options\.remote \|\| Boolean\(message\.fileInfo\?\.replacesFileId \|\| getCollectionFiles\(message\)\.some/);
});

test('网盘菜单脱离带 backdrop-filter 的卡片并统一按视口定位', () => {
    const page = source('pages/index.html');
    const diskCss = source('client/disk.css');
    const diskUi = source('client/disk-ui.js');
    assert.match(page, /id="telegramDriveDialog"[\s\S]*?<\/section>\s*<div class="telegram-drive-menu-backdrop"/);
    assert.match(diskCss, /#telegramDriveItemMenu\{position:fixed!important;right:auto!important;bottom:auto!important/);
    assert.doesNotMatch(diskCss, /#telegramDriveItemMenu\{[^}]*inset:auto!important/);
    assert.match(diskUi, /const availableWidth = Math\.max\(1, rightEdge - leftEdge - 16\)/);
    assert.match(diskUi, /menu\.scrollHeight/);
});

test('路由页在桌面与移动端使用独立固定顶栏显示品牌标题', () => {
    const page = source('pages/index.html');
    assert.match(page, /\.tunnel-landing-topbar\s*\{[\s\S]*?position:\s*fixed/);
    assert.match(page, /id="sessionLanding"[\s\S]*?<header class="tunnel-landing-topbar"><strong>🚀 Drop2Tunnel-即时传输隧道<\/strong><\/header>/);
    assert.doesNotMatch(page, /tunnel-landing-main">\s*<div class="header">/);
});
