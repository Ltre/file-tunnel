'use strict';

// Used only by the existing authenticated disk-admin router. Recover browser
// display receipts from logical files and their original publication journal.
function taskSaveReceipts({ spaces, partitions, auth, pendingSaves, inspectTask }, input) {
    if(!Array.isArray(input)||!input.length||input.length>100)throw new Error('PENDING_SAVE_INVALID');
    const keyOf=value=>JSON.stringify([value.source,value.taskId,value.version]);
    const wanted=new Map();
    for(const value of input){
        if(!['sns','youtube'].includes(value?.source)||typeof value.taskId!=='string'||!value.taskId||value.taskId.length>100||!/^\d+-\d+$/.test(value.version||''))throw new Error('PENDING_SAVE_INVALID');
        let eligible=true;
        try{inspectTask(value);}catch(error){if(!['TASK_SAVE_SOURCE_UNAVAILABLE','TASK_SAVE_VERSION_CONFLICT'].includes(error.message))throw error;eligible=false;}
        wanted.set(keyOf(value),{source:value.source,taskId:value.taskId,version:value.version,record:null,eligible});
    }
    for(const {diskSpace,store} of spaces.entries()){
        store.reloadPersistence();
        for(const file of store.adminFiles()){
            const meta=file.metadata||{},found=wanted.get(keyOf({source:meta.source,taskId:meta.sourceTaskId,version:meta.sourceTaskVersion}));
            if(!found?.eligible||file.reviewStatus==='deleted'||Number(found.version.split('-')[1])!==file.size||!meta.pendingSaveId)continue;
            const receipt=pendingSaves.get(file.ownerId,meta.pendingSaveId);
            if(!receipt||receipt.state!=='completed'||receipt.diskSpace!==diskSpace||receipt.folderPath!==(file.folderPath||''))continue;
            if(receipt.fileIds?.length&&!receipt.fileIds.includes(file.id))continue;
            let partition;try{partition=partitions.find(file.ownerId,diskSpace);}catch(_){continue;}
            if(found.record&&found.record.completedAt>=receipt.updatedAt)continue;
            const account=auth.user(file.ownerId);
            found.record={id:receipt.id,source:found.source,version:found.version,transferMode:'server',status:'completed',
                target:{accountId:file.ownerId,accountName:account?.name||account?.username||file.ownerId,accountTelegramId:account?.telegramId||'',accountProvider:account?.provider||'',
                    partitionId:partition.id,partitionName:partition.displayName,diskSpace,path:receipt.folderPath},
                file:{name:file.name,size:file.size,type:file.type||'application/octet-stream'},
                result:{ok:true,items:[{id:file.id,name:file.name,size:file.size,type:file.type,folderPath:file.folderPath}]},
                createdAt:receipt.createdAt,updatedAt:receipt.updatedAt,completedAt:receipt.updatedAt};
        }
    }
    return {results:[...wanted.values()].map(({eligible,...item})=>item)};
}
module.exports={taskSaveReceipts};
