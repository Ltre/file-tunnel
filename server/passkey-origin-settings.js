'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {passkeyOrigins}=require('./passkey-origins');
function createPasskeyOriginSettings({dataDir,fallback=()=>[]}){
    const filename=path.join(dataDir,'passkey-origins.json');
    function get(){
        try{
            const saved=JSON.parse(fs.readFileSync(filename,'utf8'));
            if(saved.version!==1||typeof saved.revision!=='string'||!Array.isArray(saved.origins))throw Error('PASSKEY_ORIGIN_SETTINGS_INVALID');
            return {origins:passkeyOrigins(saved.origins),revision:saved.revision,updatedAt:saved.updatedAt||0,source:'saved'};
        }catch(error){
            if(error.code!=='ENOENT')throw error;
            const origins=passkeyOrigins(fallback());
            return {origins,revision:'initial-'+crypto.createHash('sha256').update(JSON.stringify(origins)).digest('hex'),updatedAt:0,source:'initial'};
        }
    }
    function save({origins,revision}={}){
        if(!Array.isArray(origins)||origins.length>100)throw Error('PASSKEY_ORIGIN_INVALID');
        const normalized=passkeyOrigins(origins),previous=get();
        if(typeof revision!=='string'||revision!==previous.revision)throw Error('PASSKEY_ORIGIN_SETTINGS_CONFLICT');
        const saved={version:1,origins:normalized,revision:crypto.randomUUID(),updatedAt:Date.now()},temp=filename+'.'+crypto.randomUUID()+'.tmp';
        fs.mkdirSync(dataDir,{recursive:true});
        try{fs.writeFileSync(temp,JSON.stringify(saved,null,2)+'\n',{mode:0o600,flag:'wx'});fs.renameSync(temp,filename);}
        finally{try{fs.unlinkSync(temp);}catch(error){if(error.code!=='ENOENT')throw error;}}
        return get();
    }
    return {get,save};
}
module.exports={createPasskeyOriginSettings};
