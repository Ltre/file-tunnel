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
const failure=(code,reason='',requiresApproval=false)=>{throw Object.assign(Error(code),{reason,requiresApproval});};
function replaceFile(message,id,file){const next=clone(message);if(next.type==='file')next.fileInfo=file;else next.collection.files=next.collection.files.map(value=>value.id===id?file:value);return next;}
function createWebZipSync({filename,readRecord,listRecords=()=>[],writeRecord,canPublish,hasContent,canSync,credentials,resign,isForwardedCopy=()=>false,log=()=>{}}){
    let unavailable=false,saving=Promise.resolve(),scheduled=false,changed=false;
    const jobs=new Map(),running=new Map(),publishing=new Set(),publications=new Map();
    try{const saved=readJson(filename,{version:1,jobs:[]});if(saved.version!==1||!Array.isArray(saved.jobs))throw Error('invalid journal');for(const job of saved.jobs){if(!job?.key||!job.file?.id||!job.sessionId||!job.messageId)throw Error('invalid job');jobs.set(job.key,job);}}
    catch(error){unavailable=true;log('web-zip-sync-storage-unreadable',error);}
    const persist=()=>{const snapshot={version:1,jobs:[...jobs.values()].map(clone)};saving=saving.catch(()=>{}).then(()=>writeJsonAsync(filename,snapshot));return saving;};
    const key=(sessionId,messageId,file,origin)=>JSON.stringify(origin?[sessionId,origin.sessionId,origin.messageId,file.creatorDeviceId,file.webZipRootId||file.id]:[sessionId,messageId,file.webZipRootId||file.id]);
    const sourceScope=(sessionId,message,file,origin)=>({sessionId,messageId:message.id,creatorDeviceId:file.creatorDeviceId,rootId:file.webZipRootId||file.id,sourceSessionId:origin.sessionId,sourceMessageId:origin.messageId});
    const lostSource=(sessionId,message,file,origin)=>!origin&&message?.forwardedFrom?.sessionId&&message.forwardedFrom.sessionId!==sessionId&&file.webZipRootId&&file.webZipSourceVersion;
    function sourceOf(sessionId,message,file,editCredential='',deviceId=''){
        const origin=message?.forwardedFrom;if(!origin?.sessionId||!origin.messageId||origin.sessionId===sessionId)return null;
        const proven=credentials?.verifySource?.(file.webZipSourceProof,sourceScope(sessionId,message,file,origin));
        const pending=[...jobs.values()].some(job=>job.sessionId===sessionId&&job.messageId===message.id&&job.file.id===file.id&&job.file.creatorDeviceId===file.creatorDeviceId&&job.origin.sessionId===origin.sessionId&&job.origin.messageId===origin.messageId);
        const forwarded=proven||pending||isForwardedCopy(sessionId,message.id,file,origin);
        const original=readRecord(origin.sessionId,origin.messageId);if(!original)return forwarded?{...origin,message:null,file:null}:null;
        const candidates=files(original).filter(value=>webpage(value)&&value.creatorDeviceId===file.creatorDeviceId);
        let matches=candidates.filter(value=>value.id===file.webZipSourceVersion?.id||file.webZipRootId&&(value.id===file.webZipRootId||value.webZipRootId===file.webZipRootId));
        if(!matches.length)matches=candidates.filter(value=>equivalent(value,file));
        // Old single-file forwards have no root yet. Their verified record
        // anchor still identifies the one webpage after another copy edits it.
        if(!matches.length&&forwarded&&!file.webZipRootId&&original.type==='file'&&candidates.length===1)matches=candidates;
        const resolved={...origin,message:original,file:matches.length===1?matches[0]:null};
        // Before provenance proofs existed, an already completed publication
        // lost its audit marker. The editor's original signed capability can
        // recover that exact link, including permission versions and anchors.
        if(!forwarded&&(!resolved.file||!credentials?.verify(editCredential,scopeOf(sessionId,message.id,file,deviceId,resolved))))return null;
        return resolved;
    }
    function copiesOf(sessionId,message,file,origin){
        const result=[{message,file}];if(!origin)return result;
        const root=origin.file?.webZipRootId||origin.file?.id||file.webZipRootId;
        if(!root)return result;
        for(const candidate of listRecords(sessionId))for(const copy of files(candidate)){
            if(candidate.id===message.id&&copy.id===file.id||candidate.forwardedFrom?.sessionId!==origin.sessionId||candidate.forwardedFrom?.messageId!==origin.messageId||!webpage(copy)||copy.creatorDeviceId!==file.creatorDeviceId)continue;
            const source=sourceOf(sessionId,candidate,copy);
            if(source?.sessionId===origin.sessionId&&source.messageId===origin.messageId&&
                (source.file?.webZipRootId||source.file?.id||copy.webZipRootId)===root)result.push({message:candidate,file:copy});
        }
        return result;
    }
    async function updateCopies(job,transform,canWrite){
        const message=readRecord(job.sessionId,job.messageId),file=files(message).find(value=>value.id===job.file.id);
        if(!file||jobs.get(job.key)!==job)return;
        for(const target of copiesOf(job.sessionId,message,file,{...job.origin,file:job.file})){
            if(jobs.get(job.key)!==job)return;
            // Another file in a collection may already have changed its record.
            const current=readRecord(job.sessionId,target.message.id),copy=files(current).find(value=>value.id===target.file.id);
            if(!copy)continue;
            const next=transform(copy,current);if(!next||JSON.stringify(next)===JSON.stringify(copy))continue;
            if(resign&&next.webZipTrustIntegrityStamp)resign(next,job.sessionId,current.id,job.file,job.sessionId,job.messageId);
            await writeRecord(job.sessionId,current,replaceFile(current,copy.id,next),{check:()=>jobs.get(job.key)===job&&(!canWrite||canWrite())});
        }
    }
    async function mirror(job){
        await updateCopies(job,(file,message)=>{
            if(file.id===job.file.id&&revision(file)===revision(job.file))return null;
            if(revision(file)>revision(job.file))failure('WEB_ZIP_SOURCE_CHANGED');
            const next={...clone(job.file),replacesFileId:file.id===job.file.id?file.replacesFileId:file.id};
            if(credentials?.issueSource)next.webZipSourceProof=credentials.issueSource(sourceScope(job.sessionId,message,next,job.origin));
            return next;
        },()=>canPublish(job.sessionId,job.deviceId)&&canEdit(files(readRecord(job.sessionId,job.messageId)).find(file=>file.id===job.file.id),job.deviceId));
    }
    function reanchor(job){
        for(const message of listRecords(job.sessionId))for(const file of files(message)){
            if(file.id!==job.file.id||file.creatorDeviceId!==job.file.creatorDeviceId||file.webZipRootId!==job.file.webZipRootId)continue;
            const source=sourceOf(job.sessionId,message,file);
            if(source?.sessionId!==job.origin.sessionId||source.messageId!==job.origin.messageId)continue;
            if(resign&&job.file.webZipTrustIntegrityStamp)resign(job.file,job.sessionId,message.id,job.file,job.sessionId,job.messageId);
            job.credentialMessageId ||= job.messageId;job.messageId=message.id;return true;
        }
        return false;
    }
    function ownedCopy(file,input,deviceId){
        const next={...file};
        for(const field of ['id','name','size','type','timestamp','data','cacheStoreRef','cacheStorage','serverAssetUrl','isServerAsset','telegramFileId','telegramFileUniqueId','telegramChatId','telegramFileIdUpdatedAt','backupSourceSessionId','forwardedToSessionId','forwardedSourceGrant','sourceFileId','webZipPendingSync','webZipSourceVersion','isExternalFile','externalFileHandle','externalFileMissing','isPartial','transferInterrupted','cacheCleared','restoreRequested'])delete next[field];
    return{...clone(next),id:input.id,name:input.name,type:input.type,size:input.size,webZipSha256:input.webZipSha256,webZipTrustIntegrityStamp:input.webZipTrustIntegrityStamp,timestamp:Date.now(),ownerDeviceId:deviceId,sender:deviceId,isAsset:true,webZip:true,
            webZipHideFrame:input.webZipHideFrame===true,webZipFullscreen:input.webZipFullscreen===true,webZipRevision:revision(file)+1,replacesFileId:file.id,webZipUpdatedAt:Date.now()};
    }
    const scopeOf=(sessionId,messageId,file,deviceId,origin)=>({sessionId,messageId,deviceId,creatorDeviceId:file.creatorDeviceId,
        rootId:origin?.file?.webZipRootId||origin?.file?.id||file.webZipRootId||file.id,sourceSessionId:origin?.sessionId||sessionId,sourceMessageId:origin?.messageId||messageId,
        permissionAt:file.webZipPermissionUpdatedAt,sourcePermissionAt:origin?.file?.webZipPermissionUpdatedAt});
    function issueCredential({sessionId,messageId,fileId,deviceId,editCredential}){
        const message=readRecord(sessionId,messageId),file=files(message).find(value=>value.id===fileId);
        if(!webpage(file))failure('WEB_ZIP_EDIT_DENIED','RECORD_NOT_FOUND');
        if(!canPublish(sessionId,deviceId))failure('WEB_ZIP_EDIT_DENIED','TUNNEL_PERMISSION_DENIED');
        if(!canEdit(file,deviceId))failure('WEB_ZIP_EDIT_DENIED','NOT_IN_EDITOR_LIST',true);
        const origin=sourceOf(sessionId,message,file,editCredential,deviceId);
        if(lostSource(sessionId,message,file,origin))failure('WEB_ZIP_SOURCE_UNVERIFIED');
        if(!origin&&editCredential&&message?.forwardedFrom?.sessionId&&message.forwardedFrom.sessionId!==sessionId&&file.webZipRootId&&!credentials?.verify(editCredential,scopeOf(sessionId,messageId,file,deviceId,null)))failure('WEB_ZIP_EDIT_CREDENTIAL_INVALID','SOURCE_PROOF_SCOPE_MISMATCH',true);
        if(origin?.file&&!canEdit(origin.file,deviceId)&&Number(origin.file.webZipPermissionUpdatedAt||0)>Number(file.webZipPermissionUpdatedAt||0))failure('WEB_ZIP_EDIT_DENIED','SOURCE_EDITOR_PERMISSION_CHANGED',true);
        return credentials?.issue(scopeOf(sessionId,messageId,file,deviceId,origin))||'';
    }
    async function mark(job,error){
        if(jobs.get(job.key)!==job)return;
        await updateCopies(job,file=>file.id===job.file.id&&file.webZipPendingSync&&file.webZipPendingSync.lastError!==error?
            {...file,webZipPendingSync:{...file.webZipPendingSync,lastError:error}}:null);
    }
    async function finish(job){
        if(jobs.get(job.key)!==job)return;
        await updateCopies(job,(file,message)=>{
            if(file.id!==job.file.id||!file.webZipPendingSync)return null;
            const next={...file,webZipSourceVersion:version(job.file)};delete next.webZipPendingSync;
            if(credentials?.issueSource)next.webZipSourceProof=credentials.issueSource(sourceScope(job.sessionId,message,next,job.origin));
            return next;
        });
        if(jobs.get(job.key)===job){jobs.delete(job.key);try{await persist();}catch(error){if(!jobs.has(job.key))jobs.set(job.key,job);throw error;}topologyChanged();}
    }
    async function sync(job){
        if(jobs.get(job.key)!==job||publishing.has(job))return;
        let message=readRecord(job.sessionId,job.messageId),file=files(message).find(value=>value.id===job.file.id);
        if(!file){if(!reanchor(job)){jobs.delete(job.key);await persist();return;}await persist();message=readRecord(job.sessionId,job.messageId);file=files(message).find(value=>value.id===job.file.id);}
        if(!canEdit(file,job.deviceId)||!canPublish(job.sessionId,job.deviceId))return mark(job,'WEB_ZIP_EDIT_DENIED');
        const original=readRecord(job.origin.sessionId,job.origin.messageId);
        const candidates=files(original).filter(value=>webpage(value)&&value.creatorDeviceId===job.file.creatorDeviceId);
        const current=candidates.find(value=>value.id===job.file.id)||candidates.find(value=>value.id===job.base?.id)||candidates.find(value=>value.webZipRootId===job.file.webZipRootId||value.id===job.file.webZipRootId)||candidates.find(value=>equivalent(value,job.previous));
        // A journal from the former per-record model may be based on the
        // version before a sibling completed. Only a verified, completed
        // sibling proving that exact source version can advance that base.
        if(current&&current.id!==job.file.id&&job.base&&current.id!==job.base.id){
            const prior=copiesOf(job.sessionId,message,file,{...job.origin,file:job.file}).find(target=>target.file.id===current.id&&!target.file.webZipPendingSync&&
                target.file.webZipSourceVersion?.id===current.id&&target.file.webZipSourceVersion.revision===revision(current)&&
                Number(target.file.webZipUpdatedAt||0)<=Number(job.file.webZipUpdatedAt||0));
            if(prior){job.base=version(current);job.file.webZipRevision=Math.max(revision(job.file),revision(current)+1);await persist();}
        }
        await mirror(job);
        if(!canSync(job.deviceId,job.origin.sessionId,job.sessionId))return;
        if(!original)return mark(job,'WEB_ZIP_SOURCE_MISSING');
        if(!current)return mark(job,'WEB_ZIP_SOURCE_CHANGED');
        const scope=scopeOf(job.sessionId,job.credentialMessageId||job.messageId,file,job.deviceId,{...job.origin,file:current});
        const credentialValid=credentials?.verify(job.editCredential,scope);
        if(!canEdit(current,job.deviceId)&&!credentialValid)return mark(job,'WEB_ZIP_SOURCE_EDIT_DENIED');
        if(current.webZipPendingSync)return mark(job,'WEB_ZIP_SOURCE_BUSY');
        if(current.id!==job.file.id){
            const expected=job.base|| (equivalent(current,job.previous)?version(current):null);
            if(!expected||!(current.id===expected.id&&revision(current)===expected.revision||current.id===job.previous.id&&revision(current)===revision(job.previous)))return mark(job,'WEB_ZIP_SOURCE_CHANGED');
            const next={...ownedCopy(current,job.file,current.ownerDeviceId||original.sender),webZipRootId:job.file.webZipRootId,
                webZipRevision:revision(job.file),backupSourceSessionId:job.sessionId,forwardedToSessionId:job.origin.sessionId};
            if(resign&&job.file.webZipTrustIntegrityStamp)resign(next,job.origin.sessionId,original.id,job.file,job.sessionId,job.messageId);
            await writeRecord(job.origin.sessionId,original,replaceFile(original,current.id,next),{
                source:'cross-tunnel-forward',copyFromSessionId:job.sessionId,
                check:()=>jobs.get(job.key)===job&&canSync(job.deviceId,job.origin.sessionId,job.sessionId)&&canPublish(job.sessionId,job.deviceId)&&canEdit(files(readRecord(job.sessionId,job.messageId)).find(value=>value.id===job.file.id),job.deviceId)
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
        for(const [jobKey,job]of jobs)if(job.sessionId===sessionId&&job.messageId===messageId&&!ids.has(job.file.id)){if(!reanchor(job))jobs.delete(jobKey);removed=true;}
        if(removed)persist().catch(error=>log('web-zip-sync-cleanup-failed',error));
    }
    async function publishNow({sessionId,messageId,fileId,fileInfo,deviceId,editCredential}){
        const message=readRecord(sessionId,messageId),current=files(message).find(value=>value.id===fileId);
        const retried=files(message).find(value=>value.id===fileInfo?.id&&value.replacesFileId===fileId&&value.ownerDeviceId===deviceId);
        if(retried&&canEdit(retried,deviceId)&&canPublish(sessionId,deviceId)){const job=[...jobs.values()].find(value=>value.file.id===retried.id&&value.sessionId===sessionId&&value.messageId===messageId);if(job)await attempt(job);return readRecord(sessionId,messageId);}
        if(!webpage(current)||!canEdit(current,deviceId)||!canPublish(sessionId,deviceId))failure('WEB_ZIP_EDIT_DENIED');
        if(!fileInfo?.id||fileInfo.id===fileId||!String(fileInfo.name||'').toLowerCase().endsWith('.html.zip')||!Number.isSafeInteger(fileInfo.size)||fileInfo.size<0||!hasContent(sessionId,deviceId,fileInfo))failure('WEB_ZIP_CONTENT_NOT_READY');
        const origin=sourceOf(sessionId,message,current,editCredential,deviceId),next=ownedCopy(current,fileInfo,deviceId);
        if(lostSource(sessionId,message,current,origin))failure('WEB_ZIP_SOURCE_UNVERIFIED');
        const scope=scopeOf(sessionId,messageId,current,deviceId,origin);
        if(editCredential&&credentials&&!credentials.verify(editCredential,scope))failure('WEB_ZIP_EDIT_CREDENTIAL_INVALID');
        if(credentials)editCredential=editCredential||issueCredential({sessionId,messageId,fileId,deviceId});
        if(origin&&unavailable)failure('WEB_ZIP_SYNC_STORAGE');
        next.webZipRootId=origin?.file?.webZipRootId||origin?.file?.id||current.webZipRootId||current.id;
        if(origin&&credentials?.issueSource)next.webZipSourceProof=credentials.issueSource(sourceScope(sessionId,message,next,origin));
        else delete next.webZipSourceProof;
        let job,previousJob;
        if(origin){
            const jobKey=key(sessionId,messageId,{...current,webZipRootId:next.webZipRootId},origin);
            previousJob=jobs.get(jobKey)||[...jobs.values()].find(value=>value.sessionId===sessionId&&value.origin.sessionId===origin.sessionId&&value.origin.messageId===origin.messageId&&value.file.creatorDeviceId===current.creatorDeviceId&&value.file.webZipRootId===next.webZipRootId);
            job={key:jobKey,sessionId,messageId,deviceId,origin:{sessionId:origin.sessionId,messageId:origin.messageId},file:next,editCredential,
                previous:{id:current.id,name:current.name,type:current.type,size:current.size,creatorDeviceId:current.creatorDeviceId,webZipDraftId:current.webZipDraftId,webZipRevision:revision(current)},
                base:previousJob?.base||current.webZipSourceVersion||(equivalent(current,origin.file)?version(origin.file):null)};
            next.webZipPendingSync={state:'pending',sessionId:origin.sessionId,messageId:origin.messageId};publishing.add(job);if(previousJob)jobs.delete(previousJob.key);jobs.set(jobKey,job);
            try{await persist();}catch(error){publishing.delete(job);jobs.delete(jobKey);if(previousJob)jobs.set(previousJob.key,previousJob);throw error;}
        }
        try{await writeRecord(sessionId,message,replaceFile(message,fileId,next),{check:()=>canPublish(sessionId,deviceId)&&canEdit(files(readRecord(sessionId,messageId)).find(value=>value.id===fileId),deviceId)});}
        catch(error){if(job&&jobs.get(job.key)===job){jobs.delete(job.key);if(previousJob)jobs.set(previousJob.key,previousJob);await persist();}throw error;}
        finally{if(job)publishing.delete(job);}
        if(job)await attempt(job);
        return readRecord(sessionId,messageId);
    }
    function publish(input){
        const message=readRecord(input.sessionId,input.messageId),file=files(message).find(value=>value.id===input.fileId)||files(message).find(value=>value.id===input.fileInfo?.id);
        const origin=file&&sourceOf(input.sessionId,message,file,input.editCredential,input.deviceId);
        const publicationKey=file?key(input.sessionId,input.messageId,{...file,webZipRootId:origin?.file?.webZipRootId||origin?.file?.id||file.webZipRootId},origin):JSON.stringify([input.sessionId,input.messageId]);
        const previous=publications.get(publicationKey)||Promise.resolve();
        const task=previous.catch(()=>{}).then(()=>publishNow(input));publications.set(publicationKey,task);
        task.finally(()=>{if(publications.get(publicationKey)===task)publications.delete(publicationKey);}).catch(()=>{});return task;
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
        const peers=copiesOf(sessionId,message,file,origin),permissionAt=Date.now();
        for(const target of [...(origin?.file?[{sessionId:origin.sessionId,message:origin.message,file:origin.file}]:[]),...peers.map(value=>({...value,sessionId}))]){
            if(target.file.creatorDeviceId!==creatorDeviceId)failure('not-web-zip-creator');
            const current=readRecord(target.sessionId,target.message.id),latest=files(current).find(value=>value.id===target.file.id);if(!latest)failure('WEB_ZIP_SOURCE_CHANGED');
            const updated={...latest,webZipEditors:[...new Set([...(latest.webZipEditors||[]),deviceId])],webZipPermissionUpdatedAt:permissionAt};
            if(target.sessionId===sessionId&&origin?.file){
                updated.webZipRootId=origin.file.webZipRootId||origin.file.id;
                updated.webZipSourceVersion=latest.webZipSourceVersion||version(origin.file);
                if(credentials?.issueSource)updated.webZipSourceProof=credentials.issueSource(sourceScope(sessionId,current,updated,origin));
            }
            await writeRecord(target.sessionId,current,replaceFile(current,latest.id,updated),{source:'web-zip-editor-approved'});
        }
        topologyChanged();return readRecord(sessionId,messageId);
    }
    return{publish,approve,needsApproval,issueCredential,topologyChanged,recordChanged};
}
module.exports={createWebZipSync};
