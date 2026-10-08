'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'client/disk-ui.js'), 'utf8');
const section = (start, end) => source.slice(source.indexOf(start), source.indexOf(end));
const code = [
    section('async function openTelegramDriveMountedSearchResult(', 'async function copyTelegramDriveItemToCollaboration('),
    section('async function copyTelegramDriveItemToCollaboration(', 'const telegramDriveSpaceKey ='),
    section('function installDiskMountCopyDrop(', 'function isLocalDiskFileDrag(')
].join('\n');

function fixture() {
    const reads = [], writes = [], opened = [], pickerOptions = [], errors = [];
    const target = { id:'collab-target', kind:'directory', role:'editor', owned:false, path:'授权根', name:'目标协同' };
    const window = {
        DiskClient: {
            getSpace:() => 'scope-a',
            raw:async (route, options) => {
                reads.push(route);
                if (options?.method === 'POST') writes.push({ route, body:JSON.parse(options.body) });
                if (route === '/collaborations') return { collaborations:[target] };
                if (route === '/collaborations/collab-target') return { collaboration:target };
                if (route === '/mounts/mount-a/resolve') return { mount:{ id:'mount-a', collaborationId:'collab-target', status:'active' } };
                if (route === '/cross-scope/copy') return { copied:[{ id:'copy-1' }] };
                if (route === '/collaboration-scope/collab-target/directories' && options?.method === 'POST') return { operation_id:'mkdir-op' };
                if (route === '/collaboration-scope/collab-target/operations/mkdir-op') return { status:'completed', result:{ path:'授权根/新目录' } };
                if (route === '/collaboration-scope/collab-target/directories') return { directories:[{ path:'授权根' }, { path:'授权根/子目录' }] };
                throw new Error('Unexpected request ' + route);
            },
            json:(method, body) => ({ method, body:JSON.stringify(body) })
        },
        DiskDirectoryPicker:{ choose:async options => { pickerOptions.push(options); return '授权根/子目录'; } },
        DiskMountUI:{ open:(mount, options) => { opened.push({ mount, options }); } }
    };
    const context = vm.createContext({ window, document:{ createElement:() => ({ append() {}, setAttribute() {} }), createTextNode:value => value },
        telegramDriveSpaces:[{ id:'partition-a', scopeKey:'scope-a' }],
        openTelegramDriveDialog:async () => 'collab-target', confirmTelegramDriveAction:async () => true,
        openDiskCollaborationFrame:() => {},
        showAppToast:() => {}, telegramDriveErrorText:error => error.message, alert:message => errors.push(message),
        setTimeout, encodeURIComponent });
    vm.runInContext('let diskDragItems = []; const telegramDriveSpaceKey = space => String(space?.scopeKey ?? space?.diskSpace ?? space?.id ?? "");\n' + code, context);
    const invoke = (expression, bindings = {}) => {
        Object.assign(context, bindings);
        return vm.runInContext(expression, context);
    };
    return { invoke, reads, writes, opened, pickerOptions, errors };
}

test('mounted search result re-resolves grant and opens exact directory/file focus', async () => {
    const page = fixture();
    await page.invoke('openTelegramDriveMountedSearchResult({origin:"collaboration", mountId:"mount-a", collaborationId:"collab-target", kind:"mounted_file", id:"file-9", folderPath:"授权根/子目录"})');
    assert.deepEqual(page.reads, ['/mounts/mount-a/resolve']);
    assert.deepEqual(JSON.parse(JSON.stringify(page.opened[0].options)), { path:'授权根/子目录', fileId:'file-9' });
    assert.equal(typeof page.opened[0].options.openFrame, 'function');
    await assert.rejects(page.invoke('openTelegramDriveMountedSearchResult({origin:"collaboration", mountId:"mount-a", collaborationId:"stale", kind:"mounted_directory", path:"授权根"})'), /已过期/);
    assert.equal(page.opened.length, 1);
});

test('Native copy opens only the authorized Foreign directory tree and sends an explicit copy envelope', async () => {
    const page = fixture();
    await page.invoke('copyTelegramDriveItemToCollaboration({kind:"directory", name:"源目录", path:"源目录"})');
    assert.equal(page.pickerOptions[0].rootPath, '授权根');
    assert.equal(page.pickerOptions[0].initialPath, '授权根');
    assert.deepEqual(JSON.parse(JSON.stringify(await page.pickerOptions[0].loadDirectories())), {
        directories:[{ path:'授权根' }, { path:'授权根/子目录' }]
    });
    assert.deepEqual(JSON.parse(JSON.stringify(await page.pickerOptions[0].createDirectory('授权根/新目录'))), { path:'授权根/新目录' });
    assert.ok(page.reads.includes('/collaboration-scope/collab-target/operations/mkdir-op'));
    assert.deepEqual(page.writes.filter(write => write.route === '/cross-scope/copy'), [{ route:'/cross-scope/copy', body:{
        mode:'copy', source:{ kind:'native', partitionId:'partition-a', selection:{ kind:'directory', path:'源目录' } },
        target:{ kind:'collaboration', collaborationId:'collab-target', destinationPath:'授权根/子目录' }
    } }]);
});

test('dropping one Native item on a mount requests copy to grant root and stops list drop bubbling', async () => {
    const page = fixture();
    const listeners = new Map(), classes = new Set();
    const row = { addEventListener:(name, handler) => listeners.set(name, handler), classList:{ add:name => classes.add(name), remove:name => classes.delete(name) } };
    page.invoke('installDiskMountCopyDrop(row, mount)', { row, mount:{ id:'mount-a', collaborationId:'collab-target' } });
    page.invoke('diskDragItems = [{kind:"file", id:"file-1", name:"报告"}]');
    const drag = { dataTransfer:{ dropEffect:'' }, preventDefault() { this.prevented = true; } };
    listeners.get('dragover')(drag);
    assert.equal(drag.dataTransfer.dropEffect, 'copy');
    assert.equal(drag.prevented, true);
    const drop = { preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; } };
    listeners.get('drop')(drop);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(drop.stopped, true);
    assert.equal(drop.prevented, true);
    assert.equal(page.pickerOptions.length, 0);
    assert.equal(page.errors.length, 0);
    assert.equal(page.writes[0].body.target.destinationPath, '授权根');
    assert.equal(page.writes[0].body.source.selection.id, 'file-1');
});
