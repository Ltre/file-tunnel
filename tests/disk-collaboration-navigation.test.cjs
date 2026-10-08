'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'client/disk-collaboration.js'), 'utf8');

function fixture({ search = '', role = 'viewer', kind = 'directory', missingPath = '' } = {}) {
    const elements = new Map(), calls = [], writes = [], pickerArgs = [], historyUrls = [];
    class Element {
        constructor(tag) {
            this.tagName = tag.toUpperCase(); this.children = []; this.dataset = {};
            const names = new Set();
            this.classList = { names, toggle() {}, add:name => names.add(name), remove:name => names.delete(name) };
        }
        append(...children) { this.children.push(...children); if (this.tagName === 'SELECT' && !this.value) this.value = children[0]?.value || ''; }
        replaceChildren(...children) { this.children = children; }
        addEventListener() {}
        setAttribute() {}
        querySelectorAll() { return []; }
        scrollIntoView() { this.scrolled = true; }
        showModal() { Promise.resolve().then(() => this.children.at(-1).children.at(-1).onclick()); }
        close() {}
        remove() {}
    }
    const get = id => { if (!elements.has(id)) elements.set(id, new Element('div')); return elements.get(id); };
    const grant = { id:'collab-1', kind, path:'共享', name:'项目', fileId:'file-1', role, owned:false };
    const client = {
        raw: async (url, options) => {
            calls.push(url);
            if (options?.method === 'POST') writes.push({ url, body:JSON.parse(options.body) });
            if (url === '/api/telegram/drive/collaborations/collab-1') return { collaboration:{ ...grant } };
            if (url === '/api/telegram/drive/collaborations') return { collaborations:[
                { id:'collab-1', name:'项目', kind:'directory', role, owned:false },
                { id:'target-1', name:'目标项目', kind:'directory', role:'editor', owned:false },
                { id:'viewer-1', name:'只读项目', kind:'directory', role:'viewer', owned:false }
            ] };
            if (url === '/api/telegram/drive/collaborations/target-1') return { collaboration:{ id:'target-1', name:'目标项目', kind:'directory', role:'editor', owned:false, path:'目标根' } };
            if (url === '/api/telegram/drive/collaboration-scope/target-1/directories' && options?.method === 'POST') return { operation_id:'target-mkdir-op' };
            if (url === '/api/telegram/drive/collaboration-scope/target-1/operations/target-mkdir-op') return { status:'completed', result:{ path:'目标根/新目录' } };
            if (url === '/api/telegram/drive/collaboration-scope/target-1/directories') return { directories:[{ path:'目标根' }, { path:'目标根/归档' }] };
            if (url === '/api/telegram/drive/cross-scope/copy') return { copied:[{ id:'copied-1' }], destination:'目标根/归档' };
            if (url.startsWith('/directories/properties?path=')) {
                if (decodeURIComponent(url.split('=')[1]) === missingPath) throw new Error('DIRECTORY_NOT_FOUND');
                return { path:decodeURIComponent(url.split('=')[1]) };
            }
            if (url.startsWith('/list?path=')) {
                if (decodeURIComponent(url.split('=')[1]) === missingPath) throw new Error('DIRECTORY_NOT_FOUND');
                return { folders:[], files:[{ id:'file-1', name:'报告.txt', type:'text/plain', folderPath:'共享/子目录' }] };
            }
            if (url === '/files/file-1') return { id:'file-1', name:'报告.txt', type:'text/plain', folderPath:'共享' };
            throw new Error('Unexpected request: ' + url);
        },
        json(method, body) { return { method, body:JSON.stringify(body) }; }, setCollaboration(id) { this.collaborationId = id; }, subscribe() {}, stop() {}
    };
    const window = { DiskClient:client, DiskDirectoryPicker:{ choose:async options => { pickerArgs.push(options); return '目标根/归档'; } }, addEventListener() {}, parent:null }; window.parent = window;
    const document = { getElementById:get, createElement:tag => new Element(tag), addEventListener() {}, querySelectorAll:() => [],
        body:{ classList:{ toggle() {} }, append() {} } };
    const location = { pathname:'/disk-collab/view/collab-1', search, origin:'https://example.test' };
    vm.runInNewContext(source, { window, document, location, URLSearchParams, URL, history:{ replaceState(_state, _title, url) { historyUrls.push(url); } },
        setTimeout, clearTimeout, Date, console });
    return { elements, calls, writes, pickerArgs, historyUrls, client, get };
}
const settle = () => new Promise(resolve => setImmediate(resolve));

