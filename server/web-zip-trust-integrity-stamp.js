'use strict';
// WebZipTrustIntegrityStamp proves approval of *a digest*, never possession of
// the ZIP bytes. Its key and purpose are independent of collaboration grants.
const crypto=require('node:crypto'),path=require('node:path');
const {privateKeyFile}=require('./private-key-file');
const FIELDS=['version','sha256','fileId','messageId','sessionId','accountId','issuedAt','expiresAt','permissionVersion'];
const TTL=7*24*60*60*1000;
const digest=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
function createWebZipTrustIntegrityStamp({dataDir,user,hasPermission}){
    const key=privateKeyFile(path.join(dataDir,'.web-zip-trust-integrity.key'),()=>crypto.randomBytes(48).toString('base64url'));
    const canonical=payload=>JSON.stringify(['WebZipTrustIntegrityStamp',1,...FIELDS.map(field=>payload[field])]);
    const sign=payload=>crypto.createHmac('sha256',key).update(canonical(payload)).digest('base64url');
    const validScope=scope=>scope&&digest(scope.sha256)&&['fileId','messageId','sessionId','accountId'].every(field=>typeof scope[field]==='string'&&scope[field].length>0&&scope[field].length<=128);
    function issue(scope){
        if(!validScope(scope)||!hasPermission(scope.accountId,'webZip.publishEdit'))throw Error('WEB_ZIP_TRUST_DENIED');
        const account=user(scope.accountId),now=Date.now();
        const payload={version:1,sha256:scope.sha256,fileId:scope.fileId,messageId:scope.messageId,sessionId:scope.sessionId,
            accountId:scope.accountId,issuedAt:now,expiresAt:now+TTL,permissionVersion:Number(account.permissionVersion)||0};
        return `wzt1.${Buffer.from(canonical(payload)).toString('base64url')}.${sign(payload)}`;
    }
    function verify(token,scope){
        try{
            if(!validScope(scope)||typeof token!=='string'||token.length>4500)return false;
            const [prefix,body,mac,...extra]=token.split('.');
            if(prefix!=='wzt1'||extra.length||!body||!/^[-\w]{43}$/.test(mac||''))return false;
            const tuple=JSON.parse(Buffer.from(body,'base64url').toString('utf8'));
            if(!Array.isArray(tuple)||tuple.length!==FIELDS.length+2||tuple[0]!=='WebZipTrustIntegrityStamp'||tuple[1]!==1)return false;
            const payload=Object.fromEntries(FIELDS.map((field,index)=>[field,tuple[index+2]]));
            const now=Date.now(),account=user(payload.accountId);
            if(payload.version!==1||payload.issuedAt>now+30000||payload.expiresAt<=now||payload.expiresAt-payload.issuedAt>TTL||
                !account||!hasPermission(payload.accountId,'webZip.publishEdit')||payload.permissionVersion!==(Number(account.permissionVersion)||0))return false;
            if(FIELDS.slice(1,6).some(field=>payload[field]!==scope[field]))return false;
            const expected=sign(payload);
            return mac.length===expected.length&&crypto.timingSafeEqual(Buffer.from(mac),Buffer.from(expected));
        }catch(_){return false;}
    }
    function accountId(token){
        try{const parts=String(token).split('.');if(parts.length!==3||parts[0]!=='wzt1'||parts[1].length>3500)return '';
            const tuple=JSON.parse(Buffer.from(parts[1],'base64url').toString('utf8'));
            return Array.isArray(tuple)&&tuple[0]==='WebZipTrustIntegrityStamp'&&typeof tuple[7]==='string'?tuple[7]:'';
        }catch(_){return '';}
    }
    return {issue,verify,accountId};
}
module.exports={createWebZipTrustIntegrityStamp};
