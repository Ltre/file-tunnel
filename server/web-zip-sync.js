'use strict';
// Webpage publication and its deferred update of the referenced source record.
// Storage, tunnel membership/visibility and record delivery are injected here;
// this module never joins a tunnel or implements a file transport.
const {readJson,writeJsonAsync}=require('./disk-data');
const clone=value=>JSON.parse(JSON.stringify(value));
const files=message=>message?.type==='file'?[message.fileInfo].filter(Boolean):message?.type==='collection'?message.collection?.files||[]:[];
const webpage=file=>Boolean(file?.creatorDeviceId&&(file.webZip||/\.html\.zip$/i.test(file.name||'')));
const canEdit=(file,deviceId)=>file?.creatorDeviceId===deviceId||Array.isArray(file?.webZipEditors)&&file.webZipEditors.includes(deviceId);
const revision=file=>Number(file?.webZipRevision)||0;
const equivalent=(a,b)=>a&&b&&a.creatorDeviceId===b.creatorDeviceId&&a.name===b.name&&a.type===b.type&&a.size===b.size&&revision(a)===revision(b)&&(!a.webZipDraftId||!b.webZipDraftId||a.webZipDraftId===b.webZipDraftId);
const version=file=>({id:file.id,revision:revision(file)});
const failure=code=>{throw Error(code);};
function replaceFile(message,id,file){const next=clone(message);if(next.type==='file')next.fileInfo=file;else next.collection.files=next.collection.files.map(value=>value.id===id?file:value);return next;}
function createWebZipSync({filename,readRecord,writeRecord,canPublish,hasContent,canSync,isForwardedCopy=()=>false,log=()=>{}}){
    let unavailable=false,saving=Promise.resolve(),scheduled=false,changed=false;
    const jobs=new Map(),running=new Map();
    try{const saved=readJson(filename,{version:1,jobs:[]});if(saved.version!==1||!Array.isArray(saved.jobs))throw Error('invalid journal');for(const job of saved.jobs){if(!job?.key||!job.file?.id||!job.sessionId||!job.messageId)throw Error('invalid job');jobs.set(job.key,job);}}
    catch(error){unavailable=true;log('web-zip-sync-storage-unreadable',error);}
    const persist=()=>{const snapshot={version:1,jobs:[...jobs.values()].map(clone)};saving=saving.catch(()=>{}).then(()=>writeJsonAsync(filename,snapshot));return saving;};
    const key=(sessionId,messageId,file)=>JSON.stringify([sessionId,messageId,file.webZipRootId||file.id]);
    function sourceOf(sessionId,message,file){
        const origin=message?.forwardedFrom;if(!origin?.sessionId||!origin.messageId||origin.sessionId===sessionId)return null;
        if(!isForwardedCopy(sessionId,message.id,file,origin))return null;
        const original=readRecord(origin.sessionId,origin.messageId);if(!original)return{...origin,message:null,file:null};
        const candidates=files(original).filter(value=>webpage(value)&&value.creatorDeviceId===file.creatorDeviceId);
        let matches=candidates.filter(value=>value.id===file.webZipSourceVersion?.id||file.webZipRootId&&(value.id===file.webZipRootId||value.webZipRootId===file.webZipRootId));
        if(!matches.length)matches=candidates.filter(value=>equivalent(value,file));
        return{...origin,message:original,file:matches.length===1?matches[0]:null};
    }
    function ownedCopy(file,input,deviceId){
        const next={...file};
        for(const field of ['id','name','size','type','timestamp','data','cacheStoreRef','cacheStorage','serverAssetUrl','isServerAsset','telegramFileId','telegramFileUniqueId','telegramChatId','telegramFileIdUpdatedAt','backupSourceSessionId','forwardedToSessionId','forwardedSourceGrant','sourceFileId','webZipPendingSync','webZipSourceVersion','isExternalFile','externalFileHandle','externalFileMissing','isPartial','transferInterrupted','cacheCleared','restoreRequested'])delete next[field];
        return{...clone(next),id:input.id,name:input.name,type:input.type,size:input.size,timestamp:Date.now(),ownerDeviceId:deviceId,sender:deviceId,isAsset:true,webZip:true,
            webZipHideFrame:input.webZipHideFrame===true,webZipFullscreen:input.webZipFullscreen===true,webZipRevision:revision(file)+1,replacesFileId:file.id,webZipUpdatedAt:Date.now()};
    }
    async function mark(job,error){
        if(jobs.get(job.key)!==job)return;
        const message=readRecord(job.sessionId,job.messageId),file=files(message).find(value=>value.id===job.file.id);
        if(!file||file.webZipPendingSync?.lastError===error)return;
        const next={...file,webZipPendingSync:{...file.webZipPendingSync,lastError:error}};
        await writeRecord(job.sessionId,message,replaceFile(message,file.id,next),{check:()=>jobs.get(job.key)===job});
    }
    async function finish(job){
        const message=readRecord(job.sessionId,job.messageId),file=files(message).find(value=>value.id===job.file.id);
        if(jobs.get(job.key)!==job)return;
        if(file?.webZipPendingSync){const next={...file,webZipSourceVersion:version(job.file)};delete next.webZipPendingSync;
            await writeRecord(job.sessionId,message,replaceFile(message,file.id,next),{check:()=>jobs.get(job.key)===job});}
        if(jobs.get(job.key)===job){jobs.delete(job.key);try{await persist();}catch(error){if(!jobs.has(job.key))jobs.set(job.key,job);throw error;}topologyChanged();}
    }
    async function sync(job){
        if(jobs.get(job.key)!==job)return;
        const message=readRecord(job.sessionId,job.messageId),file=files(message).find(value=>value.id===job.file.id);
        if(!file){jobs.delete(job.key);await persist();return;}
        if(!canSync(job.deviceId,job.origin.sessionId))return;
        if(!canEdit(file,job.deviceId)||!canPublish(job.sessionId,job.deviceId))return mark(job,'WEB_ZIP_EDIT_DENIED');
        const original=readRecord(job.origin.sessionId,job.origin.messageId);
        if(!original)return mark(job,'WEB_ZIP_SOURCE_MISSING');
        const candidates=files(original).filter(value=>webpage(value)&&value.creatorDeviceId===job.file.creatorDeviceId);
        const current=candidates.find(value=>value.id===job.file.id)||candidates.find(value=>value.id===job.base?.id)||candidates.find(value=>value.webZipRootId===job.file.webZipRootId||value.id===job.file.webZipRootId)||candidates.find(value=>equivalent(value,job.previous));
        if(!current)return mark(job,'WEB_ZIP_SOURCE_CHANGED');
        if(!canEdit(current,job.deviceId))return mark(job,'WEB_ZIP_SOURCE_EDIT_DENIED');
        if(current.webZipPendingSync)return mark(job,'WEB_ZIP_SOURCE_BUSY');
        if(current.id!==job.file.id){
            const expected=job.base|| (equivalent(current,job.previous)?version(current):null);
            if(!expected||!(current.id===expected.id&&revision(current)===expected.revision||current.id===job.previous.id&&revision(current)===revision(job.previous)))return mark(job,'WEB_ZIP_SOURCE_CHANGED');
            const next={...ownedCopy(current,job.file,current.ownerDeviceId||original.sender),webZipRootId:job.file.webZipRootId,
                webZipRevision:revision(job.file),backupSourceSessionId:job.sessionId,forwardedToSessionId:job.origin.sessionId};
            await writeRecord(job.origin.sessionId,original,replaceFile(original,current.id,next),{
                source:'cross-tunnel-forward',copyFromSessionId:job.sessionId,
                check:()=>jobs.get(job.key)===job&&canSync(job.deviceId,job.origin.sessionId)&&canPublish(job.sessionId,job.deviceId)&&canEdit(files(readRecord(job.sessionId,job.messageId)).find(value=>value.id===job.file.id),job.deviceId)
            });
        }
        await finish(job);
    }
    function attempt(job){
        const active=running.get(job.key);
        if(active)return active.job===job?active.task:active.task.then(()=>attempt(job));
        const task=sync(job).catch(error=>log('web-zip-sync-pending',{key:job.key,error:error.message})).finally(()=>{if(running.get(job.key)?.job===job)running.delete(job.key);});
        running.set(job.key,{job,task});return task;
    }
    function topologyChanged(){
        changed=true;if(unavailable||scheduled||!jobs.size)return;scheduled=true;
        setImmediate(async()=>{changed=false;let count=0;try{for(const job of [...jobs.values()]){await attempt(job);if(++count%16===0)await new Promise(resolve=>setImmediate(resolve));}}finally{scheduled=false;if(changed)topologyChanged();}});
    }
    function recordChanged(sessionId,messageId){
        let removed=false;
        const ids=new Set(files(readRecord(sessionId,messageId)).map(file=>file.id));
        for(const [jobKey,job]of jobs)if(job.sessionId===sessionId&&job.messageId===messageId&&!ids.has(job.file.id)){jobs.delete(jobKey);removed=true;}
        if(removed)persist().catch(error=>log('web-zip-sync-cleanup-failed',error));
    }
    async function publish({sessionId,messageId,fileId,fileInfo,deviceId}){
        const message=readRecord(sessionId,messageId),current=files(message).find(value=>value.id===fileId);
        const retried=files(message).find(value=>value.id===fileInfo?.id&&value.replacesFileId===fileId&&value.ownerDeviceId===deviceId);
        if(retried&&canEdit(retried,deviceId)&&canPublish(sessionId,deviceId)){const job=[...jobs.values()].find(value=>value.file.id===retried.id&&value.sessionId===sessionId&&value.messageId===messageId);if(job)await attempt(job);return readRecord(sessionId,messageId);}
        if(!webpage(current)||!canEdit(current,deviceId)||!canPublish(sessionId,deviceId))failure('WEB_ZIP_EDIT_DENIED');
        if(!fileInfo?.id||fileInfo.id===fileId||!String(fileInfo.name||'').toLowerCase().endsWith('.html.zip')||!Number.isSafeInteger(fileInfo.size)||fileInfo.size<0||!hasContent(sessionId,deviceId,fileInfo))failure('WEB_ZIP_CONTENT_NOT_READY');
        const origin=sourceOf(sessionId,message,current),next=ownedCopy(current,fileInfo,deviceId);
        if(origin&&unavailable)failure('WEB_ZIP_SYNC_STORAGE');
        next.webZipRootId=origin?.file?.webZipRootId||origin?.file?.id||current.webZipRootId||current.id;
        let job,previousJob;
        if(origin){
            const jobKey=key(sessionId,messageId,{...current,webZipRootId:next.webZipRootId});
            previousJob=jobs.get(jobKey);
            job={key:jobKey,sessionId,messageId,deviceId,origin:{sessionId:origin.sessionId,messageId:origin.messageId},file:next,
                previous:{id:current.id,name:current.name,type:current.type,size:current.size,creatorDeviceId:current.creatorDeviceId,webZipDraftId:current.webZipDraftId,webZipRevision:revision(current)},
                base:previousJob?.base||current.webZipSourceVersion||(equivalent(current,origin.file)?version(origin.file):null)};
            next.webZipPendingSync={state:'pending',sessionId:origin.sessionId,messageId:origin.messageId};jobs.set(jobKey,job);
            try{await persist();}catch(error){if(previousJob)jobs.set(jobKey,previousJob);else jobs.delete(jobKey);throw error;}
        }
        try{await writeRecord(sessionId,message,replaceFile(message,fileId,next),{check:()=>canPublish(sessionId,deviceId)&&canEdit(files(readRecord(sessionId,messageId)).find(value=>value.id===fileId),deviceId)});}
        catch(error){if(job&&jobs.get(job.key)===job){if(previousJob)jobs.set(job.key,previousJob);else jobs.delete(job.key);await persist();}throw error;}
        if(job)await attempt(job);
        return readRecord(sessionId,messageId);
    }
    function needsApproval(sessionId,messageId,fileId,deviceId){
        const message=readRecord(sessionId,messageId),file=files(message).find(value=>value.id===fileId);
        if(!file)return true;
        const origin=sourceOf(sessionId,message,file);
        return !canEdit(file,deviceId)||Boolean(origin?.file&&!canEdit(origin.file,deviceId));
    }
    async function approve({sessionId,messageId,fileId,rootId=fileId,creatorDeviceId,deviceId}){
        const message=readRecord(sessionId,messageId),file=files(message).find(value=>value.id===fileId||value.webZipRootId===rootId||value.replacesFileId===fileId)|| (message?.type==='file'?message.fileInfo:null);
        if(!webpage(file)||file.creatorDeviceId!==creatorDeviceId)failure('not-web-zip-creator');
        const origin=sourceOf(sessionId,message,file);
        for(const target of [...(origin?.file?[{sessionId:origin.sessionId,message:origin.message,file:origin.file}]:[]),{sessionId,message,file}]){
            if(target.file.creatorDeviceId!==creatorDeviceId)failure('not-web-zip-creator');
            const updated={...target.file,webZipEditors:[...new Set([...(target.file.webZipEditors||[]),deviceId])],webZipPermissionUpdatedAt:Date.now()};
            await writeRecord(target.sessionId,target.message,replaceFile(target.message,target.file.id,updated),{source:'web-zip-editor-approved'});
        }
        topologyChanged();return readRecord(sessionId,messageId);
    }
    return{publish,approve,needsApproval,topologyChanged,recordChanged};
}
module.exports={createWebZipSync};
