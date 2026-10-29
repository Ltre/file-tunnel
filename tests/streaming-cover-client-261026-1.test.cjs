'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm');
const code = fs.readFileSync('client/streaming-console.js', 'utf8');
async function choose({ decodeFails = false, loadFails = false, blobFails = false, readFails = false } = {}) {
    class Node {
        constructor(tag) { this.tag = tag; this.children = []; this.classList = { add() {}, remove() {} }; this.isConnected = true; }
        append(...nodes) { this.children.push(...nodes); }
        prepend(node) { this.children.unshift(node); }
        after(node) { this.inserted = node; }
        setAttribute() {}
        getContext() { return { drawImage() {} }; }
        toBlob(run) { run(new Blob(['cropped'], { type: 'image/png' })); }
    }
    const form = new Node('section'); form.children.push(new Node('label'));
    const d = { coverId: '' }, covers = new Map(), revoked = [], sources = [];
    class Image {
        constructor() { this.naturalWidth = this.naturalHeight = 0; }
        set src(value) { sources.push(value); this.url = value; setImmediate(() => { if (loadFails || blobFails && value.startsWith('blob:')) this.onerror?.(); else { this.naturalWidth = 300; this.naturalHeight = 200; this.onload?.(); } }); }
        decode() { return decodeFails ? Promise.reject(Error('The source image cannot be decoded.')) : new Promise(resolve => setImmediate(() => { this.naturalWidth = 300; this.naturalHeight = 200; resolve(); })); }
    }
    class FileReader {
        readAsDataURL() { setImmediate(() => { if (readFails) this.onerror?.(); else { this.result = 'data:image/png;base64,fixture'; this.onload?.(); } }); }
    }
    const context = { document: { createElement: tag => new Node(tag) }, Image, FileReader, Blob, setTimeout, clearTimeout,
        URL: { createObjectURL: () => 'blob:test', revokeObjectURL: value => revoked.push(value) },
        pendingCovers: covers, t: value => value, ui: { stationId: 'station' }, uid: () => 'cover-token', saveUi() {},
        main: new Node('main'), coverImage: () => new Node('img'), button: (title, run) => ({ title, run }) };
    vm.runInNewContext(code.slice(code.indexOf('    function coverEditor('), code.indexOf('    function title(')), context);
    context.coverEditor(form, d, 'station');
    const field = form.children.find(node => node.tag === 'label').inserted;
    const input = field.children[0].children[0]; input.files = [{ type: 'image/png', size: 300000 }];
    await input.onchange();
    return { d, covers, status: field.children[2].textContent, revoked, sources };
}
test('a valid loaded cover still crops when a browser rejects Image.decode()', async () => {
    const f = await choose({ decodeFails: true });
    assert.equal(f.d.coverPending, 'cover-token', f.status); assert.equal(f.covers.get('station').blob.type, 'image/png');
});
test('a selected image can recover when only its browser blob URL fails to load', async () => {
    const f = await choose({ blobFails: true });
    assert.equal(f.d.coverPending, 'cover-token', f.status);
    assert.deepEqual(f.sources, ['blob:test', 'data:image/png;base64,fixture']);
    assert.equal(f.revoked.length, 1);
});
test('a failed fallback read cannot save an empty or unverified cover', async () => {
    const f = await choose({ blobFails: true, readFails: true });
    assert.equal(f.covers.size, 0); assert.match(f.status, /封面处理失败/);
});
test('an image that cannot load or decode remains rejected and creates no pending cover', async () => {
    const f = await choose({ decodeFails: true, loadFails: true });
    assert.equal(f.covers.size, 0); assert.match(f.status, /封面处理失败/); assert.equal(f.revoked.length, 1);
});
