'use strict';
const fs=require('node:fs'),path=require('node:path');
// Opt-in, bounded diagnostic records. Never collect request headers or bodies.
function diagnostics(dataDir, enabled=process.env.D2T_S3_DIAGNOSTICS==='1') {
    return (req,res,next)=>{
        if(!enabled)return next();
        const started=Date.now();let xml='';const send=res.send.bind(res);
        res.send=value=>{if(typeof value==='string'&&value.trim().startsWith('<?xml'))xml=value.slice(0,4096);return send(value);};
        res.once('finish',()=>{try{
            const url=new URL(req.originalUrl,'http://localhost'),query={};
            for(const name of ['list-type','prefix','delimiter','max-keys','encoding-type','location','x-id'])if(url.searchParams.has(name))query[name]=url.searchParams.get(name).slice(0,512);
            const entry={time:new Date().toISOString(),method:req.method,path:url.pathname.slice(0,2048),query,status:res.statusCode,
                contentType:res.getHeader('content-type')||'',requestId:res.getHeader('x-amz-request-id')||'',ms:Date.now()-started,xml,bodyTruncated:xml.length===4096};
            const file=path.join(dataDir,'s3-diagnostics.log');
            if(fs.existsSync(file)&&fs.statSync(file).size>2*1024*1024){const old=file+'.1';if(fs.existsSync(old))fs.unlinkSync(old);fs.renameSync(file,old);}
            fs.appendFileSync(file,JSON.stringify(entry)+'\n',{mode:0o600});
        }catch(error){console.warn('[s3] diagnostic write failed',error.code||'LOG_WRITE_FAILED');}});next();
    };
}
module.exports={diagnostics};
