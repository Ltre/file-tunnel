'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
function fixture(confirmValue = true, request = async () => ({ jobId:'done', status:'completed', statusUrl:'/status', downloadUrl: '/corrected', name: '修正版.mp4', reused: false })) {
    const requests = [], downloads = [], explanations = [];
    function element(tag) {
        const classes = new Set();
        return { tag, children: [], append(...children) { this.children.push(...children); }, setAttribute() {},
            classList: { toggle(name, enabled) { if (enabled) classes.add(name); else classes.delete(name); }, contains(name) { return classes.has(name); } },
            remove() {}, click() { if (tag === 'a') downloads.push(this.href); } };
    }
    const window = {};
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../client/audio-track-repair.js'), 'utf8'), {
        window, document: { createElement: element, body: element('body') },
        confirm: text => { explanations.push(text); return confirmValue; },
        setTimeout: callback => { Promise.resolve().then(callback); return 1; }
    });
    const panel = window.AudioTrackRepair.create({ id: 'task' }, '/api/sns-dl', async (...args) => {
        requests.push(args);
        if (args[0] === '/api/sns-dl/tasks/task/audio-repair/status') throw Error('暂无修正版');
        return request(...args);
    });
    return { api: window.AudioTrackRepair, panel, button: panel.children[0], checkbox: panel.children[1].children[0], status: panel.children[2], progress: panel.children[3], requests, downloads, explanations };
}
const postRequests = fixture => fixture.requests.filter(([, options]) => options?.method === 'POST');
test('独立修正版面板先说明并确认，取消时不调用服务端或下载', async () => {
    const f = fixture(false); await f.button.onclick();
    assert.equal(f.panel.className, 'audio-repair-panel'); assert.equal(f.button.textContent, '下载音轨修正版');
    assert.equal(f.panel.children[1].children[1], '重新修正音轨');
    assert.match(f.explanations[0], /ffmpeg.*原文件保留/); assert.equal(postRequests(f).length, 0); assert.equal(f.downloads.length, 0);
});
test('勾选重修随 POST 传递，提交期间防重复且完成后等待用户下载', async () => {
    let finish; const f = fixture(true, () => new Promise(resolve => { finish = resolve; }));
    f.checkbox.checked = true; f.checkbox.onchange();
    const running = f.button.onclick(); assert.equal(f.api.busy(), true); assert.equal(f.button.disabled, true);
    await f.button.onclick(); assert.equal(postRequests(f).length, 1); assert.deepEqual(JSON.parse(postRequests(f)[0][1].body), { force: true });
    finish({ jobId:'done', status:'completed', statusUrl:'/status', downloadUrl: '/corrected', name: '修正版.mp4', reused: false }); await running;
    assert.deepEqual(f.downloads, []); assert.equal(f.api.busy(), false); assert.equal(f.checkbox.checked, false);
    assert.equal(f.button.classList.contains('is-ready'), true);
    await f.button.onclick(); assert.deepEqual(f.downloads, ['/corrected']); assert.equal(postRequests(f).length, 1);
});
test('后端队列立即受理后轮询状态，不在转码期间阻塞任务列表刷新', async () => {
    let statusCalls = 0;
    const f = fixture(true, async url => {
        if (url === '/status') {
            statusCalls++;
            return statusCalls === 1
                ? { jobId:'queued', status:'processing', statusUrl:'/status', downloadUrl:'/corrected', name:'修正版.mp4' }
                : { jobId:'queued', status:'completed', statusUrl:'/status', downloadUrl:'/corrected', name:'修正版.mp4', reused:false };
        }
        return { jobId:'queued', status:'queued', statusUrl:'/status', downloadUrl:'/corrected', name:'' };
    });
    await f.button.onclick();
    assert.equal(f.api.busy(), false);
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(statusCalls, 2); assert.deepEqual(f.downloads, []);
    assert.match(f.status.textContent, /可直接下载/); assert.equal(f.button.classList.contains('is-ready'), true);
    await f.button.onclick(); assert.deepEqual(f.downloads, ['/corrected']);
});
test('服务端修正失败只显示错误，不下载，按钮恢复可用', async () => {
    const f = fixture(true, async () => { throw Error('ffmpeg 失败'); }); await f.button.onclick();
    assert.equal(f.downloads.length, 0); assert.match(f.status.textContent, /ffmpeg 失败/);
    assert.equal(f.api.busy(), false); assert.equal(f.button.disabled, false);
});
