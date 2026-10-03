'use strict';
const crypto = require('node:crypto');
const { contentKey, assertContentAuthorization } = require('./disk-content-repository');
const prefix = (nonce, range) => {
    const layout=Buffer.alloc(12);layout.writeBigUInt64BE(BigInt(range.offset));layout.writeUInt32BE(range.size,8);
    return Buffer.concat([Buffer.from('Drop2Tunnel-PoP-v1\0'),Buffer.from(nonce,'hex'),layout]);
};

// All proof state is durable. Network reads occur outside the short SQLite
// transactions; the lease pins the revision used to calculate sample digests.
function createContentProof({ content, open, validate }) {
    const session=req=>{
        const cookie=(String(req.headers?.cookie || '').split(';').map(value=>value.trim()).find(value=>value.startsWith('drop2tunnel_telegram_drive=')) || '');
        // Browser authentication uses the Cookie, so an unrelated Authorization
        // header cannot give a logged-out Cookie a new, unrevoked fingerprint.
        return crypto.createHash('sha256').update(req.diskApp ? String(req.headers?.authorization || '') : cookie || String(req.headers?.authorization || '')).digest('hex');
    };
    const binding = (req, file, folder) => JSON.stringify([String(req.diskViewerId || req.diskUser.id),
        String(req.diskUser.id), String(req.diskScope.diskSpace || ''), String(req.collaboration?.id || ''), String(req.collaboration?.grantVersion ?? req.collaboration?.updatedAt ?? ''),
        String(req.diskApp?.appId || ''),String(req.diskUser.sessionVersion || req.diskUser.version || ''),session(req),
        String(file.folderPath ?? folder ?? ''), String(file.name), String(file.type || 'application/octet-stream'), file.size, file.contentSha256]);
    const viewer = req => String(req.diskViewerId || req.diskUser.id);
    const authorization = req => {
        const cookie=(String(req.headers?.cookie || '').split(';').map(value=>value.trim()).find(value=>value.startsWith('drop2tunnel_telegram_drive=')) || '').split('=').slice(1).join('=');
        const bearer=String(req.headers?.authorization || '').replace(/^Bearer\s+/i,'');
        if (!cookie && !bearer) return null; // Existing mock/internal calls have no browser session.
        let expiresAt=Date.now()+7*86400_000;
        if (cookie) { try { const payload=JSON.parse(Buffer.from(cookie.split('.')[0],'base64url')); if(Number.isSafeInteger(payload.exp))expiresAt=payload.exp; } catch {} }
        return {session:session(req),expiresAt,...(req.diskApp ? {appId:req.diskApp.appId,tokenHash:crypto.createHash('sha256').update(bearer).digest('hex')} : {})};
    };
    const assertAuthorization = value => content.write(db=>assertContentAuthorization(db,value));
    const equal = (a,b) => /^[a-f0-9]{64}$/.test(String(a)) && /^[a-f0-9]{64}$/.test(String(b)) && crypto.timingSafeEqual(Buffer.from(a,'hex'),Buffer.from(b,'hex'));
    function save(id, candidate, req, file, folder, payload, lease) {
        content.write(db => db.prepare('INSERT INTO disk_content_pop_challenges VALUES(?,?,?,?,?,?,?,?)')
            .run(id,candidate.id,candidate.current_revision,viewer(req),binding(req,file,folder),Date.now()+15*60_000,payload.verified ? 1 : 0,JSON.stringify({...payload,lease,session:session(req),grant:String(req.collaboration?.id || ''),grantVersion:String(req.collaboration?.grantVersion ?? req.collaboration?.updatedAt ?? '')})));
    }
    return {
        authorization, assertAuthorization,
        revokeSession(req) {
            const value=authorization(req);
            if (!value || value.expiresAt<=Date.now()) return;
            content.write(db=>db.prepare('INSERT INTO disk_content_revoked_sessions VALUES(?,?) ON CONFLICT(session) DO UPDATE SET expires_at=max(expires_at,excluded.expires_at)').run(value.session,value.expiresAt));
        },
        async preflight(req,file,folder) {
            assertAuthorization(authorization(req));
            if(!contentKey(file.contentSha256,file.size)) throw new Error('CONTENT_KEY_INVALID');
            content.write(db=>{
                db.prepare('DELETE FROM disk_content_pop_challenges WHERE expires_at<?').run(Date.now());
                db.prepare('DELETE FROM disk_content_leases WHERE expires_at<?').run(Date.now());
                db.prepare('DELETE FROM disk_content_claims WHERE expires_at<?').run(Date.now());
                db.prepare('DELETE FROM disk_content_revoked_sessions WHERE expires_at<?').run(Date.now());
                const active=db.prepare('SELECT count(*) AS n FROM disk_content_claims WHERE viewer_id=?').get(viewer(req)).n+
                    db.prepare('SELECT count(*) AS n FROM disk_content_pop_challenges WHERE viewer_id=? AND consumed IN (0,1)').get(viewer(req)).n;
                if(active>=200)throw new Error('CONTENT_ACTIVE_LIMIT');
            });
            const id=content.find(file.contentSha256,file.size);
            if(!id) return content.write(db=>{
                const key=contentKey(file.contentSha256,file.size),current=db.prepare('SELECT * FROM disk_content_claims WHERE content_key=?').get(key);
                if(current?.expires_at>Date.now()) return current.viewer_id===viewer(req) && current.binding===binding(req,file,folder) ? {status:'miss',uploadTicket:current.token} : {status:'wait',retryAfterMs:4000};
                const token=crypto.randomUUID(),candidate=crypto.randomUUID();
                db.prepare('INSERT INTO disk_content_claims VALUES(?,?,?,?,?,?) ON CONFLICT(content_key) DO UPDATE SET token=excluded.token,viewer_id=excluded.viewer_id,binding=excluded.binding,content_id=excluded.content_id,expires_at=excluded.expires_at')
                    .run(key,token,viewer(req),binding(req,file,folder),candidate,Date.now()+15*60_000);
                return {status:'miss',uploadTicket:token};
            });
            const candidate=content.resolve(id);
            // Reusing file_id across different bots is unsafe. Keep the existing
            // storage boundary even though the binary content key is universal.
            if(!await validate(candidate,req)) return {status:'miss'};
            const ticket=crypto.randomUUID(),lease=content.lease(id,viewer(req),ticket,'proof');
            try {
                if(file.size===0 || content.owned(id,viewer(req))) {
                    save(ticket,candidate,req,file,folder,{verified:true},lease);
                    return {status:'reuse',reuseTicket:ticket};
                }
                const nonce=crypto.randomBytes(32).toString('hex'), ranges=[];
                const count=Math.min(8,Math.max(1,Math.ceil(file.size/65536)));
                for(let i=0;i<count;i++) {
                    const start=Math.floor(i*file.size/count),end=Math.floor((i+1)*file.size/count),size=Math.min(65536,end-start);
                    const offset=start+(end-start>size ? crypto.randomInt(0,end-start-size+1) : 0);
                    ranges.push({offset,size});
                }
                const digests=[];
                for(const range of ranges) {
                    const digest=crypto.createHash('sha256').update(prefix(nonce,range)); let count=0;
                    if(range.size) {
                        const stream=await open(candidate,range.offset,range.offset+range.size-1,req);
                        for await(const bytes of stream) { count+=bytes.length; digest.update(bytes); }
                    }
                    if(count!==range.size) throw new Error('CONTENT_PROOF_SOURCE_INVALID');
                    digests.push(digest.digest('hex'));
                }
                save(ticket,candidate,req,file,folder,{nonce,ranges,digests,verified:false},lease);
                return {status:'proof',ticket,nonce,ranges};
            } catch(error) {
                content.releaseLease(lease);
                // A failed sample read grants no reference. The ordinary body
                // upload can still verify the complete bytes and build a candidate.
                return {status:'miss'};
            }
        },
        prove(req,ticket,digests) {
            return content.write(db=>{
                assertContentAuthorization(db,authorization(req));
                const row=db.prepare('SELECT * FROM disk_content_pop_challenges WHERE id=?').get(String(ticket));
                if(!row || row.viewer_id!==viewer(req) || row.expires_at<=Date.now() || row.consumed!==0) throw new Error('CONTENT_PROOF_EXPIRED');
                const saved=JSON.parse(row.payload);
                if(saved.session!==session(req) || saved.grant!==String(req.collaboration?.id || '') || saved.grantVersion!==String(req.collaboration?.grantVersion ?? req.collaboration?.updatedAt ?? ''))throw new Error('CONTENT_PROOF_INVALID');
                if(!Array.isArray(digests) || digests.length!==saved.digests.length || !digests.every((digest,index)=>equal(digest,saved.digests[index]))) {
                    db.prepare('UPDATE disk_content_pop_challenges SET consumed=-1 WHERE id=?').run(row.id);
                    db.prepare('DELETE FROM disk_content_leases WHERE id=?').run(saved.lease);
                    return {status:'miss'};
                }
                db.prepare('UPDATE disk_content_pop_challenges SET consumed=1 WHERE id=? AND consumed=0').run(row.id);
                return {status:'reuse',reuseTicket:row.id};
            });
        },
        consume(req,file,folder) {
            return content.write(db=>{
                assertContentAuthorization(db,authorization(req));
                const row=db.prepare('SELECT * FROM disk_content_pop_challenges WHERE id=?').get(String(file.reuseTicket));
                if(!row || row.viewer_id!==viewer(req) || row.binding!==binding(req,file,folder) || row.expires_at<=Date.now() || row.consumed!==1) throw new Error('CONTENT_PROOF_INVALID');
                const saved=JSON.parse(row.payload);
                if(!db.prepare('SELECT 1 FROM disk_content_leases WHERE id=? AND expires_at>?').get(saved.lease,Date.now())) throw new Error('CONTENT_LEASE_EXPIRED');
                const candidate=content.resolve(row.content_id);
                if(!candidate || candidate.current_revision!==row.revision || !['READY','DELETE_PENDING'].includes(candidate.state)) throw new Error('CONTENT_NOT_AVAILABLE');
                db.prepare('UPDATE disk_content_pop_challenges SET consumed=2 WHERE id=? AND consumed=1').run(row.id);
                return {id:row.content_id,lease:saved.lease};
            });
        },
        release(req,tickets) {
            if(!Array.isArray(tickets) || tickets.length>200)throw new Error('CONTENT_TICKETS_INVALID');
            content.write(db=>{for(const ticket of tickets){
                const row=db.prepare('SELECT payload FROM disk_content_pop_challenges WHERE id=? AND viewer_id=? AND consumed IN (0,1)').get(String(ticket),viewer(req));
                if(row){db.prepare('DELETE FROM disk_content_leases WHERE id=?').run(JSON.parse(row.payload).lease);db.prepare('DELETE FROM disk_content_pop_challenges WHERE id=?').run(String(ticket));}
                db.prepare('DELETE FROM disk_content_claims WHERE token=? AND viewer_id=?').run(String(ticket),viewer(req));
            }});
        },
        consumeClaim(req,file,folder) {
            return content.write(db=>{
                assertContentAuthorization(db,authorization(req));
                const row=db.prepare('SELECT * FROM disk_content_claims WHERE token=?').get(String(file.uploadTicket));
                if(!row || row.viewer_id!==viewer(req) || row.binding!==binding(req,file,folder) || row.expires_at<=Date.now()) throw new Error('CONTENT_CLAIM_EXPIRED');
                return {id:row.content_id,token:row.token};
            });
        }
    };
}
module.exports={createContentProof,prefix};
