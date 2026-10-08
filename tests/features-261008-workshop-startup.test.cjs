'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

function workshopTools() {
    const window = {};
    vm.runInNewContext(read('client/web-workshop.js'), {
        window, Uint8Array, TextEncoder, TextDecoder, Blob, Map, Set, Date, Math, String,
        Number, Object, Array, RegExp, Error, Promise, URL, setTimeout, clearTimeout
    });
    return window.WebWorkshop._test;
}

test('系统文件拖入网页工坊先验证全部层级、大小及同名冲突', () => {
    const { prepareExternalImport } = workshopTools();
    const root = 'a/'.repeat(18);
    const files = [
        { path:'资源/', directory:true },
        { path:'资源/封面.png', file:{ size:1024 } },
        { path:'资源/空目录/', directory:true }
    ];
    const prepared = prepareExternalImport(files, root, [{ path:root, type:'application/x-directory' }]);
    assert.equal(prepared[1].path, root+'资源/封面.png');
    assert.equal(prepared[2].path, root+'资源/空目录/');
    assert.throws(() => prepareExternalImport(files, root+'深一层/', []), /20 层/);
    assert.throws(() => prepareExternalImport([{path:'too-large.bin',file:{size:100*1024*1024+1}}], '', []), /100 MB/);
    assert.throws(() => prepareExternalImport([
        {path:'a.bin',file:{size:60*1024*1024}}, {path:'b.bin',file:{size:41*1024*1024}}
    ], '', []), /100 MB/);
    assert.equal(prepareExternalImport([{path:'exact.bin',file:{size:100*1024*1024}}], '', []).length, 1);
    assert.throws(() => prepareExternalImport(files, '', [{path:'资源/',type:'application/x-directory'}]), /同名项目/);
    assert.throws(() => prepareExternalImport([{path:'坏:名字.txt',file:{size:1}}], '', []), /名称不能包含/);
});

test('目录拖入完整读取多个 readEntries 批次和空目录', async () => {
    const { enumerateDroppedEntry } = workshopTools();
    const file = name => ({ name, isFile:true, file: callback => callback({ name, size:1 }) });
    const batches = [[file('1.png')],[file('2.png')],[]];
    const folder = { name:'图集', isDirectory:true, createReader:() => ({ readEntries:callback => callback(batches.shift()) }) };
    const found = [];
    await enumerateDroppedEntry(folder,'',found);
    assert.deepEqual(Array.from(found,item=>item.path), ['图集/','图集/1.png','图集/2.png']);
});

test('启动层只观察资源并在 shell ready 时清理所有观察器与临时任务', () => {
    const page = read('pages/index.html');
    const script = page.match(/<script>\s*(\(function startupLoadingObserver\(\)[\s\S]*?)<\/script>/)?.[1];
    assert.ok(script);
    const listeners = new Map(), intervals = new Set(), timers = new Set();
    let disconnected = false, removed = false, bodyVisible = false;
    const ui = new Map();
    for(const selector of ['progress','[data-startup-count]','[data-startup-current]','[data-startup-warning]','[data-startup-list]','.startup-actions'])ui.set(selector,{textContent:'',hidden:true,replaceChildren(...children){this.children=children;}});
    const layer = { querySelector:selector => ui.get(selector), remove(){removed=true;} };
    const document = {
        querySelectorAll:() => [{src:'https://example.test/app.js'},{src:'https://example.test/client/web-workshop.js'}],
        getElementById:() => bodyVisible?layer:null,
        createElement:() => ({textContent:''}),
        addEventListener(type,handler){ listeners.set(type,handler); },
        removeEventListener(type,handler){ if(listeners.get(type)===handler)listeners.delete(type); }
    };
    const window = { TunnelStartup:{currentStage:'indexeddb-open'} };
    vm.runInNewContext(script, {
        window, document, location:{href:'https://example.test/'}, URL, Map, Set, Array, String,
        performance:{getEntriesByType:() => []},
        PerformanceObserver:class{ observe(){} disconnect(){disconnected=true;} },
        setInterval:fn => {intervals.add(fn);return fn;}, clearInterval:fn => intervals.delete(fn),
        setTimeout:fn => {timers.add(fn);return fn;}, clearTimeout:fn => timers.delete(fn)
    });
    assert.equal(intervals.size, 1);
    assert.ok(listeners.has('tunnel-shell-ready'));
    bodyVisible=true;
    intervals.values().next().value();
    assert.equal(ui.get('[data-startup-count]').textContent, '资源已加载 0 / 2');
    assert.equal(ui.get('[data-startup-current]').textContent, '正在打开本地数据库…');
    listeners.get('load')({target:{tagName:'SCRIPT',src:'https://example.test/app.js'}});
    assert.equal(ui.get('[data-startup-count]').textContent, '资源已加载 1 / 2');
    assert.equal(ui.get('progress').value, 1);
    listeners.get('tunnel-shell-ready')();
    assert.equal(disconnected, true);
    assert.equal(removed, true);
    assert.equal(intervals.size, 0);
    assert.equal(timers.size, 0);
    assert.equal(listeners.has('error'), false);
    assert.equal(window.TunnelStartupLoading, undefined);
});
