'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
function createStreamingCovers(dataDir) {
    const root=path.join(dataDir,'streaming-console','covers');
    function filename(stationId,hash) {
        if(!/^[\w-]{8,100}$/.test(stationId)||!/^[a-f0-9]{64}$/.test(hash))throw Error('STREAM_COVER_INVALID');
        return path.join(root,stationId+'-'+hash+'.png');
    }
    function put(stationId,body) {
        if(!Buffer.isBuffer(body)||body.length<45||body.length>2*1024*1024||body.subarray(0,8).toString('hex')!=='89504e470d0a1a0a'||body.toString('ascii',12,16)!=='IHDR')throw Error('STREAM_COVER_INVALID');
        const width=body.readUInt32BE(16),height=body.readUInt32BE(20);
        if(width!==height||width<1||width>1024)throw Error('STREAM_COVER_INVALID');
        const hash=crypto.createHash('sha256').update(body).digest('hex'),file=filename(stationId,hash);
        fs.mkdirSync(root,{recursive:true});if(!fs.existsSync(file))fs.writeFileSync(file,body,{flag:'wx'});
        return hash;
    }
    return {put,has:(stationId,hash)=>fs.existsSync(filename(stationId,hash)),read:(stationId,hash)=>fs.readFileSync(filename(stationId,hash))};
}
module.exports={createStreamingCovers};
