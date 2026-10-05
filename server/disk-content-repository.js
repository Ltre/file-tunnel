'use strict';
const crypto = require('node:crypto');
const { createTelegramChatDictionary, normalizeChatIdentifier } = require('./telegram-chat-dictionary');

const PHYSICAL_FIELDS = ['parts', 'partCount', 'fileId', 'fileUniqueId', 'messageId', 'mediaGroupId', 'channelId', 'backendId', 'thumbnail', 'mediaIndex', 'fileIdHistory', 'pendingRemoteCleanup', 'captionSyncPending', 'captionWarning', 'lastCheckedAt', 'repairedAt', 'healthStatus', 'lastPhysicalError'];
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const contentKey = (sha, size) => /^[a-f0-9]{64}$/.test(String(sha)) && Number.isSafeInteger(size) && size >= 0 ? `sha256:v1:${size}:${sha}` : '';
function physicalRecord(file) {
    let offset=0;
    const parts = (Number(file.size)===0 ? [] : file.parts?.length ? file.parts : file.fileId ? [{ fileId: file.fileId, fileUniqueId: file.fileUniqueId, messageId: file.messageId,
        messageDate: file.createdAt, mediaGroupId: file.mediaGroupId, offset: 0, size: file.size }] : []).map((part, index) => {
        const value = { ...part, partIndex: index + 1 };
        if(value.offset===undefined)value.offset=offset;
        if(value.size===undefined && file.parts?.length===1)value.size=file.size;
        offset=Number(value.offset)+Number(value.size || 0);
        for (const key of ['logicalFileId', 'fileIndex', 'logicalIndex', 'originalSize', 'partCount', 'name', 'type']) delete value[key];
        return value;
    });
    return { backendId: file.backendId || '', channelId: String(file.channelId || ''), parts,
        thumbnail: file.thumbnail || null,
        // No trusted container parser exists yet. Never publish arbitrary
        // client ranges/offsets as a shared, validated media index.
        mediaIndex: { mode: 'unavailable', ...(file.mediaIndex?.reason ? { reason: String(file.mediaIndex.reason).slice(0,120) } : {}) },
        createdAt: file.createdAt || Date.now() };
}
const representationSignature = file => hash(JSON.stringify({ size: Number(file.size) || 0, channelId: String(file.channelId || ''), parts: physicalRecord(file).parts, thumbnail: file.thumbnail || null }));
const anchorKey = (chat, message) => `telegram:${String(chat)}:${Number(message)}`;

function assertContentAuthorization(db, authorization) {
    if (!authorization) return;
    const now=Date.now();
    if (!/^[a-f0-9]{64}$/.test(String(authorization.session)) || !Number.isSafeInteger(authorization.expiresAt) || authorization.expiresAt<=now || db.prepare('SELECT 1 FROM disk_content_revoked_sessions WHERE session=? AND expires_at>?').get(authorization.session,now))
        throw new Error('CONTENT_SESSION_EXPIRED');
    if (authorization.appId) {
        const tokenRow=db.prepare("SELECT payload FROM disk_tokens WHERE scope='' AND id=?").get(authorization.tokenHash);
        const appRow=db.prepare("SELECT payload FROM disk_apps WHERE scope='' AND id=?").get(authorization.appId);
        const token=tokenRow && JSON.parse(tokenRow.payload),app=appRow && JSON.parse(appRow.payload);
        if (!token || !app?.enabled || token.appId!==app.app_id || token.revision!==app.revision || token.expiresAt<=now)
            throw new Error('ACCESS_TOKEN_INVALID');
    }
}

