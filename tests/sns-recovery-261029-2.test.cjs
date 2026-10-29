'use strict';
const assert = require('node:assert/strict'), test = require('node:test');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), crypto = require('node:crypto');
const server = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
const app = fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8');
const block = (source, from, to) => source.slice(source.indexOf(from), source.indexOf(to, source.indexOf(from)));
const tick = () => new Promise(resolve => setImmediate(resolve));

function badge(message) {
    const classes = new Map(), header = { appendChild(node) { this.badge = node; } };
    const row = { querySelector: selector => selector === '.message-header' ? header : null,
        classList: { toggle: (name, enabled) => classes.set(name, enabled) } };
    const context = vm.createContext({ document: { createElement: () => ({}) }, window: { TunnelI18n: { t: value => value } } });
    vm.runInContext(block(app, 'function syncTransferRecordSnsBadge(', '\nasync function isFileFavorite('), context);
    context.syncTransferRecordSnsBadge(row, message);
    return { enabled: classes.get('message-record-sns'), title: header.badge?.title };
}

test('SNS解析超时或尚在识别时保留SNS入口，不冒充媒体已经可获取', () => {
    for (const parseStatus of ['failed', 'pending']) {
        const result = badge({ snsSources: [{ id: 'source', sourceUrl: 'https://x.com/u/status/1', sourceType: 'single', parseStatus }], snsMediaItems: [] });
        assert.equal(result.enabled, true, parseStatus);
        assert.doesNotMatch(result.title, /可获取/, parseStatus);
    }
    assert.equal(badge({ snsSources:[{id:'source',sourceType:'unsupported'}],snsMediaItems:[] }).enabled,false);
    assert.equal(badge({ snsSources:[{id:'source',sourceType:'single'}],snsAcquisition:{} }).enabled,false);
    assert.equal(badge({ snsMediaItems:[{id:'media',mediaKind:'video'}] }).enabled,true);
});

function recovery(inspect = async () => ({ title: '原帖', formats: [{ vcodec: 'h264', acodec: 'aac' }] })) {
    let now = 1000000;
    const timers = [], calls = [], updates = [], sessions = new Map([['tunnel', { history: [] }]]);
    class Clock extends Date { static now() { return now; } }
    const context = vm.createContext({ Date: Clock, Math, Set, Map, sessions, snsMetadataScans: new Set(), console,
        setTimeout: fn => timers.push(fn),
        extractSupportedSocialUrls: text => [...String(text).matchAll(/https?:\/\/[^\s]+/g)].map(match => match[0]),
        createStableSnsId: (...parts) => crypto.createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 32),
        sanitizeString: value => String(value || ''), isYouTubePlaylistOnly: url => url.includes('youtube.com/playlist'), isYouTubeUrl: () => false,
        getHistoryMessageEntry: (session, id) => session?.history.find(entry => entry.message.id === id),
        getMessageSnsText: message => message.text || '',
        runYtDlpJson: async url => { calls.push(url); return inspect(url); },
        buildSnsMediaItemFromMeta: (messageId, source) => ({ id:'media-'+source.id,sourceId:source.id,messageId,mediaKind:'video',serverState:'not_fetched' }),
        replaceHistoryMessage: (_sid, _session, message, reason) => updates.push({ id:message.id,reason }) });
    vm.runInContext(block(server, 'function canResumeSnsSource(', '\n// Compatibility aliases'), context);
    const add = (id = 'post', urls = ['https://x.com/u/status/1']) => {
        const message = { id, text: urls.join('\n'), snsMediaItems: [] };
        message.snsSources = context.createSnsPlaceholderMetadata(message.text, message.id).sources;
        for(const source of message.snsSources){source.parseStatus='failed';source.parseError='yt-dlp-timeout-90000ms';}
        sessions.get('tunnel').history.push({ message }); return message;
    };
    return { context, sessions, timers, calls, updates, add, advance: ms => now += ms,
        resume: () => context.resumePendingSnsMetadataScans('tunnel', sessions.get('tunnel').history.map(entry => entry.message)),
        async run() { while(timers.length) await timers.shift()(); await tick(); } };
}

