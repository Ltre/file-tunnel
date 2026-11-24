'use strict';

// Freeze a server-owned inventory once, before accepting connections. A browser
// cannot enroll a new unsigned archive by backdating its timestamp. Permissions
// and collaboration grants are deliberately outside this content inventory.
const fs=require('node:fs'),crypto=require('node:crypto');
const {writeJson}=require('./disk-data');
const CUTOFF=Date.parse('2026-11-23T00:00:00+08:00');
const files=message=>message?.type==='file'?[message.fileInfo].filter(Boolean):message?.type==='collection'?message.collection?.files||[]:[];
const webZip=file=>file&&(file.webZip===true||/\.html\.zip$/i.test(file.name||''));
const key=(sessionId,messageId,fileId)=>JSON.stringify([sessionId,messageId,fileId]);
const fingerprint=file=>crypto.createHash('sha256').update(JSON.stringify([
    file.id,file.name,file.size,file.type,file.creatorDeviceId,file.webZipRevision,
    file.webZipUpdatedAt,file.timestamp,file.webZipSha256,file.webZipTrustIntegrityStamp,file.data
])).digest('hex');

function createWebZipLegacy({filename,log=()=>{}}) {
    let entries=new Map(),ready=false;
    function initialize(store) {
        if(ready)return;
        try {
            if(fs.existsSync(filename)) {
                const saved=JSON.parse(fs.readFileSync(filename,'utf8'));
                if(saved.version!==1||saved.cutoff!==CUTOFF||!Array.isArray(saved.entries)||
                    saved.entries.some(entry=>!Array.isArray(entry)||entry.length!==2||typeof entry[0]!=='string'||!/^[a-f0-9]{64}$/.test(entry[1])))throw Error('invalid legacy inventory');
                entries=new Map(saved.entries);
            } else {
                const captured=new Map();
                for(let offset=0;;offset+=1000) {
                    const rows=store.query("SELECT session_id,message_id,payload_json FROM transfer_records WHERE deleted_at IS NULL AND message_type IN ('file','collection') LIMIT 1000 OFFSET ?",[offset]);
                    for(const row of rows) {
                        let message;try{message=JSON.parse(row.payload_json);}catch(_){continue;}
                        for(const file of files(message).filter(webZip)) {
                            const times=[file.webZipUpdatedAt,file.timestamp].map(Number).filter(value=>Number.isFinite(value)&&value>0);
                            const editedAt=times.length?Math.max(...times):Number(message.timestamp);
                            if(Number.isFinite(editedAt)&&editedAt>0&&editedAt<CUTOFF)
                                captured.set(key(row.session_id,row.message_id,file.id),fingerprint(file));
                        }
                    }
                    if(rows.length<1000)break;
                }
                writeJson(filename,{version:1,cutoff:CUTOFF,capturedAt:Date.now(),entries:[...captured]});
                entries=captured;
            }
            ready=true;
        } catch(error) {
            // A damaged inventory must not silently enroll current records on
            // a restart. Signed publications still use the regular verifier.
            entries.clear();log('web-zip-legacy-inventory-unavailable',{code:error.code||'INVALID_INVENTORY'});
        }
    }
    function allows(file,messageId,sessionId) {
        return ready&&webZip(file)&&entries.get(key(sessionId,messageId,file.id))===fingerprint(file);
    }
    return {initialize,allows};
}

module.exports={createWebZipLegacy,CUTOFF};
