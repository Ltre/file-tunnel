'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto'), vm = require('node:vm');
const read = relative => fs.readFileSync(path.join(__dirname, '..', relative), 'utf8');
const build = read('tools/deploy/build.mjs'), verify = read('tools/deploy/verify.mjs');
const slice = (source, start, end) => source.slice(source.indexOf(start), source.indexOf(end));

test('发布验证只检查实际HTML资源，跳过转义手册示例、注释及JS字符串，仍检查document.write脚本', () => {
    const context = vm.createContext({});
    vm.runInContext(slice(verify, 'function collectHtmlRefs(', 'async function checkJavaScriptSyntax('), context);
    const refs = context.collectHtmlRefs(`<a href="/s3-management">S3</a><a href="/s3-api-guide">帮助</a>
        <link href="/assets/style.0123456789.min.css" rel="stylesheet">
        &lt;script src="/missing-example.js"&gt;&lt;/script&gt;
        <!-- <img src="/missing-comment.png"> -->
        <script>const example = 'href="/missing-string.css"';document.write(\`<script defer src="/assets/app.0123456789.min.js\${suffix}"><\\/script>\`);</script>
        <script defer src="/assets/main.0123456789.min.js"></script>`);
    assert.deepEqual([...refs].sort(), ['/assets/app.0123456789.min.js', '/assets/main.0123456789.min.js', '/assets/style.0123456789.min.css', '/s3-api-guide', '/s3-management'].sort());
    assert.equal(context.shouldExistAsStaticFile('/s3-management'), false);
    assert.equal(context.shouldExistAsStaticFile('/s3-api-guide'), false);
    assert.equal(context.shouldExistAsStaticFile('/assets/missing.0123456789.min.js'), true);
});

test('发布脚本改写Worker及动态QRCode真实URL，补齐工坊、通知、Telegram和S3脚本', async () => {
    const writes = new Map(), sourceRoot = path.join(__dirname, '..');
    const context = vm.createContext({ ROOT: sourceRoot, path, crypto,
        fs: { readFile: async filename => read(path.relative(sourceRoot, filename)), mkdir: async () => {}, writeFile: async (filename, value) => writes.set(filename, value) },
        minifyJs: async raw => raw, sizeStat: () => ({}) });
    vm.runInContext(slice(build, 'const SCRIPT_SOURCES = [', 'const PAGE_ROUTES = {')
        + slice(build, 'function hashContent(', 'function formatBuildTimestamp(')
        + slice(build, 'function assetNameForScript(', 'function extractPageStyles('), context);
    const result = await context.buildScripts('/output', {});
    for (const source of ['client/cache-store-worker.js', 'client/disk-content-hash-worker.js', 'client/web-zip-runtime.js', 'client/web-workshop.js', 'client/notification-center.js', 'client/telegram-content.js', 'client/telegram-target-forward.js', 'client/s3-management.js']) assert.ok(result.assets[source]);
    const cacheScript = writes.get(path.join('/output', result.assets['client/cache-store.js'].slice(1)));
    assert.ok(cacheScript.includes(`new Worker('${result.assets['client/cache-store-worker.js']}')`));
    assert.ok(!cacheScript.includes("new Worker('/client/cache-store-worker.js')"));
    const diskScript=writes.get(path.join('/output',result.assets['client/disk-client.js'].slice(1)));
    assert.ok(diskScript.includes(`new Worker('${result.assets['client/disk-content-hash-worker.js']}')`));
    assert.ok(!diskScript.includes("new Worker('/client/disk-content-hash-worker.js')"));
    const appScript = writes.get(path.join('/output', result.assets['app.js'].slice(1)));
    assert.ok(appScript.includes(`script.src = '${result.assets['client/qrcode-1.0.0.min.js']}'`));
});

test('构建SW同步改写网络优先脚本路径及CSS资源，S3管理资源不入应用壳', async () => {
    let written;
    const context = vm.createContext({ ROOT: '/source', path, PAGE_ROUTES: { 'index.html': ['/index.html'] },
        fs: { readFile: async () => read('service-worker.js'), writeFile: async (_path, value) => { written = value; } }, sizeStat: () => ({}) });
    vm.runInContext(slice(build, 'function escapeRegExp(', 'function extractPageStyles(')
        + slice(build, 'async function buildServiceWorker(', 'function sizeStat('), context);
    const scripts = { 'app.js': '/assets/app.0123456789.min.js', 'client/web-zip-runtime.js': '/assets/web-zip-runtime.0123456789.min.js', 'client/s3-management.js': '/assets/s3-management.0123456789.min.js' };
    const styles = { index: '/assets/index.0123456789.min.css', 's3-management': '/assets/s3-management.0123456789.min.css' };
    const result = await context.buildServiceWorker('/output', 'test-build', scripts, styles);
    assert.ok(result.appShell.includes(styles.index));
    assert.ok(!result.appShell.includes(scripts['client/s3-management.js']));
    assert.ok(!result.appShell.includes(styles['s3-management']));
    assert.ok(!written.includes('/client/web-zip-runtime.js'));
    assert.ok(written.includes(`url.pathname === '${scripts['client/web-zip-runtime.js']}'`));
    assert.ok(written.includes("const CACHE_NAME = 'instant-tunnel-test-build'"));
});

test('发布页面按原CSS级联顺序打包外部样式，defer脚本属性保留', async () => {
    const writes = new Map();
    const html = '<head><link rel="stylesheet" href="/client/notification-center.css"><style>.native{color:blue}</style><link rel="stylesheet" href="/client/telegram-content.css?v=1"><script defer src="/client/telegram-content.js"></script></head>';
    const context = vm.createContext({ ROOT: '/source', path, crypto,
        fs: { readdir: async () => ['index.html'], readFile: async filename => filename.includes('pages') ? html : filename.includes('notification') ? '.first{color:red}' : '.last{color:green}',
            mkdir: async () => {}, writeFile: async (filename, value) => writes.set(filename, value) },
        minifyCss: raw => raw, minifyHtml: async raw => raw, sizeStat: () => ({}) });
    vm.runInContext(slice(build, 'function hashContent(', 'function formatBuildTimestamp(')
        + slice(build, 'function publicPath(', 'async function buildScripts(')
        + slice(build, 'function escapeRegExp(', 'function renderTemplate('), context);
    const result = await context.buildPages('/output', { 'client/telegram-content.js': '/assets/content.0123456789.min.js' }, 'id', {});
    const css = writes.get(path.join('/output', result.styles.index.slice(1)));
    assert.ok(css.indexOf('.first') < css.indexOf('.native')); assert.ok(css.indexOf('.native') < css.indexOf('.last'));
    assert.ok(writes.get(path.join('/output', 'pages', 'index.html')).includes('<script defer src="/assets/content.0123456789.min.js">'));
});