function migrateContentSchema(db) {
    db.exec(`CREATE TABLE IF NOT EXISTS disk_contents (
        id TEXT PRIMARY KEY, content_key TEXT, size INTEGER NOT NULL, hash_status TEXT NOT NULL,
        state TEXT NOT NULL, current_revision INTEGER NOT NULL DEFAULT 1, state_version INTEGER NOT NULL DEFAULT 1,
        original_name TEXT NOT NULL, original_mime TEXT NOT NULL, created_at INTEGER NOT NULL,
        last_checked_at INTEGER NOT NULL DEFAULT 0, cleanup_after INTEGER NOT NULL DEFAULT 0,
        health_status TEXT NOT NULL DEFAULT 'unknown', last_physical_error TEXT NOT NULL DEFAULT '', repaired_at INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS disk_content_keys (
        content_key TEXT PRIMARY KEY, content_id TEXT NOT NULL REFERENCES disk_contents(id), generation TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS disk_content_revisions (
        content_id TEXT NOT NULL REFERENCES disk_contents(id), revision INTEGER NOT NULL, state TEXT NOT NULL,
        signature TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(content_id,revision)
    );
    CREATE INDEX IF NOT EXISTS disk_content_revision_signature ON disk_content_revisions(signature);
    CREATE TABLE IF NOT EXISTS disk_content_anchors (
        id TEXT PRIMARY KEY, content_id TEXT NOT NULL, revision INTEGER NOT NULL,
        channel_id TEXT NOT NULL, message_id INTEGER NOT NULL, role TEXT NOT NULL, payload TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'ACTIVE',
        FOREIGN KEY(content_id,revision) REFERENCES disk_content_revisions(content_id,revision)
    );
    CREATE INDEX IF NOT EXISTS disk_content_anchor_message ON disk_content_anchors(message_id);
    CREATE TABLE IF NOT EXISTS disk_content_parts (
        content_id TEXT NOT NULL, revision INTEGER NOT NULL, part_index INTEGER NOT NULL,
        selected_anchor_id TEXT REFERENCES disk_content_anchors(id), payload TEXT NOT NULL,
        PRIMARY KEY(content_id,revision,part_index),
        FOREIGN KEY(content_id,revision) REFERENCES disk_content_revisions(content_id,revision)
    );
    CREATE TABLE IF NOT EXISTS disk_content_refs (
        scope TEXT NOT NULL, logical_file_id TEXT NOT NULL, content_id TEXT NOT NULL REFERENCES disk_contents(id),
        content_version INTEGER NOT NULL, PRIMARY KEY(scope,logical_file_id),
        FOREIGN KEY(scope,logical_file_id) REFERENCES disk_files(scope,id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS disk_content_refs_content ON disk_content_refs(content_id);
    CREATE TABLE IF NOT EXISTS disk_content_leases (
        id TEXT PRIMARY KEY, content_id TEXT NOT NULL REFERENCES disk_contents(id), revision INTEGER,
        kind TEXT NOT NULL, viewer_id TEXT NOT NULL, upload_id TEXT NOT NULL, expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS disk_content_leases_content ON disk_content_leases(content_id,expires_at);
    CREATE TABLE IF NOT EXISTS disk_content_cleanup (
        id TEXT PRIMARY KEY, content_id TEXT REFERENCES disk_contents(id), revision INTEGER,
        purpose TEXT NOT NULL, state TEXT NOT NULL, token TEXT NOT NULL DEFAULT '',
        claimed_at INTEGER NOT NULL DEFAULT 0, retry_at INTEGER NOT NULL DEFAULT 0,
        attempts INTEGER NOT NULL DEFAULT 0, error TEXT NOT NULL DEFAULT '', payload TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS disk_content_pop_challenges (
        id TEXT PRIMARY KEY, content_id TEXT NOT NULL REFERENCES disk_contents(id), revision INTEGER NOT NULL,
        viewer_id TEXT NOT NULL, binding TEXT NOT NULL, expires_at INTEGER NOT NULL, consumed INTEGER NOT NULL DEFAULT 0,
        payload TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS disk_content_batches (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS disk_content_revoked_sessions (session TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS disk_content_claims (content_key TEXT PRIMARY KEY, token TEXT NOT NULL,
        viewer_id TEXT NOT NULL, binding TEXT NOT NULL, content_id TEXT NOT NULL, expires_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS disk_content_caption_jobs(id TEXT PRIMARY KEY,content_id TEXT NOT NULL REFERENCES disk_contents(id),
        revision INTEGER NOT NULL,state TEXT NOT NULL,token TEXT NOT NULL DEFAULT '',retry_at INTEGER NOT NULL DEFAULT 0,
        attempts INTEGER NOT NULL DEFAULT 0,payload TEXT NOT NULL,error TEXT NOT NULL DEFAULT '');
    CREATE TABLE IF NOT EXISTS disk_content_legacy_history(id TEXT PRIMARY KEY,content_id TEXT REFERENCES disk_contents(id),
        scope TEXT NOT NULL,logical_file_id TEXT NOT NULL,reason TEXT NOT NULL,payload TEXT NOT NULL);`);
    const columns=new Set(db.prepare('PRAGMA table_info(disk_contents)').all().map(row=>row.name));
    for(const [name,definition] of [['health_status',"TEXT NOT NULL DEFAULT 'unknown'"],['last_physical_error',"TEXT NOT NULL DEFAULT ''"],['repaired_at','INTEGER NOT NULL DEFAULT 0']])
        if(!columns.has(name))db.exec('ALTER TABLE disk_contents ADD COLUMN '+name+' '+definition);
}

