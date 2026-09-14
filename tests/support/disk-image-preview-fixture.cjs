'use strict';
// Real browser/UI regression, using synthetic local images and directory jobs.
// Run: node tests/support/disk-image-preview-fixture.cjs
const express = require('express'), fs = require('node:fs'), path = require('node:path');
const root = path.join(__dirname, '../..'), app = express(); app.use(express.json());
const images = {
    tall: '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="3200"><rect width="200" height="3200" fill="#4498b6"/><rect width="200" height="200" fill="#e06060"/><rect y="3000" width="200" height="200" fill="#73cd89"/></svg>',
    wide: '<svg xmlns="http://www.w3.org/2000/svg" width="3200" height="200"><rect width="3200" height="200" fill="#4498b6"/><rect width="200" height="200" fill="#e06060"/><rect x="3000" width="200" height="200" fill="#73cd89"/></svg>'
};
let directories = [], jobs = [], report = { status: 'pending' };
app.get('/', (req, res) => {
    let html = fs.readFileSync(path.join(root, 'pages/index.html'), 'utf8').replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '');
    html = html.replace('</body>', '<script src="/client/disk-client.js"></script><script src="/client/disk-ui.js"></script><script src="/fixture.js"></script></body>');
    res.type('html').send(html);
});
app.get('/api/telegram/drive/me', (req, res) => res.json({ identity: { id: 'image-fixture', name: '图片本地回归' }, enabled: true, configured: true }));
app.get('/api/telegram/drive/list', (req, res) => res.json({ path: '', breadcrumbs: [], folders: [], summary: { folderCount: 0, fileCount: 2 },
    files: Object.keys(images).map(id => ({ id, kind: 'file', name: id === 'tall' ? '1-长图.svg' : '2-超宽图.svg', type: 'image/svg+xml', size: Buffer.byteLength(images[id]) })) }));
