'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../app.js'),'utf8');
const block=(from,to)=>source.slice(source.indexOf(from),source.indexOf(to,source.indexOf(from)));
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(){
    const reads=[],content={children:[],replaceChildren(){this.children=[];},appendChild(node){this.children.push(node);}},title={};
    const active=new Set(['active']),viewer={classList:{contains:key=>active.has(key),remove:key=>active.delete(key)}};
    const context=vm.createContext({state:{sessionId:'B'},filePreviewLoadVersion:0,activeFilePreviewMode:'',activeCollectionPreviewMessageId:'',activeFilePreviewFileId:'',activeFilePreviewMessageId:'',activeFilePreviewOwnerDeviceId:'',activeFilePreviewObjectUrl:'',
        activeFilePreviewCanFullscreen:false,activeFilePreviewMediaType:'',activeFilePreviewStoredFile:null,filePreviewReturnCollectionMessageId:'',mediaFullscreenHistoryOpen:false,
        filePreviewHistoryOpen:false,filePreviewNestedHistoryOpen:false,collectionPreviewReturnState:null,filePreviewPointerStart:null,musicPlayer:{previewControls:null},
        document:{getElementById:id=>id==='filePreviewContent'?content:id==='filePreviewTitle'?title:id==='filePreviewViewer'?viewer:null,createElement:tag=>({tagName:tag.toUpperCase(),dataset:{},play:async()=>{},appendChild(){},classList:{add(){}}})},
        setFilePreviewContentStage:()=>content,setFilePreviewTitle:name=>title.textContent=name,renderFilePreviewLoading:node=>node.replaceChildren(),
        setFilePreviewFullscreenButton(){},setFilePreviewLightShareButton(){},setFilePreviewMusicButton(){},setFilePreviewRemoteButton(){},openFilePreviewHistory(){},
        getFromStore:(_store,id)=>new Promise(resolve=>reads.push({id,resolve})),materializeCachedFileRecord:async file=>file,
        getExternalFileSourceState:()=>({}),syncExternalFileSourceUi:async()=>({}),hasCompleteFileCache:()=>true,
        isPreviewableFileType:()=>true,isVisualPreviewableType:()=>true,isFullscreenPreviewableType:()=>true,getStoredFileUrl:id=>'blob:'+id,
        getCachedMediaPosterOrQueue:()=>'',fitPreviewMediaElement(){},renderSingleFilePreviewActions:async()=>{},updateFilePreviewNavigationControls:async()=>{},historyLog(){},
        stopTemporaryAudioPreview(){},resetFilePreviewContentStage(){},releaseUnusedFileObjectUrls(){},scheduleFileObjectUrlCleanup(){},history:{state:{},back(){}},FILE_PREVIEW_HISTORY_KEY:'preview',
        getCollectionFiles:message=>message?.collection?.files||[],createCollectionFileCard:async file=>({dataset:{previewFileId:file.id}}),
        setCollectionPreviewActions(){},requestAnimationFrame(){}});
    vm.runInContext(block('async function openFilePreviewForInfo(','\nasync function openFileRecord(')+'\n'+block('function closeFilePreview(','\nfunction replaceCurrentHistoryWithoutPreviewLayers(')+'\n'+block('async function openCollectionRecord(','\nfunction setCollectionPreviewActions('),context);
    const info=id=>({id,name:id+'.mp4',type:'video/mp4',size:4});
    return {context,reads,content,open:id=>context.openFilePreviewForInfo(info(id)),resolve(index){reads[index].resolve({...info(reads[index].id),data:'data'});}};
}
test('B慢读取不能覆盖后来打开的A预览，同一fileId重开也按请求世代隔离',async()=>{
    for(const id of ['A','B']){
        const f=fixture(),old=f.open('B'),latest=f.open(id);f.resolve(1);await latest;f.resolve(0);await old;
        assert.equal(f.content.children.length,1);assert.equal(f.content.children[0].dataset.previewFileId,id);
        assert.equal(await old,false,'旧读取应停止而不是继续渲染');
    }
});
test('关闭预览或切换隧道后，迟到缓存读取不能重新画出视频或恢复按钮',async()=>{
    for(const change of ['closed','tunnel']){
        const f=fixture(),opening=f.open('B');await tick();
        if(change==='closed')f.context.closeFilePreview({forceClose:true});else f.context.state.sessionId='A';
        f.resolve(0);assert.equal(await opening,false,change);assert.equal(f.content.children.length,0,change);
    }
});
test('转入合辑后，旧文件预览的迟到读取不能覆盖合辑',async()=>{
    const f=fixture(),old=f.open('B'),collection=f.context.openCollectionRecord('collection');
    f.reads[1].resolve({id:'collection',collection:{files:[{id:'picture'}]}});await collection;
    const grid=f.content.children[0];f.resolve(0);assert.equal(await old,false);
    assert.equal(f.content.children[0],grid);assert.equal(f.context.activeFilePreviewMode,'collection');
});
