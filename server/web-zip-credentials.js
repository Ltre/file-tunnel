'use strict';
// Only a webpage edit capability: it is not a tunnel admission or file-read token.
const crypto=require('node:crypto'),path=require('node:path');
const {privateKeyFile}=require('./private-key-file');
function createWebZipCredentials({dataDir}) {
    const key=privateKeyFile(path.join(dataDir,'.web-zip-edit.key'),()=>crypto.randomBytes(48).toString('base64url'));
    const sign=payload=>crypto.createHmac('sha256',key).update('web-zip-edit\0'+payload).digest('base64url');
    const canonical=scope=>JSON.stringify(['web-zip-edit',1,scope.deviceId,scope.creatorDeviceId,scope.rootId,scope.sessionId,scope.messageId,scope.sourceSessionId,scope.sourceMessageId,Number(scope.permissionAt)||0,Number(scope.sourcePermissionAt)||0]);
    // Provenance survives ordinary record persistence. It confirms this exact
    // forwarded anchor only; it grants neither editing nor tunnel/file access.
    const sourceCanonical=scope=>JSON.stringify(['web-zip-source',1,scope.creatorDeviceId,scope.rootId,scope.sessionId,scope.messageId,scope.sourceSessionId,scope.sourceMessageId]);
    return {
        issue(scope){const payload=Buffer.from(canonical(scope)).toString('base64url');return 'we1.'+payload+'.'+sign(payload);},
        verify(token,scope){try{if(typeof token!=='string'||token.length>4096)return false;const [prefix,payload,signature,...extra]=token.split('.');if(prefix!=='we1'||extra.length||!signature||!/^[\w-]+$/.test(payload))return false;const expected=sign(payload);return signature.length===expected.length&&crypto.timingSafeEqual(Buffer.from(signature),Buffer.from(expected))&&Buffer.from(payload,'base64url').toString()===canonical(scope);}catch(_){return false;}},
        issueSource(scope){return 'ws1.'+sign(sourceCanonical(scope));},
        verifySource(token,scope){try{if(typeof token!=='string'||!/^ws1\.[\w-]{43}$/.test(token))return false;const expected='ws1.'+sign(sourceCanonical(scope));return crypto.timingSafeEqual(Buffer.from(token),Buffer.from(expected));}catch(_){return false;}}
    };
}
module.exports={createWebZipCredentials};
