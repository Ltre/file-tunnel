'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const root = path.resolve(__dirname, '..');
const source = file => fs.readFileSync(path.join(root, file), 'utf8');

function archiveBody(body) {
    const marker = Buffer.from('{"schema":1');
    const begin = body.indexOf(marker);
    const end = body.indexOf(Buffer.from('\r\n--'), begin);
    return body.subarray(begin, end);
}

test('Telegram 聊天归档按锚点分页并将远端正文缓存三天', async t => {
    const { createTelegramContentManager } = require('../server/telegram-content-manager');
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'd2t-telegram-page-cache-'));
    t.after(() => fs.rmSync(directory, { recursive:true, force:true }));
    const archives = new Map();
    let archiveNumber = 0, reads = 0;
    const telegram = {
        async call(_backend, method, _payload, init) {
            assert.equal(method, 'sendDocument');
            const chunks = [];
            for await (const chunk of init.body) chunks.push(Buffer.from(chunk));
            const id = `remote-${++archiveNumber}`;
            archives.set(id, archiveBody(Buffer.concat(chunks)));
            return { message_id:100 + archiveNumber, document:{ file_id:id, file_unique_id:`unique-${archiveNumber}` } };
        },
        async readPart(_backend, pointer) {
            reads++;
            await new Promise(resolve => setTimeout(resolve, 5));
            return Readable.from([archives.get(pointer.fileId)]);
        }
    };
    const manager = createTelegramContentManager({
        dataDir:directory, telegram,
        getBackend:channelId => ({ token:'token', channelId:channelId || '@storage' }),
        getStorageChannelIds:() => ['@storage'], createVideoThumbnail:async () => null
    });
    for (let value = 1; value <= 6; value++) {
        await manager.archiveIncoming({ message_id:value, date:value, chat:{ id:42, type:'private', first_name:'Alice' }, text:`消息 ${value}` });
    }
    fs.rmSync(path.join(directory, 'telegram-content-cache'), { recursive:true, force:true });

    const [latest, concurrent] = await Promise.all([
        manager.listMessagePage('42', { direction:'latest', limit:2 }),
        manager.listMessagePage('42', { direction:'latest', limit:2 })
    ]);
    assert.deepEqual(latest.messages.map(item => item.message.text), ['消息 5', '消息 6']);
    assert.deepEqual(concurrent.messages.map(item => item.message.text), ['消息 5', '消息 6']);
    assert.equal(reads, 2, '并发读取同一归档应共享远端请求');
    assert.equal(latest.paging.hasBefore, true);
    assert.equal(latest.paging.hasAfter, false);

    await manager.listMessagePage('42', { direction:'latest', limit:2 });
    assert.equal(reads, 2, '三天有效期内应直接使用本地归档缓存');
    const old = new Date(Date.now() - 4 * 24 * 60 * 60 * 1000);
    for (const entry of fs.readdirSync(path.join(directory, 'telegram-content-cache'))) {
        fs.utimesSync(path.join(directory, 'telegram-content-cache', entry), old, old);
    }
    await manager.listMessagePage('42', { direction:'latest', limit:2 });
    assert.equal(reads, 4, '超过三天的归档缓存应重新读取 Telegram');

    const previous = await manager.listMessagePage('42', { direction:'before', anchor:latest.paging.firstAnchor, limit:2 });
    assert.deepEqual(previous.messages.map(item => item.message.text), ['消息 3', '消息 4']);
    assert.equal(previous.paging.hasBefore, true);
    assert.equal(previous.paging.hasAfter, true);
    const around = await manager.listMessagePage('42', { direction:'around', anchor:latest.paging.firstAnchor, limit:3 });
    assert.deepEqual(around.messages.map(item => item.message.text), ['消息 4', '消息 5', '消息 6']);
    assert.equal(around.paging.requestedAnchor, latest.paging.firstAnchor);
});

test('Telegram 内容页使用独立滚动消息区、浏览锚点和首附件 caption', () => {
    const client = source('client/telegram-content.js');
    const css = source('client/telegram-content.css');
    const page = source('pages/telegram-content.html');
    assert.match(client, /telegramContentBrowseAnchor:v1/);
    assert.match(client, /direction === 'before'/);
    assert.match(client, /direction === 'after'/);
    assert.match(client, /scrollHeight - messages\.scrollTop - messages\.clientHeight/);
    assert.match(client, /MAX_RENDERED_MESSAGES = 160/);
    assert.match(client, /trimRenderedMessages\('before'\)/);
    assert.match(client, /trimRenderedMessages\('after'\)/);
    assert.match(client, /if \(text && !files\.length\).*\/messages/);
    assert.match(client, /attachmentCaption = text\.slice\(0, 1024\)/);
    assert.match(client, /caption:index === 0 \? attachmentCaption : ''/);
    assert.match(css, /grid-template-rows:auto auto minmax\(0,1fr\) auto/);
    assert.match(css, /\.messages\{[^}]*overflow:auto/);
    assert.match(css, /#telegramComposer\{[^}]*max-height/);
    assert.match(page, /最长 3 天的读取缓存/);
});

test('前台 Service Worker 不再并发强制回源整个应用外壳', () => {
    const worker = source('service-worker.js');
    assert.match(worker, /instant-tunnel-v63/);
    assert.match(worker, /const PRECACHE_CORE = \['\/index\.html', '\/manifest\.webmanifest', '\/tunnel-icon\.svg'\]/);
    assert.doesNotMatch(worker, /cache:\s*['"]reload['"]/);
    assert.doesNotMatch(worker, /Promise\.allSettled\(APP_SHELL\.map/);
    assert.match(worker, /const cached = await cache\.match\(url\.pathname\)/);
    assert.match(worker, /if \(cached\) return cached/);
});
