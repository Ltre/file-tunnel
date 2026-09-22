'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createTelegramContentManager } = require('../server/telegram-content-manager');

const root = path.join(__dirname, '..');
const source = file => fs.readFileSync(path.join(root, file), 'utf8');

test('网页 ZIP 外部脚本要求新版 Runtime 协议与 JavaScript MIME', () => {
    const runtime = source('client/web-zip-runtime.js');
    const worker = source('service-worker.js');
    assert.match(runtime, /const RUNTIME_PROTOCOL = 2/);
    assert.match(runtime, /externalScriptMime === true/);
    assert.match(worker, /webZipRuntime:2, externalScriptMime:true/);
    assert.match(worker, /js:'text\/javascript; charset=utf-8'/);
    assert.match(worker, /mjs:'text\/javascript; charset=utf-8'/);
    assert.match(worker, /'X-Content-Type-Options': 'nosniff'/);
});

test('网页工坊在新 Tab 打开编辑手册，手册说明内外部资源路径', () => {
    const workshop = source('client/web-workshop.js');
    const guide = source('pages/web-workshop-guide.html');
    const server = source('server.js');
    assert.match(workshop, /href="\/web-workshop-guide\.html" target="_blank" rel="noopener"/);
    assert.match(server, /app\.get\('\/web-workshop-guide\.html'/);
    assert.match(guide, /\.html\.zip/);
    assert.match(guide, /script src="\/assets\/app\.js"/);
    assert.match(guide, /草稿箱/);
    assert.match(guide, /创建设备 ID/);
});

test('纯音乐任务不显示音轨修正，YouTube 非 m4a\/aac 片段给出明确警告', () => {
    const youtube = source('pages/youtube-premium-dl.html');
    const sns = source('pages/sns-dl.html');
    assert.match(youtube, /task\.downloadSections && !task\.asMusic && !\['audio', 'song'\]\.includes\(task\.mediaType\)/);
    assert.match(sns, /task\.downloadSections && !task\.asMusic && !\['audio','song'\]\.includes\(task\.mediaType\)/);
    assert.match(youtube, /selectedMusicCutNeedsOffsetWarning/);
    assert.match(youtube, /在剪切模式下选取非 m4a\/aac 音频编码，可能导致实际提取片段略有偏移/);
});

test('Telegram Webhook 订阅频道、群组和成员变更事件', () => {
    const server = source('server.js');
    for (const update of ['channel_post', 'edited_channel_post', 'my_chat_member', 'chat_member', 'chat_join_request']) {
        assert.match(server, new RegExp(`'${update}'`));
    }
    assert.match(server, /Bot Webhook 当前属于另一个部署地址，本页不会自动抢占/);
    const client = source('client/telegram-content.js');
    assert.match(client, /\/api\/telegram-content\/webhook-subscriptions/);
});

test('Telegram 内容策略拒绝新成员，停止私聊服务每天最多提醒一次', async t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'd2t-telegram-policy-'));
    t.after(() => fs.rmSync(directory, { recursive:true, force:true }));
    const calls = [];
    const telegram = {
        async call(_backend, method, payload) {
            calls.push({ method, payload });
            if (method === 'getMe') return { id:999, username:'content_bot', is_bot:true };
            if (method === 'getChatMember' && Number(payload.user_id) === 999) return { status:'administrator', user:{ id:999 }, can_manage_chat:true, can_promote_members:true, can_restrict_members:true, can_delete_messages:true };
            if (method === 'getChatMember') return { status:'member', user:{ id:Number(payload.user_id) } };
            if (method === 'sendMessage') return { message_id:50, date:Math.floor(Date.now() / 1000), chat:{ id:payload.chat_id, type:'private', first_name:'Stopped' }, from:{ id:999, is_bot:true }, text:payload.text };
            if (method === 'sendDocument') return { message_id:51, document:{ file_id:'archive-file', file_unique_id:'archive-unique' } };
            return true;
        },
        readPart() { throw new Error('not used'); }
    };
    const manager = createTelegramContentManager({
        dataDir:directory,
        telegram,
        getBackend:channelId => ({ token:'token', channelId:channelId || '-100-storage' }),
        getStorageChannelIds:() => ['-100-storage'],
        createVideoThumbnail:async () => null
    });

    await manager.observeChat({ id:-100123, type:'supergroup', title:'Group' });
    await manager.setPolicy('-100123', { rejectNewMembers:true });
    await manager.processUpdate({ chat_member:{ date:1, chat:{ id:-100123, type:'supergroup', title:'Group' }, old_chat_member:{ status:'left' }, new_chat_member:{ status:'member', user:{ id:123 } } } });
    assert.ok(calls.some(call => call.method === 'banChatMember' && call.payload.user_id === 123));
    await manager.performManagementAction('-100123', { action:'restrict', userId:123, permissions:{ can_send_messages:true } });
    await manager.performManagementAction('-100123', { action:'promote', userId:123, rights:{ can_restrict_members:true } });
    await manager.performManagementAction('-100123', { action:'remove', userId:123, ban:false });
    assert.ok(calls.some(call => call.method === 'restrictChatMember' && call.payload.permissions.can_send_messages === true));
    assert.ok(calls.some(call => call.method === 'promoteChatMember' && call.payload.can_restrict_members === true));
    assert.ok(calls.some(call => call.method === 'unbanChatMember' && call.payload.user_id === 123));

    await manager.observeChat({ id:456, type:'private', first_name:'Private' });
    await manager.setPolicy('456', { serviceStopped:true });
    const privateMessage = { message_id:1, date:1, chat:{ id:456, type:'private', first_name:'Private' }, from:{ id:456, is_bot:false }, text:'hello' };
    assert.equal((await manager.processUpdate({ message:privateMessage })).handled, true);
    assert.equal((await manager.processUpdate({ message:{ ...privateMessage, message_id:2 } })).handled, true);
    assert.equal(calls.filter(call => call.method === 'sendMessage' && call.payload.chat_id === 456).length, 1);
    assert.equal(calls.find(call => call.method === 'sendMessage' && call.payload.chat_id === 456).payload.text, '该 Bot 已停止服务');
});

test('Telegram 内容页提供群频道成员权限与私聊服务管理入口', () => {
    const page = source('pages/telegram-content.html');
    const client = source('client/telegram-content.js');
    const manager = source('server/telegram-content-manager.js');
    assert.match(page, /id="telegramManageChat"/);
    assert.match(page, /id="telegramChatManagement"/);
    for (const label of ['不再接受新用户进群\/进频道', '限制用户权限', '移除用户', '保存管理员权限', '移除管理员', '停止服务该用户']) {
        assert.match(client, new RegExp(label));
    }
    assert.match(manager, /getChatMember/);
    assert.match(manager, /restrictChatMember/);
    assert.match(manager, /promoteChatMember/);
    assert.match(manager, /unbanChatMember/);
});