test('挂载搜索路径仅在当前授权根内定位并高亮文件，viewer 只显示读取操作', async () => {
    const page = fixture({ search:'?embedded=1&mount_id=mount-1&path=%E5%85%B1%E4%BA%AB%2F%E5%AD%90%E7%9B%AE%E5%BD%95&file_id=file-1' });
    await settle();
    assert.ok(page.calls.includes('/list?path=%E5%85%B1%E4%BA%AB%2F%E5%AD%90%E7%9B%AE%E5%BD%95'));
    assert.equal(page.get('uploadBtn').hidden, true);
    assert.equal(page.get('mkdirBtn').hidden, true);
    assert.match(page.get('title').textContent, /协同查看（只读）/);
    assert.equal(page.get('list').children[0].scrolled, true);
    assert.equal(page.get('list').children[0].classList.names.has('collab-located'), true);
    const actions = page.get('list').children[0].children.at(-1).children.map(node => node.textContent);
    assert.deepEqual(actions, ['下载', '转存到我的网盘', '复制到另一个协同项目']);
    assert.match(page.historyUrls.at(-1), /mount_id=mount-1/);
});

test('viewer 可显式复制授权文件到另一 editor 协同项目，提交 copy 且保留源', async () => {
    const page = fixture();
    await settle();
    const actions = page.get('list').children[0].children.at(-1).children;
    await actions.find(action => action.textContent === '复制到另一个协同项目').onclick();
    assert.equal(page.pickerArgs[0].rootPath, '目标根');
    assert.deepEqual(JSON.parse(JSON.stringify(await page.pickerArgs[0].loadDirectories())), {
        directories:[{ path:'目标根' }, { path:'目标根/归档' }]
    });
    assert.deepEqual(JSON.parse(JSON.stringify(await page.pickerArgs[0].createDirectory('目标根/新目录'))), { path:'目标根/新目录' });
    assert.ok(page.calls.includes('/api/telegram/drive/collaboration-scope/target-1/operations/target-mkdir-op'));
    assert.deepEqual(JSON.parse(JSON.stringify(page.writes.filter(write => write.url === '/api/telegram/drive/cross-scope/copy'))), [{
        url:'/api/telegram/drive/cross-scope/copy',
        body:{ mode:'copy', source:{ kind:'collaboration', collaborationId:'collab-1', selection:{ kind:'file', id:'file-1' } },
            target:{ kind:'collaboration', collaborationId:'target-1', destinationPath:'目标根/归档' } }
    }]);
    assert.match(page.get('status').textContent, /来源项目仍保留/);
});

test('越界、遍历和不规范的协同路径在发起 list 请求前回退到授权根', async () => {
    for (const path of ['共享2/私有', '共享/../私有', '共享//子目录', '/共享/子目录', '共享\\私有']) {
        const page = fixture({ search:'?path=' + encodeURIComponent(path) });
        await settle();
        const lists = page.calls.filter(url => url.startsWith('/list?path='));
        assert.deepEqual(lists, ['/list?path=%E5%85%B1%E4%BA%AB'], path);
    }
});

test('搜索命中的目录已经消失时回到授权根，文件级协同忽略路径', async () => {
    const missing = fixture({ search:'?path=' + encodeURIComponent('共享/旧目录'), missingPath:'共享/旧目录' });
    await settle();
    assert.deepEqual(missing.calls.filter(url => url.startsWith('/list?path=')), [
        '/list?path=%E5%85%B1%E4%BA%AB'
    ]);
    assert.ok(missing.calls.includes('/directories/properties?path=%E5%85%B1%E4%BA%AB%2F%E6%97%A7%E7%9B%AE%E5%BD%95'));
    assert.match(missing.get('status').textContent, /已返回协同根目录/);
    const file = fixture({ search:'?path=' + encodeURIComponent('共享/私有'), kind:'file' });
    await settle();
    assert.equal(file.calls.some(url => url.startsWith('/list?path=')), false);
    assert.ok(file.calls.includes('/files/file-1'));
});
