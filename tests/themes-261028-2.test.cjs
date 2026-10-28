'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const app = read('app.js');
const html = read('pages/index.html');
const themeSource = app.slice(app.indexOf('function applyTheme('), app.indexOf('function isTunnelOwner('));
const expected = ['lumen', 'orbit', 'classic', 'atelier', 'social'];

function fixture({ stored = null, remove = [] } = {}) {
    const writes = [], logs = [], handlers = {};
    const names = expected.filter(name => !remove.includes(name));
    const buttons = names.flatMap(theme => ['settings', 'quick'].map(menu => {
        const classes = new Set();
        return { dataset: { theme }, menu, classes, classList: { toggle(name, enabled) { if (enabled) classes.add(name); else classes.delete(name); } } };
    }));
    const unrelatedState = { draft: '未保存的正文', scrollTop: 137, account: '999000003', playing: true, volume: 0.35 };
    const body = { dataset: {}, child: unrelatedState };
    const context = vm.createContext({
        document: {
            body,
            documentElement: { clientWidth: 1280 },
            querySelectorAll: () => buttons,
            getElementById: () => null,
            addEventListener(name, run) { handlers[name] = run; }
        },
        window: { addEventListener() {} },
        localStorage: { getItem: () => stored, setItem(key, value) { writes.push([key, value]); } },
        historyLog: (...args) => logs.push(args)
    });
    const source = themeSource.replace(/Object\.freeze\(\['lumen', 'orbit', 'classic', 'atelier', 'social'\]\)/,
        `Object.freeze(${JSON.stringify(names)})`);
    vm.runInContext(source + ';this.api={apply:applyTheme,cycle:cycleTheme,init:initThemeSwitcher};', context);
    return { ...context.api, body, buttons, writes, logs, unrelatedState };
}

test('设置及顶栏菜单按同一顺序列出两款新主题，默认选择仍为 Classic', () => {
    for (const className of ['theme-option', 'theme-quick-option']) {
        const items = [...html.matchAll(new RegExp(`<button class="${className}"[^>]*data-theme="([^"]+)"`, 'g'))].map(match => match[1]);
        assert.deepEqual(items, expected);
    }
    const f = fixture(); f.init();
    assert.equal(f.body.dataset.theme, 'classic');
    assert.deepEqual(f.writes, [['uiTheme', 'classic']]);
});

test('保留已有主题偏好，循环越过末项后按 Lumen、Orbit、Classic 继续', () => {
    for (const stored of expected) {
        const f = fixture({ stored }); f.init();
        assert.equal(f.body.dataset.theme, stored);
        assert.equal(f.buttons.filter(button => button.classes.has('active')).length, 2);
    }
    const f = fixture({ stored: 'social' }); f.init();
    const actual = Array.from({ length: expected.length + 1 }, () => f.cycle('control-center'));
    assert.deepEqual(actual, [...expected, 'lumen']);
    assert.equal(f.logs.length, expected.length + 1);
    assert.ok(f.logs.every(([, info]) => info.source === 'control-center'));
});

test('失效主题回退；移除全部旧主题登记后仍可恢复旧偏好并循环新主题', () => {
    const unknown = fixture({ stored: 'removed-theme' }); unknown.init();
    assert.equal(unknown.body.dataset.theme, 'classic');
    const graphite = fixture({ stored: 'graphite' }); graphite.init();
    assert.equal(graphite.body.dataset.theme, 'classic');
    assert.deepEqual(graphite.writes, [['uiTheme', 'classic']]);
    const removed = fixture({ stored: 'graphite', remove: ['classic', 'graphite', 'atelier', 'social'] }); removed.init();
    assert.equal(removed.body.dataset.theme, 'lumen');
    assert.deepEqual(removed.writes, [['uiTheme', 'lumen']]);
    assert.equal(removed.cycle(), 'orbit');
    assert.equal(removed.cycle(), 'lumen');
    assert.equal(removed.apply('classic'), 'lumen');
});

test('运行中换肤仅更新主题与入口选中态，不替换页面或修改草稿、滚动及播放状态', () => {
    const f = fixture({ stored: 'graphite' }); f.init();
    const state = f.body.child, before = { ...state };
    for (const theme of expected) {
        assert.equal(f.apply(theme), theme);
        assert.strictEqual(f.body.child, state);
        assert.deepEqual(state, before);
        assert.deepEqual(f.buttons.filter(button => button.classes.has('active')).map(button => button.dataset.theme), [theme, theme]);
    }
});

