'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const turn = () => new Promise(setImmediate);

function fixture({ playError, mediaType = 'video/x-matroska' } = {}) {
    const nodes = [], warnings = [];
    class Element {
        constructor(tag) {
            this.tagName = tag.toUpperCase(); this.children = []; this.events = new Map(); this.classes = new Set();
            this.classList = {
                add: (...names) => names.forEach(name => this.classes.add(name)),
                remove: (...names) => names.forEach(name => this.classes.delete(name)),
                contains: name => this.classes.has(name),
                toggle: (name, value) => value ? this.classes.add(name) : this.classes.delete(name)
            };
            this.style = { setProperty() {} }; this.paused = true; this.duration = 100; this.currentTime = 0;
            this.readyState = 2; this.networkState = 2; this.buffered = { length: 1, start: () => 0, end: () => 99 };
        }
        append(...children) { this.children.push(...children); }
        setAttribute(name, value) { this[name] = value; }
        removeAttribute(name) { delete this[name]; }
        addEventListener(name, callback) { if (!this.events.has(name)) this.events.set(name, []); this.events.get(name).push(callback); }
        emit(name) { for (const callback of this.events.get(name) || []) callback({ type: name }); }
        play() {
            if (this.nextPlayError) { const error = this.nextPlayError; this.nextPlayError = null; return Promise.reject(error); }
            this.paused = false; this.emit('play'); return Promise.resolve();
        }
        pause() { this.paused = true; this.emit('pause'); }
        load() {}
    }
    const source = fs.readFileSync(path.join(__dirname, '../client/disk-ui.js'), 'utf8');
    const context = vm.createContext({ document: { createElement: tag => { const node = new Element(tag); if (tag === 'video' || tag === 'audio') node.nextPlayError = playError; nodes.push(node); return node; } },
        window: { TelegramDriveCache: { getThumbnail: async () => null } }, console: { warn: (...args) => warnings.push(args) },
        setTimeout: () => 1, clearTimeout() {}, URL, Date,
        diskMediaProgress: {}, saveDiskMediaProgress() {}, loadAudioCover: null, generateTelegramDriveThumbnail: async () => null, fixtureMediaType: mediaType });
    vm.runInContext(source.slice(source.indexOf('function formatDiskMediaTime('), source.indexOf('function createDiskPreviewImageLoading(')), context);
    const wrapper = vm.runInContext('createDiskMediaPlayer({id:"test",name:"video.mkv",partCount:1}, "https://localhost/stream?token=secret-value", fixtureMediaType)', context);
    return { wrapper, warnings, media: nodes.find(node => node.tagName === 'VIDEO' || node.tagName === 'AUDIO'),
        status: nodes.find(node => node.className === 'disk-media-buffer-status'),
        play: nodes.filter(node => node.className === 'disk-media-icon-button')[1],
        seek: nodes.find(node => node.className === 'disk-media-seek') };
}

test('原生解码/格式/网络/中止错误终止加载；后续进度和seek不会将错误覆盖为99%', async () => {
    for (const [code, expected] of [[1, /已中止/], [2, /读取失败/], [3, /无法解码/], [4, /不支持/]]) {
        const f = fixture(); await turn(); f.media.emit('waiting');
        assert.equal(f.wrapper.classList.contains('is-buffering'), true); assert.match(f.status.textContent, /99%/);
        f.media.error = { code, message: 'PIPELINE_ERROR' }; f.media.emit('error');
        assert.equal(f.wrapper.classList.contains('is-buffering'), false); assert.equal(f.status.hidden, false); assert.match(f.status.textContent, expected);
        f.media.emit('progress'); f.media.emit('stalled'); f.seek.value = '500'; f.seek.oninput();
        assert.match(f.status.textContent, expected); assert.doesNotMatch(f.status.textContent, /当前分片|99%/);
        assert.equal(f.warnings.length, 1); assert.equal(f.warnings[0][1].code, code);
    }
});

