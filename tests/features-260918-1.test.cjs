'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const source = file => fs.readFileSync(path.join(root, file), 'utf8');

test('全盘搜索删除只按稳定 ID 或完整目录路径移除结果', () => {
    const diskUi = source('client/disk-ui.js');
    const start = diskUi.indexOf('function isTelegramDriveGlobalSearchActive()');
    const end = diskUi.indexOf('function scheduleTelegramDriveSearch()');
    const context = {};
    vm.runInNewContext(`
        let telegramDriveSearchData = {
            folders:[{kind:'directory',path:'one/sub'},{kind:'directory',path:'two/sub'}],
            files:[
                {kind:'file',id:'file-one',name:'A.mp4',folderPath:'one'},
                {kind:'file',id:'file-two',name:'A.mp4',folderPath:'two'},
                {kind:'file',id:'file-child',name:'B.mp4',folderPath:'one/sub'}
            ]
        };
        ${diskUi.slice(start, end)}
        pruneTelegramDriveSearchResults([{kind:'file',id:'file-one',name:'A.mp4',folderPath:'one'}]);
        this.afterFile = JSON.parse(JSON.stringify(telegramDriveSearchData));
        pruneTelegramDriveSearchResults([{kind:'directory',path:'one/sub'}]);
        this.afterDirectory = JSON.parse(JSON.stringify(telegramDriveSearchData));
    `, context);
    const afterFile = JSON.parse(JSON.stringify(context.afterFile));
    const afterDirectory = JSON.parse(JSON.stringify(context.afterDirectory));
    assert.deepEqual(afterFile.files.map(item => item.id), ['file-two', 'file-child']);
    assert.deepEqual(afterDirectory.files.map(item => item.id), ['file-two']);
    assert.deepEqual(afterDirectory.folders.map(item => item.path), ['two/sub']);
    assert.match(diskUi, /const retainedSearchData = isTelegramDriveGlobalSearchActive\(\) \? telegramDriveSearchData : null/);
    assert.match(diskUi, /if \(isTelegramDriveGlobalSearchActive\(\)\) scheduleTelegramDriveSearch\(\)/);
});

test('网页 ZIP iframe 保持同源身份以便 Service Worker 接管 Runtime URL', () => {
    const standalone = source('pages/web-zip-preview.html');
    const workshop = source('client/web-workshop.js');
    const worker = source('service-worker.js');
    assert.match(standalone, /sandbox="allow-same-origin allow-scripts/);
    assert.match(workshop, /sandbox','allow-same-origin allow-scripts/);
    assert.match(worker, /instant-tunnel-v55/);
    assert.match(worker, /url\.pathname\.startsWith\('\/web-zip-runtime\/'\)/);
});

test('Telegram 单文件媒体 multipart 保留原始字节并设置预览字段', async () => {
    const { buildTelegramSingleFileMultipart } = require('../server/telegram-multipart');
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'd2t-telegram-preview-'));
    try {
        const filePath = path.join(tempDir, 'clip.mp4');
        const payload = Buffer.from([0, 1, 2, 250, 251, 252]);
        fs.writeFileSync(filePath, payload);
        const multipart = buildTelegramSingleFileMultipart({
            method:'sendVideo', fieldName:'video', chatId:'-10012345', caption:'测试',
            fields:{ supports_streaming:'true' }, file:{ path:filePath, name:'clip.mp4', type:'video/mp4', size:payload.length }
        });
        const chunks = [];
        for await (const chunk of multipart.body) chunks.push(Buffer.from(chunk));
        const body = Buffer.concat(chunks);
        assert.equal(multipart.method, 'sendVideo');
        assert.equal(body.length, multipart.contentLength);
        assert.match(body.toString('latin1'), /name="supports_streaming"\r\n\r\ntrue/);
        assert.match(body.toString('latin1'), /name="video"; filename="clip\.mp4"/);
        assert.ok(body.indexOf(payload) >= 0);
    } finally {
        fs.rmSync(tempDir, { recursive:true, force:true });
    }
});

test('Telegram 转发面板支持点外关闭、视频预览、公开目标和历史备注', () => {
    const client = source('client/telegram-target-forward.js');
    const css = source('client/telegram-target-forward.css');
    const server = source('server.js');
    assert.match(client, /!details\.contains\(event\.target\)\) details\.open = false/);
    assert.match(client, /supportVideoPreview:videoPreview\.checked/);
    assert.doesNotMatch(client, /supportImagePreview|telegram-target-image-preview/);
    assert.ok(client.indexOf("row.append(choose, remark, remove)") >= 0);
    assert.doesNotMatch(css, /telegram-target-image-warning/);
    assert.match(client, /公开 t\.me\/用户名链接或数字 chat ID/);
    assert.doesNotMatch(client, /私有邀请/);
    assert.match(server, /resolveTelegramForwardTarget/);
    assert.doesNotMatch(server, /privateLink = value\.match|telegramPrivateInviteCandidates|getTelegramForwardChat/);
    assert.match(server, /method:'sendVideo', fieldName:'video'/);
    assert.match(server, /thumbnail:'attach:\/\/thumbnail'/);
    assert.match(server, /app\.patch\('\/api\/telegram-forward-targets'/);
});
