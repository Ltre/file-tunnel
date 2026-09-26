'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = name => fs.readFileSync(path.join(__dirname, '..', name), 'utf8');

function workshopTools() {
    const window = {};
    vm.runInNewContext(source('client/web-workshop.js'), { window, Uint8Array, TextEncoder, TextDecoder, Blob, Map, Set, Date, Math, String, Number, Object, Array, RegExp, Error, Promise, URL, setTimeout, clearTimeout });
    return window.WebWorkshop._test;
}

test('网页 ZIP 发布清单保留创建时刻、更新编辑时刻和两个打开选项', () => {
    const tools = workshopTools();
    const first = '2026-09-25T01:02:03.000Z';
    const draft = { name:'日本語网页', createdAt:Date.parse(first), webZipHideFrame:true, webZipFullscreen:true, files:[{path:'index.html',type:'text/html',data:new TextEncoder().encode('<p>ok</p>')}] };
    tools.updatePackageManifest(draft);
    const manifest = tools.readPackageManifest(draft.files);
    assert.equal(manifest.fileName, '日本語网页.html.zip');
    assert.equal(manifest.webZipHideFrame, true);
    assert.equal(manifest.webZipFullscreen, true);
    assert.equal(manifest.createdAt, first);
    assert.match(manifest.updatedAt, /Z$/);
    assert.equal(draft.files.filter(entry => entry.path === 'manifest.json').length, 1);
    tools.updatePackageManifest(draft);
    assert.equal(draft.files.filter(entry => entry.path === 'manifest.json').length, 1);
});

test('拖入多语言媒体资源时生成相对引用并对非 ASCII 路径编码', () => {
    const tools = workshopTools();
    const path = tools.relativeZipPath('pages/index.html', '资源/日本語 图片.png');
    assert.equal(path, '../%E8%B5%84%E6%BA%90/%E6%97%A5%E6%9C%AC%E8%AA%9E%20%E5%9B%BE%E7%89%87.png');
    const tag = tools.mediaHtmlTag({ path:'资源/日本語 图片.png', type:'image/png' }, 'pages/index.html');
    assert.match(tag, /<img src="\.\.\//);
    assert.match(tag, /width="640" height="360"/);
});
