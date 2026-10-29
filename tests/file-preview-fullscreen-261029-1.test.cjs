'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const test = require('node:test');
const source = fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8');
const block = (from, to) => source.slice(source.indexOf(from), source.indexOf(to, source.indexOf(from)));
const tick = () => new Promise(resolve => setImmediate(resolve));

function fullscreen() {
    let release, scanCalls = 0, renders = 0;
    const classes = new Set(), scheduled = [], history = { state: {}, pushState(value) { this.state = value; } };
    const context = vm.createContext({ activeFilePreviewCanFullscreen: true, activeFilePreviewFileId: 'current',
        activeFilePreviewStoredFile: { id:'current', name:'当前.mp4', type:'video/mp4', data:new Blob(['current']) },
        activeFilePreviewMediaType: 'video/mp4', activeFilePreviewMessageId:'record-current', activeFilePreviewObjectUrl:'blob:current',
        mediaFullscreenItems:[], mediaFullscreenIndex:0, mediaFullscreenHistoryOpen:false, mediaFullscreenLoadVersion:0,
        MEDIA_FULLSCREEN_HISTORY_KEY:'fullscreen', state:{ sessionId:'tunnel-A' }, history, window:{ location:{ href:'http://test/' } },
        document:{ getElementById:() => ({ classList:{ add:value=>classes.add(value), contains:value=>classes.has(value) } }) },
        requestAnimationFrame:fn=>scheduled.push(fn), setTimeout:fn=>scheduled.push(fn),
        hasCompleteFileCache:stored=>!!stored?.data, isFullscreenPreviewableType:type=>/^(video|image|audio)\//.test(type),
        getStoredFileUrl:id=>'blob:'+id, renderMediaFullscreenItem:()=>renders++, updateMediaFullscreenNavigationControls(){}, historyLog(){}, alert(){},
        getFullscreenPreviewItems:()=>{ scanCalls++; return new Promise(resolve=>{ release=resolve; }); }
    });
    vm.runInContext(block('async function openActivePreviewFullscreen(', '\nfunction closeMediaFullscreen('), context);
    return { context, classes, scheduled, release:items=>release(items), scanCalls:()=>scanCalls, renders:()=>renders,
        open:options=>context.openActivePreviewFullscreen(options), async scan(){ while(scheduled.length)scheduled.shift()(); await tick(); } };
}

test('当前文件先显示全屏，不等待其它文件缓存读取，并在后台补齐前后项', async () => {
    const f = fullscreen();
    const opening = f.open();
    await tick();
    assert.equal(f.classes.has('active'), true, '当前媒体被无关文件的待定读取阻塞');
    assert.equal(await opening, true);
    assert.equal(f.context.mediaFullscreenItems[0].fileInfo.id, 'current');
    assert.equal(f.scanCalls(), 0, '导航扫描不得抢在首帧显示之前');
    await f.scan();
    assert.equal(f.scanCalls(), 1);
    const item = id => ({ fileInfo:{ id }, type:'video/mp4', storedFile:{ data:new Blob([id]) }, url:'blob:'+id });
    f.release([item('previous'), item('current'), item('next')]); await tick();
    assert.equal(f.context.mediaFullscreenIndex, 1);
    assert.equal(f.context.mediaFullscreenItems.length, 3);
    assert.equal(f.renders(), 1, '补齐导航不能重新加载正在播放的媒体');
});

test('切换隧道或关闭后，迟到的导航清单不能覆盖新界面', async () => {
    for (const changed of ['session', 'closed', 'reopened']) {
        const f = fullscreen(); await f.open(); await f.scan();
        if(changed === 'session') f.context.state.sessionId = 'tunnel-B';
        if(changed === 'closed') f.classes.delete('active');
        if(changed === 'reopened') f.context.mediaFullscreenLoadVersion++;
        f.release([{fileInfo:{id:'other'}},{fileInfo:{id:'current'}}]); await tick();
        assert.equal(f.context.mediaFullscreenItems.length, 1, changed);
    }
});

test('远程定向全屏只使用当前媒体，不枚举其它隧道记录', async () => {
    const f = fullscreen(); await f.open({focusedOnly:true, focusedFileInfo:{name:'远程.mp4'}}); await f.scan();
    assert.equal(f.scanCalls(), 0); assert.equal(f.context.mediaFullscreenItems[0].fileInfo.name,'远程.mp4');
});

