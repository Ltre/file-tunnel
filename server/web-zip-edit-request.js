'use strict';

// Resolve only server-owned records, including entries outside the bounded
// live history. Caller checks the account, tunnel membership and capability.
function resolveWebZipEditRequest({sessionId,messageId,fileId,readRecord,listRecords}) {
    const records=messageId?[readRecord(sessionId,messageId)]:listRecords(sessionId);
    for(const message of records) {
        const files=message?.type==='file'?[message.fileInfo]:message?.type==='collection'?message.collection?.files||[]:[];
        const file=files.find(value=>value?.id===fileId&&(value.webZip===true||/\.html\.zip$/i.test(value.name||'')));
        if(!file)continue;
        if(!file.creatorDeviceId)throw Error('WEB_ZIP_CREATOR_MISSING');
        return {fileInfo:file,messageId:message.id};
    }
    throw Error('WEB_ZIP_RECORD_NOT_FOUND');
}

module.exports={resolveWebZipEditRequest};