for (const suffix of ['stream', 'download']) app.get('/api/telegram/drive/files/:id/' + suffix, (req, res) => res.type('svg').send(images[req.params.id]));
app.get('/api/telegram/drive/directories', (req, res) => res.json({ directories }));
app.post('/api/telegram/drive/directories', (req, res) => {
    const parts = String(req.body.path).split('/').filter(Boolean), folderPath = parts.join('/');
    directories = parts.map((name, index) => ({ name, path: parts.slice(0, index + 1).join('/') }));
    const job = { operation_id: 'mkdir-' + jobs.length, status: 'running', type: 'mkdir', phase: 'index-write', result: { path: folderPath } }; jobs.push(job);
    setTimeout(() => { job.status = 'completed'; }, 35);
    res.status(202).json({ operation_id: job.operation_id });
});
app.get('/api/telegram/drive/operations', (req, res) => res.json({ operations: jobs }));
app.get('/report', (req, res) => res.json(report));
app.post('/report', (req, res) => { report = req.body; console.log(JSON.stringify(report)); res.json({ ok: true }); });
async function runFixture() {
    const results = [], alerts = [], sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
    const until = async check => { for (let n = 0; n < 200; n++) { if (check()) return; await sleep(25); } throw Error('等待 UI 超时'); };
    const assert = (ok, message) => { if (!ok) throw Error(message); };
    window.alert = message => alerts.push(message);
    const row = name => [...document.querySelectorAll('#telegramDriveList .telegram-drive-item')].find(el => el.querySelector('.telegram-drive-item-name').textContent === name);
    const openImage = async name => {
        row(name).dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        await until(() => document.querySelector('#diskPreviewBody .disk-preview-image')?.naturalWidth > 0);
        await sleep(50);
        return document.querySelector('#diskPreviewBody .disk-preview-image-frame');
    };
    const contained = frame => {
        const a = frame.getBoundingClientRect(), b = frame.querySelector('.disk-preview-image').getBoundingClientRect();
        assert(b.left >= a.left - .1 && b.top >= a.top - .1 && b.right <= a.right + .1 && b.bottom <= a.bottom + .1, '图片超出可视区域');
        const image = frame.querySelector('.disk-preview-image');
        assert(Math.abs(b.width / b.height - image.naturalWidth / image.naturalHeight) < .001, '图片比例失真');
    };
    const touch = (frame, name, points, changed = points) => {
        const event = new Event(name, { bubbles: true }); Object.defineProperties(event, { touches: { value: points }, changedTouches: { value: changed } }); frame.dispatchEvent(event);
    };
    const pointer = (frame, name, id, x, y, type = 'touch') => frame.dispatchEvent(new PointerEvent(name, { bubbles: true, cancelable: true, pointerId: id, pointerType: type, button: 0, clientX: x, clientY: y }));
    try {
        window.DiskUI.init(); await window.DiskUI.open();
        const choose = window.DiskUI.chooseDirectory({ title: '选择保存到网盘的目录', confirmText: '保存到这里' });
        await until(() => !document.getElementById('telegramDriveDialog').hidden);
        const pathInput = document.querySelector('#telegramDriveDialogBody input'), create = [...document.querySelectorAll('#telegramDriveDialogBody button')].find(el => el.textContent === '创建多级目录并选中');
        pathInput.value = '/测试目录/子目录'; create.click();
        await until(() => !create.disabled && [...document.querySelectorAll('.disk-folder-target.selected')].some(el => el.dataset.folderPath === '测试目录/子目录'));
        assert(alerts.length === 0, '创建成功仍然 alert：' + alerts.join(','));
        [...document.querySelectorAll('#telegramDriveDialogActions button')].find(el => el.textContent === '保存到这里').click();
        assert(await choose === '测试目录/子目录', '目录没有正确选中'); results.push('异步创建多级目录后选中且无 alert：通过');
        for (const name of ['1-长图.svg', '2-超宽图.svg']) {
            const frame = await openImage(name);
            contained(frame);
            for (const [width, height] of [[320, 180], [180, 320]]) {
                frame.style.width = width + 'px'; frame.style.height = height + 'px'; await sleep(50); contained(frame);
                results.push(name + ' 在 ' + width + '×' + height + ' 可视区域完整显示：通过');
            }
            document.getElementById('diskPreviewClose').click(); await until(() => !history.state?.telegramDrivePreview);
            assert(!document.getElementById('telegramDriveOverlay').hidden, '预览关闭误关网盘');
        }
        const frame = await openImage('1-长图.svg'), image = frame.querySelector('.disk-preview-image');
        frame.querySelector('[aria-label="放大图片"]').click();
        const capture = frame.setPointerCapture, hasCapture = frame.hasPointerCapture;
        // Synthetic pointer IDs do not have browser capture; real mouse drag is
        // additionally checked through CUA after this automatic regression.
        frame.setPointerCapture = () => {}; frame.hasPointerCapture = () => false;
        const r = frame.getBoundingClientRect(), x = r.left + r.width / 2, y = r.top + r.height / 2;
        const before = image.style.transform;
        pointer(frame, 'pointerdown', 1, x, y, 'mouse'); pointer(frame, 'pointermove', 1, x, y + 40, 'mouse'); pointer(frame, 'pointerup', 1, x, y + 40, 'mouse');
        assert(image.style.transform !== before && !document.getElementById('diskPreview').hidden, '鼠标拖动未平移或误退出'); results.push('放大后鼠标平移：通过');
        pointer(frame, 'pointerdown', 2, x - 30, y); touch(frame, 'touchstart', [{ clientX: x - 30, clientY: y }]);
        pointer(frame, 'pointerdown', 3, x + 30, y); touch(frame, 'touchstart', [{ clientX: x - 30, clientY: y }, { clientX: x + 30, clientY: y }]);
        pointer(frame, 'pointermove', 2, x - 60, y); pointer(frame, 'pointermove', 3, x + 60, y + 30);
        touch(frame, 'touchmove', [{ clientX: x - 60, clientY: y }, { clientX: x + 60, clientY: y + 30 }]);
        const pinched = image.style.transform;
        pointer(frame, 'pointerup', 3, x + 60, y + 30); touch(frame, 'touchend', [{ clientX: x - 60, clientY: y }]);
        pointer(frame, 'pointermove', 2, x - 60, y + 90); touch(frame, 'touchmove', [{ clientX: x - 60, clientY: y + 90 }]);
        pointer(frame, 'pointerup', 2, x - 60, y + 90); touch(frame, 'touchend', [], [{ clientX: x - 60, clientY: y + 90 }]);
        assert(image.style.transform !== pinched && document.getElementById('diskPreviewName').textContent === '1-长图.svg', '单/双指平移未生效或误切文件'); results.push('双指捏合、双指/单指平移且不误切文件：通过');
        for (let n = 0; n < 12; n++) frame.querySelector('[aria-label="缩小图片"]').click(); contained(frame);
        const reset = image.style.transform;
        pointer(frame, 'pointerdown', 4, x, y, 'mouse'); pointer(frame, 'pointermove', 4, x + 70, y + 70, 'mouse'); pointer(frame, 'pointerup', 4, x + 70, y + 70, 'mouse');
        assert(image.style.transform === reset && !frame.classList.contains('is-zoomed'), '原比例仍可平移'); results.push('缩小复原后停止平移：通过');
        pointer(frame, 'pointerdown', 5, x, y); touch(frame, 'touchstart', [{ clientX: x, clientY: y }]);
        pointer(frame, 'pointerup', 5, x - 100, y); touch(frame, 'touchend', [], [{ clientX: x - 100, clientY: y }]);
        await until(() => document.getElementById('diskPreviewName').textContent === '2-超宽图.svg'); results.push('原比例单指横划仍切换图片：通过');
        frame.setPointerCapture = capture; frame.hasPointerCapture = hasCapture;
        document.getElementById('diskPreviewPrev').click(); await sleep(100);
        document.querySelector('.disk-preview-image-controls [aria-label="放大图片"]').click();
        document.querySelector('.disk-preview-image-controls [aria-label="放大图片"]').click();
        const output = document.createElement('pre'); output.id = 'fixtureResults'; output.textContent = 'PASS\n' + results.join('\n'); output.style.cssText = 'position:fixed;top:80px;left:10px;max-width:36vw;white-space:pre-wrap;color:white;background:#18232fcc;font:12px/1.5 system-ui;padding:10px;z-index:2147483190;pointer-events:none'; document.body.append(output);
        await fetch('/report', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'passed', results }) });
    } catch (error) { await fetch('/report', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'failed', error: error.message, results, alerts }) }); document.body.textContent = 'FAIL: ' + error.message; }
}
app.get('/fixture.js', (req, res) => res.type('js').send('(' + runFixture.toString() + ')();'));
app.use('/client', express.static(path.join(root, 'client')));
app.use('/prompts/resources', express.static(path.join(root, 'prompts/resources')));
app.listen(3189, '127.0.0.1', () => console.log('Image regression fixture: http://127.0.0.1:3189/'));
