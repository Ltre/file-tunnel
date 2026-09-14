'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
function fixture(confirmValue = true, request = async () => ({ downloadUrl: '/corrected', name: '修正版.mp4', reused: false })) {
    const requests = [], downloads = [], explanations = [];
    function element(tag) {
        return { tag, children: [], append(...children) { this.children.push(...children); }, setAttribute() {},
            remove() {}, click() { if (tag === 'a') downloads.push(this.href); } };
    }
    const window = {};
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../client/audio-track-repair.js'), 'utf8'), {
        window, document: { createElement: element, body: element('body') },
        confirm: text => { explanations.push(text); return confirmValue; }
    });
    const panel = window.AudioTrackRepair.create({ id: 'task' }, '/api/sns-dl', async (...args) => { requests.push(args); return request(...args); });
    return { api: window.AudioTrackRepair, panel, button: panel.children[0], checkbox: panel.children[1].children[0], status: panel.children[2], requests, downloads, explanations };
}
test('独立修正版面板先说明并确认，取消时不调用服务端或下载', async () => {
    const f = fixture(false); await f.button.onclick();
    assert.equal(f.panel.className, 'audio-repair-panel'); assert.equal(f.button.textContent, '下载音轨修正版');
    assert.equal(f.panel.children[1].children[1], '重新修正音轨');
    assert.match(f.explanations[0], /ffmpeg.*原文件保留/); assert.equal(f.requests.length, 0); assert.equal(f.downloads.length, 0);
});
test('勾选重修随 POST 传递，处理期间禁止重复执行且暂停任务列表刷新', async () => {
    let finish; const f = fixture(true, () => new Promise(resolve => { finish = resolve; }));
    f.checkbox.checked = true; f.checkbox.onchange();
    const running = f.button.onclick(); assert.equal(f.api.busy(), true); assert.equal(f.button.disabled, true);
    await f.button.onclick(); assert.equal(f.requests.length, 1); assert.deepEqual(JSON.parse(f.requests[0][1].body), { force: true });
    finish({ downloadUrl: '/corrected', name: '修正版.mp4', reused: false }); await running;
    assert.deepEqual(f.downloads, ['/corrected']); assert.equal(f.api.busy(), false); assert.equal(f.checkbox.checked, false);
});
test('服务端修正失败只显示错误，不下载，按钮恢复可用', async () => {
    const f = fixture(true, async () => { throw Error('ffmpeg 失败'); }); await f.button.onclick();
    assert.equal(f.downloads.length, 0); assert.match(f.status.textContent, /ffmpeg 失败/);
    assert.equal(f.api.busy(), false); assert.equal(f.button.disabled, false);
});