test('旧主题文件仅保留专属规则，共享布局基础独立且新皮肤在组件样式之后加载', () => {
    const legacy = read('client/themes-legacy.css'), base = read('client/index.css');
    assert.doesNotMatch(base, /body\[data-theme="(?:graphite|atelier|social)"\]/);
    assert.match(base, /body\s*\{[\s\S]*?--panel-bg:[\s\S]*?--text-main:/);
    assert.match(base, /\.main-layout\s*\{\s*display: grid;/);
    assert.match(base, /\.control-center-tile\{/);
    const selectors = [...legacy.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{/g)].map(match => match[1].trim());
    assert.equal(selectors.length, 3);
    assert.ok(selectors.every(selector => /^body\[data-theme="(?:atelier|social)"\]/.test(selector)));
    assert.doesNotMatch(legacy, /graphite/);
    assert.match(legacy, /body\[data-theme="atelier"\] \.main-layout\s*\{\s*grid-template-columns: 340px minmax\(0, 1fr\) 360px;/);
    const styles = [...html.matchAll(/<link\s+rel="stylesheet"\s+href="([^"]+)"/g)].map(match => match[1]);
    assert.ok(styles.indexOf('/client/themes-legacy.css') < styles.indexOf('/client/index.css'));
    assert.equal(styles.at(-1), '/client/themes.css');
});

test('两份主题资源加入现有 Service Worker 壳资源，业务缓存内容版本保持不变', () => {
    const sw = read('service-worker.js');
    for (const file of ['/client/themes.css', '/client/themes-legacy.css']) {
        assert.equal(sw.split(`'${file}'`).length - 1, 1);
    }
    assert.match(sw, /CACHE_NAME = 'instant-tunnel-v\d+-content-v8-themes-261028-followup'/);
});

function preferenceFixture(stored, { unavailable = false, page = 'downloads', current } = {}) {
    const handlers = new Map(), reads = [], dataset = {};
    if (page) dataset.themePage = page;
    if (current) dataset.theme = current;
    const business = Object.freeze({ running: true, bytes: 1024, source: 'magnet' });
    const storage = {
        getItem(key) { reads.push(key); if (unavailable) throw Error('Storage unavailable'); return stored; },
        setItem() { throw Error('Theme bridge must not write storage'); },
        removeItem() { throw Error('Theme bridge must not remove storage'); }
    };
    vm.runInNewContext(read('client/theme-preference.js'), {
        window: { localStorage: storage, addEventListener(name, run) { handlers.set(name, run); } },
        document: { body: { dataset, business } }
    });
    return { dataset, business, reads, handlers, change(value, key = 'uiTheme') { stored = value; handlers.get('storage')?.({ key }); } };
}

test('独立前台页只读共享主题，新主题跨文档同步，旧主题和清空操作恢复原外观', () => {
    const f = preferenceFixture('lumen');
    assert.equal(f.dataset.theme, 'lumen');
    f.change('orbit'); assert.equal(f.dataset.theme, 'orbit');
    for (const theme of ['classic', 'graphite', 'atelier', 'social', 'unknown', null]) {
        f.change('orbit'); f.change(theme);
        assert.equal(f.dataset.theme, undefined);
        assert.equal(f.dataset.themePage, 'downloads');
    }
    f.change('lumen'); f.change(null, null); assert.equal(f.dataset.theme, undefined);
    assert.ok(f.reads.every(key => key === 'uiTheme'));
    assert.deepEqual(f.business, { running: true, bytes: 1024, source: 'magnet' });
});

test('独立页忽略其它存储变更；存储不可读时不阻塞原页面业务', () => {
    const f = preferenceFixture('orbit');
    const count = f.reads.length;
    f.change('lumen', 'deviceId');
    assert.equal(f.reads.length, count);
    assert.equal(f.dataset.theme, 'orbit');
    const blocked = preferenceFixture('orbit', { unavailable: true });
    assert.equal(blocked.dataset.theme, undefined);
    blocked.change('lumen'); assert.equal(blocked.dataset.theme, undefined);
});

test('主壳启动只预读新主题，不增加 storage 同步，也不删除既有旧主题属性', () => {
    for (const theme of ['lumen', 'orbit']) {
        const f = preferenceFixture(theme, { page: null });
        assert.equal(f.dataset.theme, theme);
        assert.equal(f.handlers.size, 0);
        f.change('classic'); assert.equal(f.dataset.theme, theme);
    }
    for (const theme of ['classic', 'graphite', 'unknown', null]) {
        const f = preferenceFixture(theme, { page: null, current: 'graphite' });
        assert.equal(f.dataset.theme, 'graphite');
        assert.equal(f.handlers.size, 0);
    }
    const blocked = preferenceFixture('orbit', { page: null, current: 'classic', unavailable: true });
    assert.equal(blocked.dataset.theme, 'classic');
});

test('四个应用自有独立页共享同一主题桥，主壳提前接入，正式构建和壳缓存包含脚本', () => {
    for (const [file, page] of [['downloadList', 'downloads'], ['downloader', 'downloader'], ['light-file-parts', 'light-parts'], ['device', 'device']]) {
        const source = read(`pages/${file}.html`);
        assert.match(source, new RegExp(`<body data-theme-page="${page}">`));
        assert.equal(source.split('href="/client/themes.css"').length - 1, 1);
        assert.equal(source.split('<script defer src="/client/theme-preference.js"></script>').length - 1, 1);
        assert.ok(source.indexOf('href="/client/themes.css"') > source.lastIndexOf('</style>'));
        assert.doesNotMatch(source, /src="\/app\.js"/);
    }
    assert.match(html, /<script defer src="\/client\/theme-preference\.js"><\/script>[\s\S]*<\/head>/);
    assert.match(read('tools/deploy/build.mjs'), /'client\/theme-preference\.js'/);
    assert.match(read('service-worker.js'), /'\/client\/theme-preference\.js'/);
});
