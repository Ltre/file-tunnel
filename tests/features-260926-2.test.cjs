'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function workshopTools() {
    const window = {};
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../client/web-workshop.js'), 'utf8'), {
        window, Uint8Array, TextEncoder, TextDecoder, Blob, Map, Set, Date, Math, String, Number,
        Object, Array, RegExp, Error, Promise, URL, setTimeout, clearTimeout
    });
    return window.WebWorkshop._test;
}

test('网页工坊子文件和子目录校验非法字符、长度与 20 层边界', () => {
    const tools = workshopTools();
    assert.equal(tools.newTreeEntryPath('父级/', '子目录/脚本/页面.html', 'file'), '父级/子目录/脚本/页面.html');
    for (const input of ['a"b', 'a\\b', 'a<b', 'a>b', 'a:b', 'a//b', '../b']) {
        assert.throws(() => tools.newTreeEntryPath('父级/', input, 'file'), error => error.code === 'WEB_PATH_INVALID' && Boolean(error.message));
        assert.throws(() => tools.newTreeEntryPath('父级/', input, 'directory'), error => error.code === 'WEB_PATH_INVALID' && Boolean(error.message));
    }
    assert.throws(() => tools.newTreeEntryPath('', 'a'.repeat(256), 'file'), /255 字节/);
    assert.throws(() => tools.newTreeEntryPath('', Array.from({length: 5}, () => 'a'.repeat(220)).join('/'), 'directory'), /1024 字节/);
    const twenty = Array.from({length:20}, (_,i) => `d${i}`).join('/') + '/';
    assert.equal(tools.newTreeEntryPath(twenty, 'ok.html', 'file'), twenty + 'ok.html');
    assert.throws(() => tools.newTreeEntryPath(twenty, 'child', 'directory'), /20 层/);
    assert.throws(() => tools.newTreeEntryPath(twenty, 'child/ok.html', 'file'), /20 层/);
});

test('拖入 JS/CSS/HTML 文件生成可执行、可访问且经过路径编码的 HTML 引用', () => {
    const tools = workshopTools();
    assert.equal(tools.mediaHtmlTag({path:'assets/脚本.js'},'pages/index.html'), '<script src="../assets/%E8%84%9A%E6%9C%AC.js"></script>');
    assert.equal(tools.mediaHtmlTag({path:'assets/样式.css'},'pages/index.html'), '<link rel="stylesheet" href="../assets/%E6%A0%B7%E5%BC%8F.css">');
    assert.equal(tools.mediaHtmlTag({path:'pages/子页.html'},'pages/index.html'), '<a href="/pages/%E5%AD%90%E9%A1%B5.html" target="">子页.html</a>');
});

test('资源移动和重命名只更新 HTML 中可确定的包内引用，保留代码与外部链接', () => {
    const tools = workshopTools();
    const html = '<img src="../assets/pic.png?size=1#top"><a href="/assets/pic.png">图片</a><!-- <img src="../assets/pic.png"> --><script>const demo = "<img src=\\"../assets/pic.png\\">";</script><script src="../assets/app.js"></script><a href="https://example.com/assets/pic.png">外部</a>';
    const entries = tools.normalizeEntries([
        {path:'pages/index.html',type:'text/html',data:new TextEncoder().encode(html)},
        {path:'pages/second.htm',type:'text/html',data:new TextEncoder().encode('<img src="../assets/pic.png">')},
        {path:'assets/pic.png',type:'image/png',data:new Uint8Array([1])},
        {path:'assets/app.js',type:'text/javascript',data:new Uint8Array([2])},
        {path:'media/',type:'application/x-directory'}
    ]);
    const moved = tools.assertDestination(entries,'assets/pic.png','media/').entries;
    const changed = new TextDecoder().decode(moved.find(item=>item.path==='pages/index.html').data);
    assert.match(changed, /\.\.\/media\/pic\.png\?size=1#top/);
    assert.match(changed, /href="\/media\/pic\.png"/);
    assert.match(changed, /<!-- <img src="\.\.\/assets\/pic\.png"> -->/);
    assert.match(changed, /const demo = .*assets\/pic\.png/);
    assert.match(changed, /https:\/\/example\.com\/assets\/pic\.png/);
    assert.match(changed, /<script src="\.\.\/assets\/app\.js"><\/script>/);
    assert.match(new TextDecoder().decode(moved.find(item=>item.path==='pages/second.htm').data), /\.\.\/media\/pic\.png/);
    const renamed = tools.renameEntry(entries,'assets/','resources').entries;
    assert.match(new TextDecoder().decode(renamed.find(item=>item.path==='pages/index.html').data), /\.\.\/resources\/app\.js/);
    const movedPage = tools.assertDestination(entries,'pages/index.html','').entries;
    assert.match(new TextDecoder().decode(movedPage.find(item=>item.path==='index.html').data), /src="assets\/pic\.png\?size=1#top"/);
});

test('网盘选择转发目标隧道并点击继续后直接发送，不再弹二次 confirm', async () => {
    let exporter, dialog, sent, confirmations = 0;
    const element = tag => ({ tag, children:[], append(...nodes){ this.children.push(...nodes); }, setAttribute(){}, showModal(){}, close(){}, remove(){}, focus(){} });
    const document = { createElement:element, body:{ append(node){ dialog = node; } } };
    const localStorage = { getItem:() => null, setItem(){} };
    const window = { DiskUI:{ setExporter(callback){ exporter = callback; }, close(){} }, DiskClient:{ read:async () => new Blob(['abc']) } };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../client/disk-tunnel-adapter.js'), 'utf8'), {
        window, document, localStorage, File, Blob, confirm:() => { confirmations++; return true; }
    });
    window.DiskTunnelAdapter.configure({ tunnels:async () => [{ id:'current', shortCode:'ABC', current:true }], target:() => ({ id:'current' }), send:files => { sent = files; } });
    const forwarding = exporter([{ id:'file-1', name:'a.txt', type:'text/plain' }]);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(dialog.tag, 'dialog');
    dialog.children[2].value = 'current';
    dialog.children[3].children[1].onclick();
    await forwarding;
    assert.equal(confirmations, 0);
    assert.equal(sent.length, 1);
});
