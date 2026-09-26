const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const source = file => fs.readFileSync(path.join(root, file), 'utf8');

test('Service Worker 只顺序预缓存核心资源且单个 404 不阻止网页 ZIP 运行服务安装', () => {
    const worker = source('service-worker.js');
    assert.match(worker, /instant-tunnel-v62/);
    assert.match(worker, /for \(const resource of PRECACHE_CORE\)/);
    assert.match(worker, /if \(response\.ok && !response\.redirected\) await cache\.put/);
    assert.doesNotMatch(worker, /Promise\.allSettled\(APP_SHELL\.map/);
    assert.doesNotMatch(worker, /cache:\s*['"]reload['"]/);
    assert.doesNotMatch(worker, /cache\.addAll\(APP_SHELL\)/);
});

test('网页 ZIP 两个入口显示启动阶段并对 Service Worker 等待设置超时', () => {
    const runtime = source('client/web-zip-runtime.js');
    const preview = source('pages/web-zip-preview.html');
    const workshop = source('client/web-workshop.js');
    assert.match(runtime, /Promise\.race\(\[\s*navigator\.serviceWorker\.ready/);
    assert.match(runtime, /网页 ZIP 运行服务启动超时/);
    assert.match(runtime, /web-zip-runtime-activate/);
    assert.match(runtime, /controllerchange/);
    assert.match(runtime, /X-Web-Zip-Runtime/);
    assert.match(runtime, /options\.onStatus\?\.\('正在启动网页 ZIP 运行服务/);
    assert.match(preview, /正在解压网页 ZIP/);
    assert.match(preview, /WebZipRuntime\.mount\(entries,\{onStatus/);
    assert.match(workshop, /web-workshop-preview-status/);
    assert.match(workshop, /global\.WebZipRuntime\.mount\(files,\{onStatus/);
    assert.match(preview, /renderEpoch/);
    assert.match(workshop, /previewEpoch/);
});

test('网页工坊发布等待最后编辑版本打包完成并使用该次归档', () => {
    const workshop = source('client/web-workshop.js');
    assert.match(workshop, /return\{draft,revision,archive:snapshot\.archive\}/);
    assert.match(workshop, /do\{clearTimeout\(saveTimer\);saved=await saveDraft\(draft\);\}while/);
    assert.match(workshop, /new File\(\[saved\.archive\]/);
    assert.match(workshop, /正在保存并发布/);
    assert.match(workshop, /await publishDraft\(draft,event\.target\)/);
});

test('SNS 与 YouTube Premium 支持记忆目标并向 Telegram 发送原文件', () => {
    const server = source('server.js');
    const client = source('client/telegram-target-forward.js');
    const sns = source('pages/sns-dl.html');
    const youtube = source('pages/youtube-premium-dl.html');
    assert.match(server, /TELEGRAM_FORWARD_TARGETS_PATH/);
    assert.match(server, /buildTelegramDocumentsMultipart/);
    assert.match(server, /\/api\/telegram-forward-targets/);
    assert.match(server, /\/api\/sns-dl\/tasks\/:taskId\/telegram-forward/);
    assert.match(server, /\/api\/youtube-premium\/tasks\/:taskId\/telegram-forward/);
    assert.match(client, /转发到指定的Telegram目标/);
    assert.match(client, /发送原文件/);
    assert.match(client, /telegram-target-remove/);
    assert.match(client, /caption\.maxLength = 1024/);
    assert.match(sns, /TelegramTargetForward\.create/);
    assert.match(youtube, /TelegramTargetForward\.create/);
});