test('历史timeout可恢复，同批历史重复到达不重复解析，成功后不再轮询解析', async () => {
    const f = recovery(), message = f.add();
    message.snsSources[0].parseRetryCount=2;message.snsSources[0].parseRetryAfter=999999;
    for(let i=0;i<100;i++)f.resume();
    assert.equal(f.timers.length,1,'临时超时被永久跳过或重复发起'); await f.run();
    assert.equal(f.calls.length,1); assert.equal(message.snsSources[0].parseStatus,'ready');
    assert.equal(message.snsSources[0].parseRetryCount,undefined);assert.equal(message.snsSources[0].parseRetryAfter,undefined);
    for(let i=0;i<100;i++)f.resume(); assert.equal(f.timers.length,0);
});

test('连续暂时失败按持久化时间退避，历史轮询和重载不会形成重试风暴', async () => {
    const f = recovery(async()=>{throw Error('yt-dlp-timeout-90000ms');}), message = f.add();
    f.resume(); await f.run(); assert.equal(f.calls.length,1);
    const first = message.snsSources[0].parseRetryAfter;
    assert.ok(first > 1000000, '失败后必须记录下次允许恢复时间');
    for(let i=0;i<100;i++)f.resume(); assert.equal(f.timers.length,0);
    f.advance(first-1000000+1); f.resume(); await f.run(); assert.equal(f.calls.length,2);
    assert.ok(message.snsSources[0].parseRetryAfter-first > first-1000000, '连续失败应延长重试间隔');
    const restarted=recovery(async()=>{throw Error('unexpected retry');});
    restarted.sessions.get('tunnel').history.push({message:JSON.parse(JSON.stringify(message))});
    restarted.resume(); assert.equal(restarted.timers.length,0,'持久化退避不能因服务端重启失效');
    f.advance(600000);f.resume();await f.run();assert.equal(f.calls.length,3);
    assert.equal(message.snsSources[0].parseRetryCount,3);
    f.advance(3600000);for(let i=0;i<100;i++)f.resume();assert.equal(f.timers.length,0,'自动恢复次数耗尽后不得无限重试');
});

test('自动历史恢复最多排入两个解析，不重试unsupported、删除或永久错误', async () => {
    const f = recovery();
    for(let i=0;i<10;i++)f.add('post-'+i,['https://x.com/u/status/'+i]);
    for(let i=0;i<50;i++)f.resume(); assert.equal(f.timers.length,2);
    const permanent=recovery();
    permanent.add('unsupported',['https://youtube.com/playlist?list=fixture']).snsSources[0].sourceType='unsupported';
    permanent.add('removed').snsSources[0].parseError='This tweet does not exist';
    permanent.add('result').snsAcquisition={source:'sns-post-markdown'};
    permanent.resume();assert.equal(permanent.timers.length,0);
});

test('只恢复失败来源，保留同一记录内其它来源和已完成媒体身份', async () => {
    const f=recovery(),message=f.add('multiple',['https://x.com/u/status/1','https://x.com/u/status/2']);
    const ready=message.snsSources[0];ready.parseStatus='ready';ready.parseError='';
    const completed={id:'media-'+ready.id,sourceId:ready.id,mediaKind:'video',serverState:'ready',serverAssetId:'asset',generatedMessageId:'generated'};
    message.snsMediaItems.push(completed);
    f.resume();await f.run();
    assert.deepEqual(f.calls,['https://x.com/u/status/2']);
    assert.equal(message.snsMediaItems.find(item=>item.id===completed.id).serverAssetId,'asset');
    assert.equal(message.snsSources[0].parseStatus,'ready');
});

test('解析等待期间手动获取完成的媒体不被迟到元数据重置', async () => {
    let release;
    const f=recovery(()=>new Promise(resolve=>release=resolve)),message=f.add();
    f.resume();const pending=f.timers.shift()();await tick();
    const completed={id:'media-'+message.snsSources[0].id,sourceId:message.snsSources[0].id,serverState:'ready',serverAssetId:'manual-asset',generatedMessageId:'manual-record'};
    message.snsMediaItems.push(completed);release({title:'原帖'});await pending;
    const result=message.snsMediaItems.find(item=>item.id===completed.id);
    assert.equal(result.serverAssetId,'manual-asset');assert.equal(result.generatedMessageId,'manual-record');
});

test('原记录删除或内容已变更后，迟到的解析结果不能重新写入历史', async () => {
    for(const change of ['deleted','edited']){
        let release;const f=recovery(()=>new Promise(resolve=>release=resolve)),message=f.add();
        f.resume();const pending=f.timers.shift()();await tick();
        if(change==='deleted')f.sessions.get('tunnel').history=[];else message.text='https://x.com/u/status/changed';
        release({title:'迟到结果'});await pending;
        assert.equal(f.updates.length,0,change);
    }
});
