'use strict';

// Read-only diagnostics. No Telegram calls, cleanup claims or reference writes.
function createContentAdmin(content) {
    const states = new Set(['READY', 'BROKEN', 'DELETE_PENDING', 'DELETING', 'DELETED']);
    const cleanupFields = 'id,content_id,revision,purpose,state,attempts,claimed_at,retry_at,error';
    function snapshot(work) {
        return content.withDatabase(db => {
            const own = !db.isTransaction;
            if (own) db.exec('BEGIN');
            try { const result = work(db); if (own) db.exec('COMMIT'); return result; }
            catch (error) { if (own && db.isTransaction) db.exec('ROLLBACK'); throw error; }
        });
    }
    function page(query, fallback = 50) {
        const limit = Number(query.limit ?? fallback), offset = Number(query.offset ?? 0);
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(offset) || offset < 0)
            throw Error('CONTENT_QUERY_INVALID');
        return { limit, offset };
    }
    function location(file) {
        if (file.trash_id) return null;
        const query = new URLSearchParams({ user_id: file.owner_id, disk_space: file.scope, path: file.folder_path, file_id: file.logical_file_id });
        return '/disk-management?' + query;
    }
    function identity(db, id) {
        return db.prepare(`SELECT id,json_extract(payload,'$.name') AS name,json_extract(payload,'$.username') AS username,
            json_extract(payload,'$.telegramId') AS telegramId,json_extract(payload,'$.provider') AS provider
            FROM disk_users WHERE scope='' AND id=?`).get(id) || { id, name: '历史用户' };
    }
    function positions(db, rows) {
        const users = new Map();
        return rows.map(row => {
            if (!users.has(row.owner_id)) users.set(row.owner_id, identity(db, row.owner_id));
            return { ...row, user: users.get(row.owner_id), full_path: '/' + [row.folder_path, row.name].filter(Boolean).join('/'), location_url: location(row) };
        });
    }
    const fileFields = `f.scope,f.id AS logical_file_id,f.owner_id,coalesce(json_extract(f.payload,'$.trashOriginalPath'),f.folder_path) AS folder_path,coalesce(json_extract(f.payload,'$.trashOriginalName'),f.name) AS name,json_extract(f.payload,'$.trashId') AS trash_id,
        json_extract(f.payload,'$.size') AS size,json_extract(f.payload,'$.type') AS type,
        coalesce(json_extract(f.payload,'$.reviewStatus'),'active') AS review_status,
        coalesce(json_extract(f.payload,'$.sourceAppId'),'') AS source_app_id,
        json_extract(f.payload,'$.deletedContentId') AS deleted_content_id`;
    function detail(id) {
        return snapshot(db => {
            const item = db.prepare('SELECT * FROM disk_contents WHERE id=?').get(id);
            if (!item) throw Error('CONTENT_NOT_FOUND');
            const revisions = db.prepare('SELECT revision,state,payload FROM disk_content_revisions WHERE content_id=? ORDER BY revision').all(id)
                .map(row => ({ ...row, payload: JSON.parse(row.payload) }));
            return {
                content: { ...item, physical: revisions.find(row => row.revision === item.current_revision)?.payload || null },
                references: positions(db, db.prepare(`SELECT ${fileFields},r.content_version FROM disk_content_refs r
                    JOIN disk_files f ON f.scope=r.scope AND f.id=r.logical_file_id WHERE r.content_id=?
                    ORDER BY f.owner_id,f.scope,f.folder_path,f.name,f.id`).all(id)),
                revisions,
                anchors: db.prepare('SELECT channel_id,message_id,revision,role,state FROM disk_content_anchors WHERE content_id=?').all(id),
                leases: db.prepare('SELECT revision,kind,viewer_id,upload_id,expires_at FROM disk_content_leases WHERE content_id=? AND expires_at>?').all(id, Date.now()),
                cleanup: db.prepare(`SELECT ${cleanupFields} FROM disk_content_cleanup WHERE content_id=? ORDER BY rowid DESC`).all(id)
            };
        });
    }
    function list(query = {}) {
        const selected = query.state ? [...new Set(String(query.state).split(','))] : [];
        if (selected.some(state => !states.has(state))) throw Error('CONTENT_QUERY_INVALID');
        const paged = Boolean(selected.length || query.limit !== undefined || query.offset !== undefined), paging = page(query);
        return snapshot(db => {
            const where = selected.length ? `WHERE c.state IN (${selected.map(() => '?').join(',')})` : '';
            const contents = db.prepare(`SELECT c.*,
                (SELECT count(*) FROM disk_content_refs r WHERE r.content_id=c.id) AS reference_count,
                (SELECT count(*) FROM disk_content_leases l WHERE l.content_id=c.id AND l.expires_at>?) AS active_leases
                FROM disk_contents c ${where} ORDER BY c.created_at DESC,c.id ${paged ? 'LIMIT ? OFFSET ?' : ''}`)
                .all(Date.now(), ...selected, ...(paged ? [paging.limit, paging.offset] : []));
            const ids = contents.map(item => item.id), filter = paged ? ` AND content_id IN (${ids.map(() => '?').join(',') || 'NULL'})` : '';
            return {
                contents,
                cleanup: db.prepare(`SELECT ${cleanupFields} FROM disk_content_cleanup WHERE state!='COMPLETED'${filter}`).all(...(paged ? ids : [])),
                captions: db.prepare(`SELECT content_id,revision,state,attempts,retry_at,error FROM disk_content_caption_jobs WHERE state!='COMPLETED'${filter}`).all(...(paged ? ids : [])),
                total: db.prepare(`SELECT count(*) AS n FROM disk_contents c ${where}`).get(...selected).n,
                counts: Object.fromEntries(db.prepare('SELECT state,count(*) AS n FROM disk_contents GROUP BY state').all().map(row => [row.state, row.n])),
                ...(paged ? paging : {})
            };
        });
    }
    function files(query = {}) {
        const q = String(query.q || '').trim(), paging = page(query, 30);
        if (!q || q.length > 256) throw Error('CONTENT_QUERY_INVALID');
        return snapshot(db => {
            const where = "WHERE f.id=? OR instr(lower(f.name),lower(?))>0";
            return {
                files: positions(db, db.prepare(`SELECT ${fileFields},coalesce(r.content_id,json_extract(f.payload,'$.deletedContentId')) AS content_id,c.state AS content_state,
                    (SELECT count(*) FROM disk_content_refs ref WHERE ref.content_id=coalesce(r.content_id,json_extract(f.payload,'$.deletedContentId'))) AS reference_count
                    FROM disk_files f LEFT JOIN disk_content_refs r ON r.scope=f.scope AND r.logical_file_id=f.id
                    LEFT JOIN disk_contents c ON c.id=coalesce(r.content_id,json_extract(f.payload,'$.deletedContentId')) ${where}
                    ORDER BY CASE WHEN f.id=? THEN 0 ELSE 1 END,f.name,f.owner_id,f.scope,f.id LIMIT ? OFFSET ?`)
                    .all(q, q, q, paging.limit, paging.offset)),
                total: db.prepare(`SELECT count(*) AS n FROM disk_files f ${where}`).get(q, q).n,
                ...paging
            };
        });
    }
    function byHash(sha256, size) {
        if (!/^[a-f0-9]{64}$/.test(String(sha256)) || !Number.isSafeInteger(size) || size < 0) throw Error('CONTENT_QUERY_INVALID');
        return snapshot(db => db.prepare(`SELECT id FROM disk_contents WHERE content_key=? AND hash_status='verified'
            AND EXISTS(SELECT 1 FROM disk_content_refs r WHERE r.content_id=disk_contents.id) ORDER BY created_at,id`)
            .all(`sha256:v1:${size}:${sha256}`).map(row => detail(row.id)));
    }
    return { list, detail, files, byHash };
}
module.exports = { createContentAdmin };
