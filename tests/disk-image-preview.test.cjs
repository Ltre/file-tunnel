'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../client/disk-ui.js'), 'utf8');
const fit = vm.runInNewContext(source.slice(source.indexOf('function fitDiskPreviewImage('), source.indexOf('function wrapDiskPreviewImage(')) + ';fitDiskPreviewImage');

test('长图、超宽图与横竖屏窗口均完整适配且保持图片原始比例', () => {
    for (const [imageWidth, imageHeight, width, height] of [[800, 6000, 900, 400], [6000, 800, 900, 400], [800, 6000, 360, 700], [6000, 800, 360, 700], [20, 20, 900, 400]]) {
        const result = fit(imageWidth, imageHeight, width, height);
        assert.ok(result.width <= width + 1e-6 && result.height <= height + 1e-6);
        assert.ok(Math.abs(result.width / result.height - imageWidth / imageHeight) < 1e-6);
        assert.ok(Math.abs(result.width - width) < 1e-6 || Math.abs(result.height - height) < 1e-6);
        assert.equal(result.scale, 1); assert.equal(result.x, 0); assert.equal(result.y, 0);
    }
});
test('图片平移只在放大后溢出的轴上生效，恢复原比例后自动回到中心', () => {
    const tall = fit(800, 6000, 900, 400, 2, 10000, -10000);
    assert.equal(tall.x, 0); assert.equal(tall.y, -200);
    const wide = fit(6000, 800, 900, 400, 2, 10000, -10000);
    assert.equal(wide.x, 450); assert.equal(wide.y, 0);
    const reset = fit(6000, 800, 900, 400, 1, wide.x, wide.y);
    assert.equal(reset.x, 0); assert.equal(reset.y, 0);
    assert.equal(fit(6000, 800, 900, 400, 100).scale, 6);
});
test('窗口方向变化后重新适配并约束平移，尚未加载的图片不参与尺寸计算', () => {
    const rotated = fit(800, 6000, 400, 900, 2, 450, 10000);
    assert.equal(rotated.width, 120); assert.equal(rotated.height, 900);
    assert.equal(rotated.x, 0); assert.equal(rotated.y, 450);
    assert.equal(fit(0, 0, 400, 900), null); assert.equal(fit(800, 6000, 0, 0), null);
});

function picker() {
    class Element {
        constructor(tag) { this.tagName = tag; this.children = []; this.dataset = {}; this.classList = { toggle() {} }; }
        setAttribute() {} addEventListener() {}
        append(...children) { this.children.push(...children); } replaceChildren(...children) { this.children = children; }
        querySelectorAll() { return this.children.flatMap(child => typeof child === 'object' ? [...(child.dataset.folderPath !== undefined ? [child] : []), ...child.querySelectorAll()] : []); }
    }
    let dialog, release, fail, waited = [], directories = [];
    const alerts = [], writes = [];
    const context = vm.createContext({ document: { createElement: tag => new Element(tag) }, telegramDrivePath: '',
        telegramDriveDisplayPath: path => path ? '/' + path : '/', installContextGesture() {},
        telegramDriveErrorText: error => error.message, alert: message => alerts.push(message),
        openTelegramDriveDialog: options => { dialog = options; },
        window: { DiskClient: { json: (method, body) => ({ method, body }),
            raw: async (url, options) => options?.method === 'POST' ? (writes.push(options.body.path), { operation_id: 'mkdir-operation' }) : { directories },
            wait: id => { waited.push(id); return new Promise((resolve, reject) => { release = value => { directories = [{ path: '新目录', name: '新目录' }, { path: value.path, name: '子目录' }]; resolve(value); }; fail = reject; }); }
        } }
    });
    const choose = vm.runInContext(source.slice(source.indexOf('async function chooseTelegramDriveDestination('), source.indexOf('async function moveTelegramDriveItems(')) + ';chooseTelegramDriveDestination', context);
    return { choose, alerts, writes, waited, dialog: () => dialog, release: value => release(value), fail: error => fail(error) };
}
test('目录选择器等待创建任务完成后展开并选中，不把 operation_id 响应当作目录', async () => {
    const f = picker(); await f.choose();
    const input = f.dialog().body[2], button = f.dialog().body[3]; input.value = '/新目录/子目录';
    const pending = button.onclick(); await new Promise(resolve => setImmediate(resolve));
    assert.equal(button.disabled, true); assert.deepEqual(f.waited, ['mkdir-operation']); assert.equal(f.alerts.length, 0);
    f.release({ path: '新目录/子目录' }); await pending;
    assert.equal(button.disabled, false); assert.equal(input.value, '/新目录/子目录'); assert.equal(f.alerts.length, 0);
    assert.equal(await f.dialog().validate(), '新目录/子目录'); assert.deepEqual(f.writes, ['/新目录/子目录']);
});
test('创建目录真实失败时只显示任务错误，并恢复创建按钮', async () => {
    const f = picker(); await f.choose();
    const button = f.dialog().body[3], pending = button.onclick(); await new Promise(resolve => setImmediate(resolve));
    f.fail(new Error('MKDIR_FAILED')); await pending;
    assert.deepEqual(f.alerts, ['MKDIR_FAILED']); assert.equal(button.disabled, false);
});
