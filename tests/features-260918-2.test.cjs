'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const root = path.resolve(__dirname, '..');
const source = file => fs.readFileSync(path.join(root, file), 'utf8');

test('更新网页 ZIP 不会沿用旧版本的物理文件元信息', () => {
    const app = source('app.js');
    const start = app.indexOf('async function publishWebZipUpdate');
    const end = app.indexOf('function focusPublishedWebZip', start);
    const update = app.slice(start, end);
    assert.match(update, /size: _oldSize/);
    assert.match(update, /type: _oldType/);
    assert.match(update, /\.\.\.versionMetadata/);
    assert.doesNotMatch(update, /createFileInfoFromFile\(file, \{\s*\.\.\.current/);
});

test('sendVideo multipart 可附带 Telegram thumbnail 且长度准确', async () => {
    const { buildTelegramSingleFileMultipart } = require('../server/telegram-multipart');
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'd2t-video-thumbnail-'));
    try {
        const videoPath = path.join(directory, 'video.mp4');
        const thumbnailPath = path.join(directory, 'thumbnail.jpg');
        const video = Buffer.from([0, 1, 2, 3]);
        const thumbnail = Buffer.from([255, 216, 255, 217]);
        fs.writeFileSync(videoPath, video); fs.writeFileSync(thumbnailPath, thumbnail);
        const multipart = buildTelegramSingleFileMultipart({
            method:'sendVideo', fieldName:'video', chatId:'-100123',
            fields:{ thumbnail:'attach://thumbnail', supports_streaming:'true' },
            file:{ path:videoPath, name:'video.mp4', type:'video/mp4', size:video.length },
            attachments:[{ fieldName:'thumbnail', path:thumbnailPath, name:'thumbnail.jpg', type:'image/jpeg', size:thumbnail.length }]
        });
        const chunks = [];
        for await (const chunk of multipart.body) chunks.push(Buffer.from(chunk));
        const body = Buffer.concat(chunks);
        assert.equal(body.length, multipart.contentLength);
        assert.match(body.toString('latin1'), /name="thumbnail"\r\n\r\nattach:\/\/thumbnail/);
        assert.match(body.toString('latin1'), /name="thumbnail"; filename="thumbnail\.jpg"/);
        assert.ok(body.indexOf(video) >= 0);
        assert.ok(body.indexOf(thumbnail) >= 0);
    } finally { fs.rmSync(directory, { recursive:true, force:true }); }
});

test('Telegram 内容管理只在本地保存 Telegram 归档指针并忽略托管频道', () => {
    const moduleSource = source('server/telegram-content-manager.js');
    const server = source('server.js');
    const page = source('pages/telegram-content.html');
    assert.match(moduleSource, /fileId:result\.document\.file_id/);
    assert.match(moduleSource, /readArchive\(record\.archive\)/);
    assert.match(moduleSource, /isStorageChat\(message\.chat\)/);
    assert.match(server, /update\.channel_post \|\| update\.edited_channel_post/);
    assert.match(server, /telegramContentManager\.registerRoutes/);
    assert.match(page, /multiple/);
    assert.match(page, /原文件形式/);
    assert.match(page, /压缩预览形式/);
});

test('Telegram 内容归档可由远端指针恢复，索引不落地消息正文', async () => {
    const { createTelegramContentManager } = require('../server/telegram-content-manager');
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'd2t-telegram-content-'));
    const archives = new Map();
    const telegram = {
        async call(_backend, method, _payload, init) {
            assert.equal(method, 'sendDocument');
            const chunks = [];
            for await (const chunk of init.body) chunks.push(Buffer.from(chunk));
            const body = Buffer.concat(chunks);
            const marker = Buffer.from('{"schema":1');
            const begin = body.indexOf(marker);
            const end = body.indexOf(Buffer.from('\r\n--'), begin);
            const archive = body.subarray(begin, end);
            archives.set('remote-archive', archive);
            return { message_id:91, document:{ file_id:'remote-archive', file_unique_id:'unique-archive' } };
        },
        async readPart(_backend, pointer) { return Readable.from([archives.get(pointer.fileId)]); }
    };
    try {
        const manager = createTelegramContentManager({
            dataDir:directory, telegram,
            getBackend:channelId => ({ token:'token', channelId:channelId || '@storage', baseUrl:'https://api.telegram.org' }),
            getStorageChannelIds:() => ['@storage'], createVideoThumbnail:async () => null
        });
        assert.equal(manager.isStorageChat({ id:-1001, username:'storage' }), true);
        await manager.archiveIncoming({ message_id:7, date:123, chat:{ id:42, type:'private', first_name:'Alice' }, text:'只存在 Telegram 归档中的正文' });
        const localIndex = fs.readFileSync(path.join(directory, 'telegram-content-index.json'), 'utf8');
        assert.doesNotMatch(localIndex, /只存在 Telegram 归档中的正文/);
        assert.match(localIndex, /remote-archive/);
        const restored = await manager.listMessages('42');
        assert.equal(restored[0].message.text, '只存在 Telegram 归档中的正文');
    } finally { fs.rmSync(directory, { recursive:true, force:true }); }
});

test('Telegram 转发目标只接受公开用户名或数字 chat ID，不保留不可实现的私有邀请链接分支', () => {
    const server = source('server.js');
    assert.match(server, /公开 t\.me\/用户名链接或数字 chat ID/);
    assert.doesNotMatch(server, /privateLink = value\.match|telegramPrivateInviteCandidates|getTelegramForwardChat|inviteLink/);
    assert.doesNotMatch(server, /importChatInvite|checkChatInvite/);
});

test('视频预览封面直接从待发送视频生成，以显示比例而非任务封面为准', () => {
    const server = source('server.js');
    const start = server.indexOf('async function prepareTelegramForwardVideoThumbnail');
    const end = server.indexOf('async function forwardTaskFileToTelegram', start);
    const thumbnail = server.slice(start, end);
    assert.match(thumbnail, /'-i', videoFile\.path/);
    assert.match(thumbnail, /gte\(dar,1\)/);
    assert.match(thumbnail, /setsar=1/);
    assert.doesNotMatch(thumbnail, /ensureSnsDownloadTaskCover|ensureYoutubePremiumTaskCover|service\?\.getFile/);
});
