'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm');
const turn = () => new Promise(setImmediate);
function fixture(confirmValue = true, request = async () => completed) {
    const requests = [], downloads = [], explanations = [], timers = [];
    class Node {
        constructor(tag) { this.tag = tag; this.children = []; this.attrs = {}; this.listeners = {}; this.classes = new Set(); this.classList = { toggle: (name,on) => on ? this.classes.add(name) : this.classes.delete(name) }; }
        append(...children) { this.children.push(...children); for (const child of children) child.parent = this; }
        setAttribute(name,value) { this.attrs[name] = value; } removeAttribute(name) { delete this.attrs[name]; if (name === 'src') this.src = ''; }
        addEventListener(name,fn) { this.listeners[name] = fn; }
        showModal() { this.open = true; } close() { this.open = false; this.listeners.close?.(); }
        remove() { if (this.parent) this.parent.children = this.parent.children.filter(n => n !== this); }
        focus() {} pause() { this.paused = true; } load() {} play() { this.paused = false; return Promise.resolve(); }
        click() { if (this.tag === 'a') downloads.push(this.href); }
    }
    const window = {}, body = new Node('body');
    vm.runInNewContext(fs.readFileSync('client/audio-track-repair.js','utf8'), {
        window, document: { createElement: tag => new Node(tag), body }, confirm: text => { explanations.push(text); return confirmValue; },
        setTimeout: callback => { timers.push(callback); return timers.length; }
    });
    const requester = async (...args) => { requests.push(args); if (args[0].endsWith('/audio-repair/status')) throw Error('暂无修正版'); return request(...args); };
    const panel = window.AudioTrackRepair.create({ id: 'task' }, '/api/sns-dl', requester);
    function open(entry = panel) { entry.children[0].onclick(); const modal = body.children.find(n => n.tag === 'dialog'), content = modal.children[1];
        return { modal, execute: content.children[1].children[0], preview: content.children[1].children[1], download: content.children[1].children[2], status: content.children[2], progress: content.children[3], video: content.children[4] }; }
    return { api:window.AudioTrackRepair, panel, open, requester, requests, downloads, explanations, timers, body };
}
const completed = { jobId:'done', status:'completed', statusUrl:'/status', downloadUrl:'/corrected', previewUrl:'/corrected?inline=1', name:'修正版.mp4' };
const posts = f => f.requests.filter(([,options]) => options?.method === 'POST');

test('打开修正音轨只显示小浮层，取消执行确认不提交也不下载', async () => {
    const f = fixture(false), view = f.open();
    assert.equal(f.panel.children[0].textContent, '修正音轨'); assert.equal(view.execute.textContent, '执行音轨修正'); assert.equal(view.preview.hidden, true);
    await view.execute.onclick(); assert.equal(posts(f).length,0); assert.equal(f.downloads.length,0); assert.match(f.explanations[0],/原文件保留/);
    assert.equal(f.api.busy(),true); view.modal.close(); assert.equal(f.api.busy(),false);
});
test('执行防重复、完成后分别预览及下载，重新执行才提交 force', async () => {
    let finish; const f = fixture(true, () => new Promise(resolve => { finish = resolve; })), view = f.open();
    const running = view.execute.onclick(); assert.equal(view.execute.disabled,true); await view.execute.onclick(); assert.equal(posts(f).length,1);
    assert.equal(JSON.parse(posts(f)[0][1].body).force,false);
    finish(completed); await running; assert.equal(view.execute.textContent,'重新修正音轨'); assert.equal(view.preview.hidden,false); assert.equal(view.download.hidden,false);
    assert.deepEqual(f.downloads,[]); view.preview.onclick(); assert.equal(view.video.src,completed.previewUrl); assert.equal(view.video.hidden,false);
    view.download.onclick(); assert.deepEqual(f.downloads,['/corrected']); assert.equal(posts(f).length,1);
    const repeat = view.execute.onclick(); assert.equal(JSON.parse(posts(f)[1][1].body).force,true); assert.equal(view.video.paused,true); assert.equal(view.video.src,'');
    finish(completed); await repeat; view.modal.close(); assert.equal(f.api.busy(),false);
});
test('收起浮层仍轮询队列，卡片重建后可恢复完成状态，不自动下载', async () => {
    const f = fixture(true, async url => url === '/status' ? completed : {...completed,status:'queued'}), view = f.open();
    await view.execute.onclick(); assert.equal(f.timers.length,1); view.modal.close(); assert.equal(f.api.busy(),false);
    f.timers.shift()(); await turn();
    const panel = f.api.create({id:'task'},'/api/sns-dl',f.requester), restored = f.open(panel);
    assert.equal(restored.execute.textContent,'重新修正音轨'); assert.equal(restored.preview.disabled,false); assert.deepEqual(f.downloads,[]);
    restored.modal.close();
});
test('提交失败恢复可重试状态，错误显示在浮层中', async () => {
    const f = fixture(true, async () => {throw Error('ffmpeg 失败');}), view = f.open(); await view.execute.onclick();
    assert.equal(view.execute.disabled,false); assert.match(view.status.textContent,/ffmpeg 失败/); assert.deepEqual(f.downloads,[]); view.modal.close();
});
test('迟到的初始化状态不会覆盖新提交的任务，两个来源的同 ID 互相隔离', async () => {
    const f = fixture(); let resolveInspection;
    const request = async (url,options) => { if (!options) return new Promise(resolve => {resolveInspection = resolve;}); return {...completed,status:'queued'}; };
    const entry = f.api.create({id:'other'},'/api/youtube-premium',request), view = f.open(entry);
    await view.execute.onclick(); resolveInspection(completed); await turn();
    assert.equal(view.execute.disabled,true); assert.match(view.status.textContent,/队列/); assert.equal(view.preview.hidden,true); view.modal.close();
    const sns = f.open(); assert.equal(sns.execute.textContent,'执行音轨修正'); assert.equal(sns.preview.hidden,true); sns.modal.close();
});