test('play拒绝区分自动播放限制、暂停竞态和真正错误，不将前两者误判为解码异常', async () => {
    for (const name of ['AbortError', 'NotAllowedError']) {
        const f = fixture({ playError: Object.assign(new Error('request rejected'), { name }) }); await turn();
        assert.equal(f.warnings.length, 0); assert.equal(f.wrapper.classList.contains('is-media-error'), false);
        assert.equal(f.wrapper.classList.contains('is-buffering'), false);
        if (name === 'NotAllowedError') assert.match(f.status.textContent, /点击播放/);
        f.play.onclick(); await turn(); f.media.emit('playing');
        assert.equal(f.media.paused, false); assert.equal(f.status.hidden, true);
    }
    const unsupported = fixture({ playError: Object.assign(new Error('unsupported source'), { name: 'NotSupportedError' }) }); await turn();
    assert.match(unsupported.status.textContent, /不支持/); assert.equal(unsupported.warnings[0][1].category, 'unsupported');
    const other = fixture({ playError: new Error('unexpected playback failure') }); await turn();
    assert.match(other.status.textContent, /媒体播放失败/); assert.equal(other.warnings[0][1].category, 'playback');
});

test('错误诊断仅包含媒体状态，不泄漏URL和凭据；正常canplay/playing与用户暂停恢复UI', async () => {
    const f = fixture(); await turn(); f.media.emit('waiting');
    f.media.error = { code: 3, message: 'decode failed https://host/stream?token=sensitive; cookie=private-cookie /stream?session=private-session' }; f.media.emit('error');
    const diagnostic = JSON.stringify(f.warnings);
    assert.doesNotMatch(diagnostic, /sensitive|private-cookie|private-session|secret-value|https:\/\//);
    assert.match(diagnostic, /已隐藏|资源地址/);
    assert.equal(f.warnings[0][1].fileId, 'test');
    assert.equal(f.status.role, 'status'); assert.equal(f.status['aria-live'], 'polite');
    assert.deepEqual(Object.keys(f.warnings[0][1]).sort(), ['buffered', 'category', 'code', 'currentTime', 'duration', 'fileId', 'message', 'name', 'networkState', 'readyState'].sort());
    for (const event of ['canplay', 'playing']) {
        f.media.error = null; f.media.emit(event);
        assert.equal(f.wrapper.classList.contains('is-media-error'), false); assert.equal(f.wrapper.classList.contains('is-buffering'), false); assert.equal(f.status.hidden, true);
    }
    f.media.emit('waiting'); f.play.onclick();
    assert.equal(f.media.paused, true); assert.equal(f.wrapper.classList.contains('is-buffering'), false); assert.equal(f.status.hidden, true);
    f.play.onclick(); await turn(); f.media.emit('playing'); assert.equal(f.media.paused, false); assert.equal(f.status.hidden, true);
    const count = f.warnings.length; f.media._disposeDiskMedia(); f.media.error = { code: 1, message: 'source removed' }; f.media.emit('error');
    assert.equal(f.warnings.length, count, '释放播放器引发的中止不应再次报错');
});

test('音频原生解码错误使用同一错误状态；恢复播放后清除等待和错误提示', async () => {
    const f = fixture({ mediaType: 'audio/mp4' }); await turn();
    assert.equal(f.media.tagName, 'AUDIO'); f.media.emit('waiting');
    f.media.error = { code: 3, message: 'AUDIO_DECODER_ERROR' }; f.media.emit('error');
    assert.match(f.status.textContent, /无法解码/); assert.equal(f.wrapper.classList.contains('is-buffering'), false);
    assert.equal(f.warnings[0][1].fileId, 'test'); assert.equal(f.warnings[0][1].category, 'decode');
    f.media.error = null; f.media.emit('playing');
    assert.equal(f.status.hidden, true); assert.equal(f.wrapper.classList.contains('is-media-error'), false);
});
