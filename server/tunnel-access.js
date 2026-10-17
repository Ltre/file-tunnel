'use strict';
const crypto=require('node:crypto'),path=require('node:path');
const fs=require('node:fs');
const {privateKeyFile}=require('./private-key-file');
function createTunnelAccess(dataDir){const key=privateKeyFile(path.join(dataDir,'.tunnel-access.key'),()=>crypto.randomBytes(48).toString('base64url')),attempts=new Map(),ledger=path.join(dataDir,'.tunnel-access-members'),members=new Set();let loadedSize=-1;
    const legacyLedger=path.join(dataDir,'.tunnel-access-legacy'),legacy=new Set();let legacySize=-1;
    const memberKey=(sessionId,deviceId)=>crypto.createHash('sha256').update(sessionId+'\0'+deviceId).digest('hex');
    function enrolled(sessionId,deviceId){const size=fs.existsSync(ledger)?fs.statSync(ledger).size:0;if(size!==loadedSize){members.clear();if(size)for(const line of fs.readFileSync(ledger,'utf8').trim().split('\n')){if(!/^[a-f0-9]{64}$/.test(line))throw Error('TUNNEL_ACCESS_LEDGER_INVALID');members.add(line);}loadedSize=size;}return members.has(memberKey(sessionId,deviceId));}
    const sign=payload=>crypto.createHmac('sha256',key).update(payload).digest('base64url');
    function issue(sessionId,deviceId){if(!enrolled(sessionId,deviceId)){const fd=fs.openSync(ledger,'a',0o600);try{fs.writeSync(fd,memberKey(sessionId,deviceId)+'\n');fs.fsyncSync(fd);}finally{fs.closeSync(fd);}loadedSize=-1;}const payload=Buffer.from(JSON.stringify({sessionId,deviceId})).toString('base64url');return payload+'.'+sign(payload);}
    function verify(token,sessionId,deviceId){try{const [payload,signature,...extra]=String(token||'').split('.'),expected=sign(payload);if(extra.length||!signature||signature.length!==expected.length||!/^[\w-]+$/.test(signature)||!crypto.timingSafeEqual(Buffer.from(signature),Buffer.from(expected)))return false;const value=JSON.parse(Buffer.from(payload,'base64url'));return value.sessionId===sessionId&&value.deviceId===deviceId;}catch(_){return false;}}
    function attempt(ip){const now=Date.now();for(const [id,v]of attempts)if(v.until<now)attempts.delete(id);const entry=attempts.get(ip)||{n:0,until:now+600000};entry.n++;attempts.set(ip,entry);return entry.n<=40&&attempts.size<=10000;}
    function legacyProof(sessionId,deviceId,code){return crypto.createHmac('sha256',key).update('legacy\0'+sessionId+'\0'+deviceId+'\0'+code).digest('hex');}
    function loadLegacy(){const size=fs.existsSync(legacyLedger)?fs.statSync(legacyLedger).size:0;if(size!==legacySize){legacy.clear();if(size)for(const line of fs.readFileSync(legacyLedger,'utf8').trim().split('\n')){if(!/^[a-f0-9]{64}$/.test(line))throw Error('TUNNEL_ACCESS_LEDGER_INVALID');legacy.add(line);}legacySize=size;}}
    function preserveLegacy(sessionId,code,deviceIds){if(!/^[A-Z0-9]{5}$/.test(code||''))return;loadLegacy();const proofs=[...new Set(deviceIds)].filter(id=>!enrolled(sessionId,id)).map(id=>legacyProof(sessionId,id,code)).filter(proof=>!legacy.has(proof));if(!proofs.length)return;
        const fd=fs.openSync(legacyLedger,'a',0o600);try{fs.writeSync(fd,proofs.join('\n')+'\n');fs.fsyncSync(fd);}finally{fs.closeSync(fd);}legacySize=-1;}
    function verifyLegacy(sessionId,deviceId,code){if(enrolled(sessionId,deviceId)||!/^[A-Z0-9]{5}$/.test(code||''))return false;loadLegacy();return legacy.has(legacyProof(sessionId,deviceId,code));}
    const joinRevision=(sessionId,code)=>sign('join-revision\0'+sessionId+'\0'+code);
    function issueJoin(sessionId,code){const payload=Buffer.from(JSON.stringify({purpose:'join',sessionId,revision:joinRevision(sessionId,code)})).toString('base64url');return payload+'.'+sign(payload);}
    function verifyJoin(token,sessionId,code){try{if(!code||typeof token!=='string'||token.length>2048)return false;const [payload,signature,...extra]=token.split('.'),expected=sign(payload);if(extra.length||!signature||signature.length!==expected.length||!crypto.timingSafeEqual(Buffer.from(signature),Buffer.from(expected)))return false;const value=JSON.parse(Buffer.from(payload,'base64url'));return value.purpose==='join'&&value.sessionId===sessionId&&value.revision===joinRevision(sessionId,code);}catch(_){return false;}}
    return {issue,verify,enrolled,attempt,preserveLegacy,verifyLegacy,issueJoin,verifyJoin};
}
module.exports={createTunnelAccess};