function createContentRepository(withDatabase, { dataDir } = {}) {
    // The dictionary is a separate administrator-maintained file. Read its
    // latest revision for each cleanup/guard decision, including after a
    // running server changes the mapping. A bad dictionary fails closed.
    const chatDictionary = dataDir ? createTelegramChatDictionary({ dataDir }) : null;
    const chatAliases = () => {
        const aliases = new Map();
        for (const entry of chatDictionary?.list().entries || []) {
            for (const name of [entry.username, ...(entry.aliases || [])].filter(Boolean))
                aliases.set(normalizeChatIdentifier(name), entry.chatId);
        }
        return aliases;
    };
    const normalizedChat = (value, aliases) => {
        try {
            const identifier = normalizeChatIdentifier(value);
            return { value: aliases.get(identifier) || identifier, unresolved: identifier.startsWith('@') && !aliases.has(identifier) };
        } catch (_) { return { value: String(value), unresolved: true }; }
    };
    // Two differently written chat identifiers may name the same Telegram
    // message. Without a confirmed mapping, quarantine only the *matching
    // message ID*, rather than stopping cleanup for every numeric chat.
    function aliasConflict(db, physical, excludeContentId = '') {
        const aliases = chatAliases(), candidate = normalizedChat(physical.channelId, aliases);
        const entries = [...physicalRecord(physical).parts, ...(physical.thumbnail ? [physical.thumbnail] : [])];
        for (const part of entries) {
            const messageId = Number(part.messageId);
            if (!Number.isSafeInteger(messageId) || messageId <= 0) continue;
            const rows = db.prepare(`SELECT a.channel_id,c.id AS content_id FROM disk_content_anchors a
                JOIN disk_contents c ON c.id=a.content_id
                WHERE a.message_id=? AND a.channel_id!=? AND a.state!='CLEANED'
                AND c.id!=? AND (c.hash_status='anchor_conflict'
                  OR (a.revision=c.current_revision AND c.state IN ('READY','BROKEN','DELETE_PENDING'))
                  OR EXISTS(SELECT 1 FROM disk_content_refs r WHERE r.content_id=c.id AND a.revision=c.current_revision)
                  OR EXISTS(SELECT 1 FROM disk_content_leases l WHERE l.content_id=c.id AND l.revision=a.revision AND l.expires_at>?))`)
                .all(messageId, String(physical.channelId), String(excludeContentId), Date.now());
            for (const row of rows) {
                const other = normalizedChat(row.channel_id, aliases);
                if (candidate.value === other.value) return 'CONTENT_ANCHOR_ALIAS_CONFLICT';
                if (candidate.unresolved || other.unresolved) return 'CONTENT_ANCHOR_ALIAS_UNRESOLVED';
            }
        }
        return '';
    }
    const write = work => withDatabase(db => {
        if (db.isTransaction) {
            const result = work(db);
            if (result && typeof result.then === 'function') throw new Error('DISK_TRANSACTION_ASYNC');
            return result;
        }
        db.exec('BEGIN IMMEDIATE');
        try { const result = work(db); if(result && typeof result.then==='function')throw new Error('DISK_TRANSACTION_ASYNC'); db.exec('COMMIT'); return result; }
        catch (error) { if (db.isTransaction) db.exec('ROLLBACK'); throw error; }
    });
    const get = (db, id) => db.prepare('SELECT * FROM disk_contents WHERE id=?').get(id);
    const revision = (db, id, rev) => {
        const row = db.prepare('SELECT payload FROM disk_content_revisions WHERE content_id=? AND revision=?').get(id, rev);
        return row ? JSON.parse(row.payload) : null;
    };
    function queue(db, id, rev, purpose, physical) {
        const key = hash(JSON.stringify([id, rev, purpose, physical.channelId, physical.parts, physical.thumbnail]));
        db.prepare(`INSERT OR IGNORE INTO disk_content_cleanup(id,content_id,revision,purpose,state,payload)
            VALUES(?,?,?,?, 'PENDING',?)`).run(key, id || null, rev || null, purpose, JSON.stringify({ ...physical,
                name: id ? get(db,id)?.original_name || 'Telegram Content' : physical.name || 'Telegram Content' }));
    }
    function released(db, id, delay = 60_000) {
        if (!id || db.prepare('SELECT 1 FROM disk_content_refs WHERE content_id=? LIMIT 1').get(id)) return;
        const changed = db.prepare(`UPDATE disk_contents SET state='DELETE_PENDING',cleanup_after=?,state_version=state_version+1
            WHERE id=? AND state IN ('READY','BROKEN')`).run(Date.now() + delay, id).changes;
        // A lease protects existing readers/uploads, not discovery by a new
        // upload after the last Logical has been deleted.
        db.prepare('DELETE FROM disk_content_keys WHERE content_id=?').run(id);
        const item = get(db, id);
        if (item?.state === 'DELETE_PENDING') {
            queue(db, id, item.current_revision, 'unreferenced-content', revision(db, id, item.current_revision));
            if (changed) db.prepare("UPDATE disk_content_cleanup SET retry_at=? WHERE content_id=? AND revision=? AND purpose='unreferenced-content' AND state='PENDING'")
                .run(item.cleanup_after, id, item.current_revision);
        }
    }
    function create(db, file, wantedId) {
        const id = wantedId || crypto.randomUUID(), physical = physicalRecord(file);
        const key = contentKey(Number(file.size) === 0 ? hash('') : file.contentSha256, Number(file.size));
        const signature = representationSignature(file);
        if(key && Number(file.size)>0) {
            let end=0;
            for(const part of physical.parts){if(part.offset!==end || !Number.isSafeInteger(part.size) || part.size<=0 || !part.fileId || !Number.isSafeInteger(part.messageId) || part.messageId<=0)throw new Error('CONTENT_LAYOUT_INVALID');end+=part.size;}
            if(end!==Number(file.size))throw new Error('CONTENT_LAYOUT_INVALID');
        }
        // Legacy grouping is by the exact physical message set, never by filename,
        // size, file_unique_id or a hash of chunk hashes.
        if (!key) {
            const same = db.prepare(`SELECT c.id FROM disk_contents c JOIN disk_content_revisions r
                ON r.content_id=c.id AND r.revision=c.current_revision WHERE r.signature=? AND c.state='READY'
                AND EXISTS(SELECT 1 FROM disk_content_refs ref WHERE ref.content_id=c.id)`).get(signature);
            if (same) return same.id;
        } else {
            const same = db.prepare(`SELECT c.* FROM disk_content_keys k JOIN disk_contents c ON c.id=k.content_id
                WHERE k.content_key=? AND c.state='READY'
                AND EXISTS(SELECT 1 FROM disk_content_refs ref WHERE ref.content_id=c.id)`).get(key);
            if (same) {
                const currentPhysical=revision(db,same.id,same.current_revision);
                if(String(currentPhysical.backendId || '')!==String(physical.backendId || '')) {
                    // Physical storage isolation remains independent of the
                    // content-only key. Do not route a different bot to it.
                } else {
                if (db.prepare('SELECT signature FROM disk_content_revisions WHERE content_id=? AND revision=?').get(same.id, same.current_revision)?.signature !== signature)
                    queue(db, null, null, 'abandoned-candidate', physical);
                return same.id;
                }
            }
        }
        db.prepare(`INSERT INTO disk_contents(id,content_key,size,hash_status,state,original_name,original_mime,created_at)
            VALUES(?,?,?,?, 'READY',?,?,?)`).run(id, key || null, Number(file.size) || 0, key ? 'verified' : 'legacy_unverified', String(file.name || ''), String(file.type || ''), Date.now());
        saveRevision(db, id, 1, physical, signature,Boolean(key));
        if(key) db.prepare("DELETE FROM disk_content_keys WHERE content_key=? AND content_id IN (SELECT id FROM disk_contents WHERE state IN ('BROKEN','DELETE_PENDING','DELETING','DELETED'))").run(key);
        if (key) db.prepare('INSERT OR IGNORE INTO disk_content_keys(content_key,content_id,generation) VALUES(?,?,?)').run(key, id, crypto.randomUUID());
        return id;
    }
    function saveRevision(db, id, rev, physical, signature,captionWork=false) {
        db.prepare('INSERT INTO disk_content_revisions(content_id,revision,state,signature,payload) VALUES(?,?,\'ACTIVE\',?,?)')
            .run(id, rev, signature, JSON.stringify(physical));
        const insertAnchor = (part, role) => {
            if (!part?.messageId) return null;
            const key = anchorKey(physical.channelId, part.messageId);
            const existing = db.prepare('SELECT * FROM disk_content_anchors WHERE id=?').get(key);
            if (existing && existing.content_id !== id) {
                // Partial legacy overlaps are quarantined: neither representation
                // may be destructively collected until an operator resolves them.
                db.prepare('UPDATE disk_contents SET hash_status=\'anchor_conflict\' WHERE id IN (?,?)').run(id, existing.content_id);
                return key;
            }
            db.prepare('INSERT OR IGNORE INTO disk_content_anchors(id,content_id,revision,channel_id,message_id,role,payload) VALUES(?,?,?,?,?,?,?)')
                .run(key, id, rev, physical.channelId, Number(part.messageId), role, JSON.stringify(part));
            if(captionWork){
                const item=get(db,id), fields=['Telegram Content Object','content_id: '+id,'physical_revision: '+rev,
                    'content_key: '+item.content_key,'role: '+role,'channel_id: '+physical.channelId,'message_id: '+part.messageId,'file_id: '+part.fileId];
                if(role==='BODY')fields.push('part: '+part.partIndex+'/'+physical.parts.length,'offset: '+part.offset,'size: '+part.size);
                let caption=fields.join('\n');
                const blocked=caption.length>1024;
                if(!blocked)for(const field of [...(part.sha256?['part_sha256: '+part.sha256]:[]),'original_name: '+item.original_name.slice(0,180)]) {
                    const available=1024-caption.length-1;if(available<=0)break;
                    // Truncate optional display metadata, never actual IDs.
                    caption+='\n'+field.slice(0,available);
                }
                db.prepare('INSERT OR IGNORE INTO disk_content_caption_jobs(id,content_id,revision,state,payload,error) VALUES(?,?,?,?,?,?)')
                    .run(key,id,rev,blocked?'BLOCKED':'PENDING',JSON.stringify({backendId:physical.backendId,channelId:physical.channelId,messageId:part.messageId,caption}),blocked?'CONTENT_CAPTION_TOO_LONG':'');
            }
            return key;
        };
        for (const [index, part] of physical.parts.entries()) {
            const anchor = insertAnchor(part, 'BODY');
            db.prepare('INSERT INTO disk_content_parts(content_id,revision,part_index,selected_anchor_id,payload) VALUES(?,?,?,?,?)')
                .run(id, rev, index + 1, anchor, JSON.stringify(part));
        }
        insertAnchor(physical.thumbnail, 'THUMBNAIL');
    }
    function project(db, file, scope) {
        const ref = db.prepare('SELECT * FROM disk_content_refs WHERE scope=? AND logical_file_id=?').get(scope, file.id);
        if (!ref) return file;
        const content = get(db, ref.content_id), physical = revision(db, ref.content_id, content.current_revision);
        const parts = physical.parts.map((part, index) => ({ ...part, logicalFileId: file.id, partIndex: index + 1,
            partCount: physical.parts.length, originalSize: file.size }));
        const first = parts[0] || {};
        return { ...file, ...physical, parts, createdAt: file.createdAt, contentId: content.id, logicalContentVersion: ref.content_version,
            physicalRevision: content.current_revision, contentSha256: content.hash_status === 'verified' ? String(content.content_key || '').split(':').at(-1) : '',
            partCount: parts.length, fileId: first.fileId || '', fileUniqueId: first.fileUniqueId || '', messageId: first.messageId || 0,
            mediaGroupId: first.mediaGroupId || '', pendingRemoteCleanup: [], fileIdHistory: [], captionSyncPending: false,
            lastCheckedAt: content.last_checked_at, repairedAt:content.repaired_at,
            healthStatus:content.health_status, lastPhysicalError:content.last_physical_error };
    }
    // Called inside the repository's existing file + directory transaction.
    function syncFile(db, scope, file) {
        assertContentAuthorization(db,file.contentAuthorization);
        if(file.contentGrant) {
            // Recheck authorization inside the same write transaction as refs.
            // An in-memory member snapshot is not a cross-process write fence.
            const proof=file.contentGrant,row=db.prepare("SELECT payload FROM disk_collaborations WHERE scope='' AND id=?").get(proof.id);
            const grant=row ? JSON.parse(row.payload) : null,viewer=String(proof.viewerId),version=Number(grant?.memberVersions?.[viewer]) || 1;
            if(!grant || grant.active===false || grant.ownerId!==String(file.ownerId) || grant.diskSpace!==String(scope)
                || viewer!==grant.ownerId && !grant.members.includes(viewer) || String(version)!==String(proof.version))throw new Error('COLLABORATION_NOT_FOUND');
            if(grant.kind==='file' ? grant.fileId!==file.id : grant.path && file.folderPath!==grant.path && !String(file.folderPath).startsWith(grant.path+'/'))throw new Error('COLLABORATION_OUT_OF_SCOPE');
        }
        const before = db.prepare('SELECT * FROM disk_content_refs WHERE scope=? AND logical_file_id=?').get(scope, file.id);
        if (file.reviewStatus === 'deleted') {
            db.prepare('DELETE FROM disk_content_refs WHERE scope=? AND logical_file_id=?').run(scope, file.id);
            released(db, before?.content_id, 0); delete file.contentId; return;
        }
        let id = file.contentId, old = id ? get(db, id) : null;
        if (old?.state === 'DELETE_PENDING' && !file.contentLease) throw new Error('CONTENT_NOT_AVAILABLE');
        if(file.expectedContentId && (before?.content_id!==file.expectedContentId || before.content_version!==file.expectedContentVersion || old?.current_revision!==file.expectedPhysicalRevision)) throw new Error('CONTENT_WRITE_CONFLICT');
        if(file.contentClaimToken && !db.prepare('SELECT 1 FROM disk_content_claims WHERE token=? AND content_id=? AND expires_at>?').get(file.contentClaimToken,file.contentCandidateId,Date.now())) throw new Error('CONTENT_CLAIM_EXPIRED');
        if (file.contentLease) {
            const lease = db.prepare('SELECT * FROM disk_content_leases WHERE id=? AND content_id=? AND expires_at>?').get(file.contentLease, id, Date.now());
            if (!lease) throw new Error('CONTENT_LEASE_EXPIRED');
        }
        const signature = representationSignature(file);
        const same = old && db.prepare('SELECT signature FROM disk_content_revisions WHERE content_id=? AND revision=?').get(id, old.current_revision)?.signature === signature;
        if (!same) {
            if (file.contentPhysicalRepair && old) {
                if (old.hash_status !== 'verified' || contentKey(file.contentSha256, file.size) !== old.content_key) throw new Error('CONTENT_REPAIR_HASH_MISMATCH');
                const previous = revision(db, id, old.current_revision), next = old.current_revision + 1;
                saveRevision(db, id, next, physicalRecord(file), signature,true);
                db.prepare('UPDATE disk_content_revisions SET state=\'RETIRED\' WHERE content_id=? AND revision=?').run(id, old.current_revision);
                db.prepare("UPDATE disk_contents SET current_revision=?,state_version=state_version+1,health_status='available',last_physical_error='',repaired_at=? WHERE id=?").run(next, Date.now(), id);
                db.prepare("UPDATE disk_contents SET state='READY' WHERE id=? AND state='BROKEN'").run(id);
                queue(db, id, old.current_revision, 'retired-revision', previous);
            } else id = create(db, file, file.contentCandidateId);
        }
        const content = get(db, id);
        if (!['READY', 'DELETE_PENDING'].includes(content.state)) throw new Error('CONTENT_NOT_AVAILABLE');
        db.prepare('UPDATE disk_contents SET state=\'READY\',cleanup_after=0 WHERE id=? AND state=\'DELETE_PENDING\'').run(id);
        const version = before ? before.content_version + (before.content_id !== id ? 1 : 0) : 1;
        db.prepare(`INSERT INTO disk_content_refs(scope,logical_file_id,content_id,content_version) VALUES(?,?,?,?)
            ON CONFLICT(scope,logical_file_id) DO UPDATE SET content_id=excluded.content_id,content_version=excluded.content_version`).run(scope, file.id, id, version);
        // A previously acquired lease may finish an in-flight attach. Restore
        // discovery only if a newer generation has not already claimed the key.
        if (content.hash_status === 'verified' && content.content_key)
            db.prepare('INSERT OR IGNORE INTO disk_content_keys VALUES(?,?,?)').run(content.content_key,id,crypto.randomUUID());
        file.contentId = id; file.logicalContentVersion = version;
        if(!file.expectedContentId)for(const entry of file.fileIdHistory || []) {
            // Old history often lacks chat/backend/size. Preserve the original
            // record for audit without guessing a physical revision or deleting it.
            const payload=JSON.stringify(entry),key=hash(JSON.stringify([scope,file.id,payload]));
            db.prepare("INSERT OR IGNORE INTO disk_content_legacy_history VALUES(?,?,?,?,'unverified-legacy-history',?)").run(key,id,scope,file.id,payload);
        }
        if (before?.content_id !== id) released(db, before?.content_id);
        for (const stale of file.pendingRemoteCleanup || []) queue(db, null, null, stale.progressive ? 'temporary-upload' : 'legacy-debt', {
            ...physicalRecord(stale), ...(stale.progressive ? {operationId:stale.operationId || '',finalMessageIds:revision(db,id,get(db,id).current_revision).parts.map(part=>part.messageId)} : {})
        });
        file.pendingRemoteCleanup = []; file.captionSyncPending = false;
        if (file.contentLease) db.prepare('DELETE FROM disk_content_leases WHERE id=?').run(file.contentLease);
        if(file.contentClaimToken) db.prepare('DELETE FROM disk_content_claims WHERE token=?').run(file.contentClaimToken);
        delete file.contentLease; delete file.contentCandidateId; delete file.declaredSha256;
        delete file.contentClaimToken;
        delete file.expectedContentId;delete file.expectedContentVersion;delete file.expectedPhysicalRevision;
        delete file.contentPhysicalRepair;
        delete file.contentGrant;
        delete file.contentAuthorization;
    }
    return {
        project, syncFile,
        strip(file) { const result = { ...file }; for (const field of PHYSICAL_FIELDS) delete result[field]; for (const field of ['physicalRevision','contentPhysicalRepair','contentGrant','contentAuthorization','contentLease','contentCandidateId','declaredSha256','contentClaimToken','expectedContentId','expectedContentVersion','expectedPhysicalRevision']) delete result[field]; return result; },
        detach(db, scope, fileId) {
            const ref = db.prepare('SELECT content_id FROM disk_content_refs WHERE scope=? AND logical_file_id=?').get(scope, fileId);
            db.prepare('DELETE FROM disk_content_refs WHERE scope=? AND logical_file_id=?').run(scope, fileId); released(db, ref?.content_id, 0);
        },
        resolve(id) { return withDatabase(db => { const item = get(db, id); return item ? { ...item, physical: revision(db, id, item.current_revision) } : null; }); },
        find(sha, size) { return withDatabase(db => db.prepare(`SELECT c.id FROM disk_content_keys k JOIN disk_contents c ON c.id=k.content_id
            WHERE k.content_key=? AND c.state='READY' AND c.hash_status='verified'
            AND EXISTS(SELECT 1 FROM disk_content_refs r WHERE r.content_id=c.id)`).get(contentKey(sha, size))?.id || null); },
        setHealth(id,rev,valid,error=''){return write(db=>db.prepare(`UPDATE disk_contents SET last_checked_at=?,health_status=?,last_physical_error=?,
            state=CASE WHEN ?=0 AND state='READY' THEN 'BROKEN' ELSE state END
            WHERE id=? AND current_revision=? AND state IN ('READY','BROKEN','DELETE_PENDING')`).run(Date.now(),valid?'available':'unavailable',String(error).slice(0,240),valid?1:0,id,rev).changes===1);},
        owned(id, user) { return withDatabase(db => Boolean(db.prepare("SELECT 1 FROM disk_content_refs r JOIN disk_files f ON f.scope=r.scope AND f.id=r.logical_file_id WHERE r.content_id=? AND f.owner_id=? AND coalesce(json_extract(f.payload,'$.reviewStatus'),'') NOT IN ('blocked','deleted') LIMIT 1").get(id, user))); },
        verifyLegacy(id,sha,size,expectedRevision) { return write(db=>{
            const item=get(db,id);if(!item || !['READY','DELETE_PENDING','BROKEN'].includes(item.state) || item.current_revision!==expectedRevision || item.size!==size)throw new Error('CONTENT_WRITE_CONFLICT');
            const key=contentKey(sha,size);if(!key)throw new Error('CONTENT_KEY_INVALID');
            if(item.hash_status==='anchor_conflict')throw new Error('CONTENT_ANCHOR_CONFLICT');
            db.prepare("UPDATE disk_contents SET content_key=?,hash_status='verified' WHERE id=?").run(key,id);
            db.prepare("DELETE FROM disk_content_keys WHERE content_key=? AND content_id!=? AND content_id IN (SELECT id FROM disk_contents WHERE state IN ('BROKEN','DELETE_PENDING','DELETING','DELETED'))").run(key,id);
            if (item.state === 'READY' && db.prepare('SELECT 1 FROM disk_content_refs WHERE content_id=? LIMIT 1').get(id))
                db.prepare('INSERT OR IGNORE INTO disk_content_keys VALUES(?,?,?)').run(key,id,crypto.randomUUID());
        }); },
        mergeVerified(id, canonicalId, expectedRevision) { return write(db=>{
            if(id===canonicalId)return {merged:0};
            const source=get(db,id),target=get(db,canonicalId);
            if(!source || !target || source.current_revision!==expectedRevision || source.hash_status!=='verified' || target.hash_status!=='verified' || source.content_key!==target.content_key || !['READY','DELETE_PENDING'].includes(target.state))throw new Error('CONTENT_WRITE_CONFLICT');
            const sourcePhysical=revision(db,id,source.current_revision),targetPhysical=revision(db,canonicalId,target.current_revision);
            if(String(sourcePhysical.backendId)!==String(targetPhysical.backendId))throw new Error('CONTENT_BACKEND_MISMATCH');
            const refs=db.prepare('SELECT * FROM disk_content_refs WHERE content_id=?').all(id);
            for(const ref of refs){
                const row=db.prepare('SELECT payload FROM disk_files WHERE scope=? AND id=?').get(ref.scope,ref.logical_file_id);
                const file=JSON.parse(row.payload);file.contentId=canonicalId;
                file.__partsHash=representationSignature({...targetPhysical,size:target.size});
                db.prepare('UPDATE disk_files SET payload=? WHERE scope=? AND id=?').run(JSON.stringify(file),ref.scope,ref.logical_file_id);
            }
            db.prepare('UPDATE disk_content_refs SET content_id=? WHERE content_id=?').run(canonicalId,id);
            db.prepare("UPDATE disk_contents SET state='READY',cleanup_after=0 WHERE id=?").run(canonicalId);
            if (refs.length) db.prepare('INSERT OR IGNORE INTO disk_content_keys VALUES(?,?,?)').run(target.content_key,canonicalId,crypto.randomUUID());
            released(db,id);return {merged:refs.length};
        }); },
        lease(id, viewer, upload, kind = 'reuse', duration = 15 * 60_000) { return write(db => {
            const item = get(db, id); if (!item || !['READY', 'DELETE_PENDING'].includes(item.state)) throw new Error('CONTENT_NOT_AVAILABLE');
            if (['proof','verified-input'].includes(kind) && (item.state !== 'READY' || !db.prepare('SELECT 1 FROM disk_content_refs WHERE content_id=? LIMIT 1').get(id)))
                throw new Error('CONTENT_NOT_AVAILABLE');
            const token = crypto.randomUUID(); db.prepare('INSERT INTO disk_content_leases VALUES(?,?,?,?,?,?,?)').run(token,id,item.current_revision,kind,String(viewer),String(upload),Date.now()+duration); return token;
        }); },
        releaseLease(token) { return write(db => db.prepare('DELETE FROM disk_content_leases WHERE id=?').run(token)); },
        leasedPhysical(token) { return withDatabase(db=>{const row=db.prepare('SELECT * FROM disk_content_leases WHERE id=? AND expires_at>?').get(token,Date.now());if(!row)throw new Error('CONTENT_LEASE_EXPIRED');return {...revision(db,row.content_id,row.revision),physicalRevision:row.revision};}); },
        allowed(physical) { return withDatabase(db => allowed(db, physical)); },
        renewLease(token, duration = 15 * 60_000) { return write(db => db.prepare('UPDATE disk_content_leases SET expires_at=? WHERE id=? AND expires_at>?').run(Date.now()+duration,token,Date.now()).changes === 1); },
        batch(id) { return withDatabase(db => { const row=db.prepare('SELECT payload FROM disk_content_batches WHERE id=?').get(id); return row ? JSON.parse(row.payload) : null; }); },
        commitBatch(db, id, ids) { db.prepare('INSERT INTO disk_content_batches VALUES(?,?) ON CONFLICT(id) DO NOTHING').run(id, JSON.stringify(ids)); },
        enqueue(physical, purpose='rollback') { return write(db => queue(db,null,null,purpose,physicalRecord(physical))); },
        claimCleanup(now = Date.now(), contentId = '') { return write(db => {
            const rows = db.prepare(`SELECT * FROM disk_content_cleanup WHERE ((state='PENDING' AND retry_at<=?) OR (state='CLAIMED' AND claimed_at<?))
                ${contentId ? 'AND content_id=?' : ''} ORDER BY retry_at,rowid LIMIT 100`).all(now,now-10*60_000,...(contentId ? [contentId] : []));
            for (const row of rows) {
                // Protected/quarantined rows must not starve later cleanup work.
                db.prepare('UPDATE disk_content_cleanup SET retry_at=? WHERE id=?').run(now+60_000,row.id);
                const physical = JSON.parse(row.payload);
                const aliasError = aliasConflict(db,physical,row.purpose==='unreferenced-content' ? row.content_id : '');
                if (aliasError) {
                    // Fence an expired CLAIMED worker as well: a newly added
                    // dictionary mapping must not let its old token ack a
                    // cleanup that is now quarantined.
                    db.prepare("UPDATE disk_content_cleanup SET state='PENDING',token='',claimed_at=0,error=? WHERE id=?").run(aliasError,row.id);
                    continue;
                }
                if(row.purpose!=='unreferenced-content') {
                    physical.parts=physical.parts.filter(part=>allowed(db,{...physical,parts:[part],thumbnail:null}));
                    if(physical.thumbnail && !allowed(db,{...physical,parts:[],thumbnail:physical.thumbnail}))physical.thumbnail=null;
                }
                if (!/^-?\d+$/.test(physical.channelId) && (physical.parts.length || physical.thumbnail?.messageId)) continue;
                if (row.content_id) {
                    const item = get(db,row.content_id);
                    if (!item || item.hash_status === 'anchor_conflict') continue;
                    if (db.prepare('SELECT 1 FROM disk_content_leases WHERE content_id=? AND expires_at>? LIMIT 1').get(row.content_id,now)) continue;
                    if (row.purpose === 'unreferenced-content') {
                        if (!['DELETE_PENDING','DELETING'].includes(item.state) || item.cleanup_after>now || db.prepare('SELECT 1 FROM disk_content_refs WHERE content_id=? LIMIT 1').get(row.content_id)) continue;
                        db.prepare('UPDATE disk_contents SET state=\'DELETING\',state_version=state_version+1 WHERE id=?').run(row.content_id);
                        db.prepare('DELETE FROM disk_content_keys WHERE content_id=?').run(row.content_id);
                    } else if (row.revision === item.current_revision) continue;
                }
                if (!allowed(db,physical)) continue;
                const token=crypto.randomUUID(); db.prepare('UPDATE disk_content_cleanup SET state=\'CLAIMED\',token=?,claimed_at=?,attempts=attempts+1 WHERE id=?').run(token,now,row.id);
                return {...row,token,physical};
            }
            return null;
        }); },
        finishCleanup(task, error) { return write(db => {
            const current=db.prepare('SELECT * FROM disk_content_cleanup WHERE id=? AND token=? AND state=\'CLAIMED\'').get(task.id,task.token); if(!current)return;
            if(!error){
                const aliasError=aliasConflict(db,task.physical,task.purpose==='unreferenced-content' ? task.content_id : '');
                if(aliasError)error=new Error(aliasError);
            }
            db.prepare('UPDATE disk_content_cleanup SET state=?,retry_at=?,error=? WHERE id=? AND token=?').run(error?'PENDING':'COMPLETED',error?Date.now()+Math.min(3600_000,30_000*2**Math.min(current.attempts,7)):0,error?String(error.code||error.message).slice(0,240):'',task.id,task.token);
            if(!error && task.content_id){
                db.prepare("UPDATE disk_content_revisions SET state='CLEANED' WHERE content_id=? AND revision=?").run(task.content_id,task.revision);
                for(const part of [...task.physical.parts,...(task.physical.thumbnail ? [task.physical.thumbnail]:[])])
                    db.prepare("UPDATE disk_content_anchors SET state='CLEANED' WHERE content_id=? AND id=?").run(task.content_id,anchorKey(task.physical.channelId,part.messageId));
                if(task.purpose==='unreferenced-content')db.prepare('UPDATE disk_contents SET state=\'DELETED\' WHERE id=? AND state=\'DELETING\'').run(task.content_id);
            }
        }); },
        references(id) { return withDatabase(db=>db.prepare('SELECT scope,logical_file_id FROM disk_content_refs WHERE content_id=?').all(id)); },
        usesChannel(channelId) { return withDatabase(db => {
            const chat=String(channelId);
            const aliases=chatAliases(), target=normalizedChat(chat,aliases).value;
            // A removed Logical row can still leave a retained revision, reader,
            // or retryable remote cleanup. Keep its backend available until done.
            const inUse=db.prepare(`SELECT DISTINCT json_extract(v.payload,'$.channelId') AS channel FROM disk_content_revisions v
                JOIN disk_contents c ON c.id=v.content_id WHERE v.state!='CLEANED'
                AND (c.state!='DELETED' OR EXISTS(SELECT 1 FROM disk_content_leases l
                    WHERE l.content_id=c.id AND l.revision=v.revision AND l.expires_at>?))`).all(Date.now());
            const cleanup=db.prepare("SELECT DISTINCT json_extract(payload,'$.channelId') AS channel FROM disk_content_cleanup WHERE state!='COMPLETED'").all();
            return [...inUse,...cleanup].some(row=>normalizedChat(row.channel,aliases).value===target);
        }); },
        claimCaption(){return write(db=>{
            const row=db.prepare(`SELECT j.* FROM disk_content_caption_jobs j JOIN disk_contents c ON c.id=j.content_id
                WHERE j.state IN ('PENDING','CLAIMED') AND j.retry_at<=? AND c.state='READY' AND j.revision=c.current_revision ORDER BY j.retry_at LIMIT 1`).get(Date.now());
            if(!row)return null;const token=crypto.randomUUID();
            db.prepare("UPDATE disk_content_caption_jobs SET state='CLAIMED',token=?,retry_at=?,attempts=attempts+1 WHERE id=?").run(token,Date.now()+600_000,row.id);
            db.prepare('INSERT INTO disk_content_leases VALUES(?,?,?,?,?,?,?)').run(token,row.content_id,row.revision,'caption','','',Date.now()+600_000);
            return {...row,token,physical:JSON.parse(row.payload)};
        });},
        finishCaption(task,error){return write(db=>{
            db.prepare("UPDATE disk_content_caption_jobs SET state=?,retry_at=?,error=? WHERE id=? AND token=?").run(error?'PENDING':'COMPLETED',error?Date.now()+Math.min(3600_000,30_000*2**Math.min(task.attempts+1,7)):0,error?String(error.code || error.message).slice(0,240):'',task.id,task.token);
            db.prepare('DELETE FROM disk_content_leases WHERE id=?').run(task.token);
        });},
        withDatabase, write
    };
    function allowed(db, physical) {
            if(aliasConflict(db,physical))return false;
            const entries = [...physicalRecord(physical).parts, ...(physical.thumbnail ? [physical.thumbnail] : [])];
            return entries.every(part => !db.prepare(`SELECT 1 FROM disk_content_parts p JOIN disk_contents c ON c.id=p.content_id
                WHERE p.selected_anchor_id=? AND (c.hash_status='anchor_conflict' OR (p.revision=c.current_revision AND c.state IN ('READY','BROKEN','DELETE_PENDING')) OR EXISTS(SELECT 1 FROM disk_content_refs r WHERE r.content_id=c.id AND p.revision=c.current_revision)
                OR EXISTS(SELECT 1 FROM disk_content_leases l WHERE l.content_id=c.id AND l.revision=p.revision AND l.expires_at>${Date.now()})) LIMIT 1`).get(anchorKey(physical.channelId, part.messageId))
                && !db.prepare(`SELECT 1 FROM disk_content_revisions v JOIN disk_contents c ON c.id=v.content_id
                    WHERE json_extract(v.payload,'$.channelId')=? AND json_extract(v.payload,'$.thumbnail.messageId')=?
                    AND (c.hash_status='anchor_conflict' OR (v.revision=c.current_revision AND c.state IN ('READY','BROKEN','DELETE_PENDING')) OR EXISTS(SELECT 1 FROM disk_content_refs r WHERE r.content_id=c.id AND v.revision=c.current_revision)
                    OR EXISTS(SELECT 1 FROM disk_content_leases l WHERE l.content_id=c.id AND l.revision=v.revision AND l.expires_at>${Date.now()})) LIMIT 1`).get(String(physical.channelId),Number(part.messageId) || 0));
    }
}
module.exports={migrateContentSchema,createContentRepository,physicalRecord,contentKey,representationSignature,assertContentAuthorization};