test('后台导航仍按记录顺序筛选完整缓存，跳过非媒体且不提前建立其它 Blob URL', async () => {
    const reads=[],permissions=[],urls=[];
    const current={fileInfo:{id:'current',type:'video/mp4'},storedFile:{data:'current'},type:'video/mp4',url:'blob:current',messageId:'current-record'};
    const messages=[
        {id:'collection',timestamp:3,type:'collection',files:[{id:'missing',type:'image/png'},{id:'external',type:'video/mp4'}]},
        {id:'current-record',timestamp:2,type:'file',fileInfo:current.fileInfo},
        {id:'text',timestamp:0,type:'file',fileInfo:{id:'text',type:'text/plain'}},
        {id:'image-record',timestamp:1,type:'file',fileInfo:{id:'image',type:'image/png'}}
    ];
    const context=vm.createContext({getCurrentSessionMessages:async()=>messages,compareHistoryMessages:(a,b)=>a.timestamp-b.timestamp,
        getCollectionFiles:message=>message.files||[],getFromStore:async(_store,id)=>{reads.push(id);return id==='missing'?null:id==='external'?{externalFileHandle:{}}:{data:id};},
        materializeExternalFileRecord:async(_file,options)=>{permissions.push(options.requestPermission);return null;},
        hasCompleteFileCache:stored=>Boolean(stored?.data),isFullscreenPreviewableType:type=>/^(image|video|audio)\//.test(type),
        getStoredFileUrl:id=>urls.push(id),activeCollectionPreviewMessageId:'',activeFilePreviewFileId:''});
    vm.runInContext(block('async function getFullscreenPreviewItems(', '\nfunction getActivePreviewMediaElement('),context);
    const items=await context.getFullscreenPreviewItems({currentItem:current});
    assert.deepEqual(Array.from(items,item=>item.fileInfo.id),['image','current']);
    assert.deepEqual(reads,['image','missing','external']);assert.deepEqual(permissions,[false]);assert.deepEqual(urls,[]);
});

test('后台扫描遇到关闭或隧道切换，完成当前读取后停止，不再扫描后续缓存', async () => {
    let live=true,release;const reads=[];
    const context=vm.createContext({getCurrentSessionMessages:async()=>[1,2,3].map(id=>({id:String(id),type:'file',fileInfo:{id:String(id),type:'video/mp4'}})),
        compareHistoryMessages:()=>0,getFromStore:(_store,id)=>{reads.push(id);return new Promise(resolve=>release=resolve);},
        hasCompleteFileCache:()=>true,isFullscreenPreviewableType:()=>true,activeCollectionPreviewMessageId:'',activeFilePreviewFileId:''});
    vm.runInContext(block('async function getFullscreenPreviewItems(', '\nfunction getActivePreviewMediaElement('),context);
    const loading=context.getFullscreenPreviewItems({isCurrent:()=>live});await tick();live=false;release({data:'cached'});
    assert.equal((await loading).length,0);assert.deepEqual(reads,['1']);
});

function gestures() {
    const listeners = new Map(), calls = [];
    const viewer = { classList:{ contains:()=>true }, addEventListener(name, fn){ listeners.set(name, fn); }, setPointerCapture(){} };
    const context = vm.createContext({ document:{getElementById:()=>viewer}, filePreviewPointerStart:null,
        activeFilePreviewCanFullscreen:true, shouldIgnorePreviewGestureTarget:target=>target?.button === true,
        isPreviewMediaTarget:target=>target?.media === true, openActivePreviewFullscreen:async()=>calls.push('fullscreen'),
        navigateFilePreview:async delta=>calls.push(delta), closeFilePreview:()=>calls.push('close'), historyLog(){}, Date
    });
    vm.runInContext(block("    document.getElementById('filePreviewViewer')?.addEventListener('pointerdown'", "    document.getElementById('mediaFullscreenCloseBtn')"), context);
    return { context, calls, send(name, extra={}){listeners.get(name)?.({pointerType:'touch',pointerId:1,isPrimary:true,clientX:100,clientY:200,target:{media:true},currentTarget:viewer,preventDefault(){},...extra});} };
}

test('视频上划达到明确方向和距离时即可进入全屏，不依赖最后抬手回执', async () => {
    const f=gestures(); f.send('pointerdown'); f.send('pointermove',{clientY:160}); await tick();
    assert.deepEqual(f.calls,['fullscreen']); f.send('pointerup',{clientY:140}); await tick();
    assert.deepEqual(f.calls,['fullscreen'], '同一手势不能重复打开');
});

test('取消、多指及不同指针的结束事件不得串用旧手势', async () => {
    const canceled=gestures(); canceled.send('pointerdown'); canceled.send('pointercancel'); canceled.send('pointerup',{clientY:100}); await tick();
    assert.deepEqual(canceled.calls,[]);
    const other=gestures(); other.send('pointerdown'); other.send('pointerup',{pointerId:2,clientY:100}); await tick();
    assert.deepEqual(other.calls,[]);
    const multi=gestures(); multi.send('pointerdown'); multi.send('pointerdown',{pointerId:2,isPrimary:false}); multi.send('pointerup',{clientY:100}); await tick();
    assert.deepEqual(multi.calls,[]);
});

test('短触摸和控件触摸保持原行为，左右及下划仍可导航和关闭', async () => {
    const f=gestures(); f.send('pointerdown'); f.send('pointermove',{clientY:190}); f.send('pointerup',{clientY:190});
    f.send('pointerdown',{target:{button:true}}); f.send('pointermove',{clientY:100}); f.send('pointerup',{clientY:100});
    assert.deepEqual(f.calls,[]);
    f.send('pointerdown'); f.send('pointerup',{clientX:40,clientY:195});
    f.send('pointerdown'); f.send('pointerup',{clientY:260}); await tick();
    assert.deepEqual(f.calls,[1,'close']);
});
