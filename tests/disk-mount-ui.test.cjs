'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function fixture() {
    const requests = [], dialogs = [], listeners = new Map();
    const window = { addEventListener:type => listeners.set(type, true), removeEventListener:type => listeners.delete(type) };
    const fetch = async (url, options) => {
        requests.push({ url, method: options.method || 'GET', body: options.body && JSON.parse(options.body) });
        return { ok: true, json: async () => ({ mount:{ id:'mount-1', ...options.body && JSON.parse(options.body) } }) };
    };
    const document = { body:{ append:node => dialogs.push(node) }, createElement:tag => ({
        tagName:tag.toUpperCase(), children:[], contentWindow:{}, value:'', textContent:'',
        append(...children) { this.children.push(...children); }, setAttribute() {}, addEventListener() {},
        showModal() { this.open = true; }, close() { this.open = false; }, remove() { this.removed = true; }
    }) };
    const source = fs.readFileSync(path.join(__dirname, '..', 'client/disk-mount-ui.js'), 'utf8');
    vm.runInNewContext(source, { window, document, fetch, URL, location:{origin:'https://example.test'}, localStorage:{getItem:() => 'device-12345678'} });
    return { ui:window.DiskMountUI, requests, dialogs, listeners };
}

test('挂载目标使用目标分区 scope；跨分区移动使用源 scope 与稳定目标分区 ID', async () => {
    const { ui, requests } = fixture();
    const target = { parentPath:'资料/共享', targetSpace:'partition-2', targetDiskSpace:'媒体库', name:'项目入口' };
    const created = await ui.create({ collaboration:{ id:'collab-1', name:'项目', owned:false }, selectTarget:async () => target });
    assert.equal(created.id, 'mount-1');
    assert.match(requests[0].url, /^\/api\/telegram\/drive\/mounts\?disk_space=%E5%AA%92%E4%BD%93%E5%BA%93$/);
    assert.deepEqual(requests[0].body, { collaborationId:'collab-1', parentPath:'资料/共享', name:'项目入口' });
    const mount = { id:'mount-1', diskSpace:'旧分区', name:'项目入口', parentPath:'资料/共享', collaborationId:'collab-1', status:'active' };
    await ui.move(mount, { selectTarget:async () => ({ ...target, parentPath:'新目录' }) });
    assert.match(requests[1].url, /^\/api\/telegram\/drive\/mounts\/mount-1\?disk_space=%E6%97%A7%E5%88%86%E5%8C%BA$/);
    assert.deepEqual(requests[1].body, { parentPath:'新目录', targetSpace:'partition-2' });
    await ui.rename(mount, { selectName:async () => '新名称' });
    assert.deepEqual(requests[2].body, { name:'新名称' });
    await ui.remove(mount, { confirm:async () => true });
    assert.equal(requests[3].method, 'DELETE');
    assert.equal(requests.length, 4);
});

test('无授权、已失效挂载与非法名称均在 UI 层拒绝', async () => {
    const { ui, requests } = fixture();
    await assert.rejects(ui.create({collaboration:{id:'own',owned:true},selectTarget:async()=>({})}), /只能挂载/);
    await assert.rejects(ui.create({collaboration:{id:'c1'},selectTarget:async()=>({name:'坏/名称',parentPath:'',targetDiskSpace:''})}), /挂载名称/);
    assert.throws(() => ui.open({id:'m1',collaborationId:'c1',status:'inaccessible'}, {openFrame:()=>{}}), /授权已失效/);
    assert.equal(requests.length, 0);
});

test('打开搜索命中的挂载目录时传递目标路径', () => {
    const { ui } = fixture();
    const opened = ui.open({id:'m1',collaborationId:'c1',name:'共享资料',status:'active'}, {
        path:'共同目录/项目 A', openFrame:args => args
    });
    assert.deepEqual(JSON.parse(JSON.stringify(opened)), {id:'c1',name:'共享资料',mountId:'m1',path:'共同目录/项目 A'});
    assert.throws(() => ui.open({id:'m1',collaborationId:'c1',status:'active'}, {
        path:'共同目录/../私有', openFrame:() => assert.fail('非法路径不应打开 iframe')
    }), /协同定位路径不合法/);
    assert.throws(() => ui.open({id:'m1',collaborationId:'c1',status:'active'}, {
        path:'共同目录//项目', openFrame:() => assert.fail('非法路径不应打开 iframe')
    }), /协同定位路径不合法/);
});

test('挂载浮层保留本地入口、mountId 与远端定位路径，返回只关闭浮层', () => {
    const { ui, dialogs, listeners } = fixture();
    const opened = ui.open({ id:'m1', collaborationId:'c1', name:'项目入口', parentPath:'资料/共享', lastKnownTitle:'同事项目', status:'active' }, { path:'远端/子目录', fileId:'file-1' });
    const dialog = dialogs[0], [header, frame] = dialog.children;
    assert.equal(header.children[0].textContent, '我的网盘 / 资料/共享 / 项目入口');
    assert.equal(header.children[1].textContent, '来源：同事项目');
    assert.equal(frame.src, '/disk-collab/view/c1?embedded=1&mount_id=m1&path=%E8%BF%9C%E7%AB%AF%2F%E5%AD%90%E7%9B%AE%E5%BD%95&file_id=file-1');
    assert.equal(dialog.open, true);
    opened.close();
    assert.equal(dialog.open, false);
    assert.equal(dialog.removed, true);
    assert.equal(frame.src, 'about:blank');
    assert.equal(listeners.size, 0);
});
