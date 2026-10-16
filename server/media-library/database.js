'use strict';
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const KINDS = new Set(['config', 'grant', 'import', 'session', 'batch', 'result', 'compression', 'collection', 'entity', 'relation', 'job', 'cache', 'event']);
function createMediaDatabase(dataDir, now = Date.now) {
    fs.mkdirSync(dataDir, { recursive: true });
    const db = new DatabaseSync(path.join(dataDir, 'media-library.sqlite'));
    db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;');
    db.exec('BEGIN IMMEDIATE');
    try {
    const version = db.prepare('PRAGMA user_version').get().user_version;
    if (version > 2) throw Error('MEDIA_DATABASE_NEWER');
    if (version === 1) {
        db.exec(`CREATE TABLE media_documents_v2 (id TEXT NOT NULL, kind TEXT NOT NULL, scope TEXT NOT NULL,
            version INTEGER NOT NULL DEFAULT 1, data TEXT NOT NULL CHECK(json_valid(data)), created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
            PRIMARY KEY(kind,scope,id));
            INSERT INTO media_documents_v2 SELECT * FROM media_documents;
            DROP TABLE media_documents; ALTER TABLE media_documents_v2 RENAME TO media_documents;`);
    }
    db.exec(`CREATE TABLE IF NOT EXISTS media_documents (
        id TEXT NOT NULL, kind TEXT NOT NULL, scope TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1, data TEXT NOT NULL CHECK(json_valid(data)),
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY(kind,scope,id));
        CREATE INDEX IF NOT EXISTS media_documents_kind_scope ON media_documents(kind,scope,created_at);
        CREATE INDEX IF NOT EXISTS media_documents_state ON media_documents(kind,scope,json_extract(data,'$.state'),created_at);
        CREATE INDEX IF NOT EXISTS media_cache_root ON media_documents(scope,json_extract(data,'$.root')) WHERE kind='cache';
        CREATE INDEX IF NOT EXISTS media_cache_kind ON media_documents(scope,json_extract(data,'$.kind')) WHERE kind='cache';
        CREATE INDEX IF NOT EXISTS media_frame_time ON media_documents(scope,json_extract(data,'$.importId'),json_extract(data,'$.actualMs')) WHERE kind='result';
        CREATE UNIQUE INDEX IF NOT EXISTS media_import_source ON media_documents(scope,json_extract(data,'$.sourceKey')) WHERE kind='import';
        CREATE UNIQUE INDEX IF NOT EXISTS media_collection_result ON media_documents(scope,json_extract(data,'$.resultId')) WHERE kind='collection';
        CREATE UNIQUE INDEX IF NOT EXISTS media_collection_compression ON media_documents(scope,json_extract(data,'$.compressionId')) WHERE kind='collection' AND json_extract(data,'$.state')!='deleted';
        CREATE UNIQUE INDEX IF NOT EXISTS media_entity_name ON media_documents(scope,json_extract(data,'$.entityKind'),json_extract(data,'$.normalizedName')) WHERE kind='entity';
        PRAGMA user_version=2;`);
    db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); db.close(); throw error; }
    let depth = 0;
    function atomic(work) {
        if (depth) return work();
        db.exec('BEGIN IMMEDIATE'); depth++;
        try { const value = work(); if (value?.then) throw Error('MEDIA_ASYNC_TRANSACTION'); db.exec('COMMIT'); return value; }
        catch (error) { db.exec('ROLLBACK'); throw error; } finally { depth--; }
    }
    const decode = row => row ? { ...JSON.parse(row.data), id: row.id, scope: row.scope, version: row.version, createdAt: row.created_at, updatedAt: row.updated_at } : null;
    function get(kind, id, scope) {
        if (!KINDS.has(kind)) throw Error('MEDIA_RECORD_INVALID');
        return decode(db.prepare('SELECT * FROM media_documents WHERE kind=? AND id=? AND scope=?').get(kind, String(id), String(scope)));
    }
    function list(kind, scope, { limit = 1000, offset = 0 } = {}) {
        if (!KINDS.has(kind)) throw Error('MEDIA_RECORD_INVALID');
        return db.prepare('SELECT * FROM media_documents WHERE kind=? AND scope=? ORDER BY created_at DESC,id LIMIT ? OFFSET ?')
            .all(kind, String(scope), Math.max(1, Math.min(10000, Number(limit) || 1000)), Math.max(0, Number(offset) || 0)).map(decode);
    }
    function create(kind, scope, data, id = crypto.randomUUID()) {
        if (!KINDS.has(kind)) throw Error('MEDIA_RECORD_INVALID');
        const time = now(); db.prepare('INSERT INTO media_documents VALUES(?,?,?,1,?,?,?)').run(id, kind, String(scope), JSON.stringify(data), time, time);
        return get(kind, id, scope);
    }
    function patch(kind, id, scope, change, expectedVersion) {
        return atomic(() => {
            const item = get(kind, id, scope); if (!item) throw Error('MEDIA_RECORD_NOT_FOUND');
            if (expectedVersion !== undefined && item.version !== Number(expectedVersion)) throw Error('MEDIA_VERSION_CONFLICT');
            const next = typeof change === 'function' ? change(item) : { ...item, ...change };
            if (db.prepare('UPDATE media_documents SET data=?,version=version+1,updated_at=? WHERE kind=? AND scope=? AND id=? AND version=?').run(JSON.stringify(next), now(), kind, scope, id, item.version).changes !== 1) throw Error('MEDIA_VERSION_CONFLICT');
            return get(kind, id, scope);
        });
    }
    return { get, list, create, patch, atomic,
        frameDuplicates(scope, importId, actualMs) { return db.prepare("SELECT id FROM media_documents WHERE kind='result' AND scope=? AND json_extract(data,'$.importId')=? AND json_extract(data,'$.actualMs')=?")
            .all(scope, importId, actualMs).map(row => row.id); },
        matching(kind, scope, field, value) {
            if (!KINDS.has(kind) || !/^[a-zA-Z][a-zA-Z0-9]{0,50}$/.test(field)) throw Error('MEDIA_RECORD_INVALID');
            return db.prepare('SELECT * FROM media_documents WHERE kind=? AND scope=? AND json_extract(data,?)=? ORDER BY created_at,id')
                .all(kind, String(scope), '$.' + field, value).map(decode);
        },
        remove(kind, id, scope) { return db.prepare('DELETE FROM media_documents WHERE kind=? AND id=? AND scope=?').run(kind, id, scope).changes; },
        scopes() { return db.prepare("SELECT DISTINCT scope FROM media_documents WHERE kind IN ('job','import','cache')").all().map(row => row.scope); },
        clipSessions() { return db.prepare("SELECT DISTINCT scope,json_extract(data,'$.sessionId') AS sessionId FROM media_documents WHERE kind='result' AND json_extract(data,'$.kind')='clip' AND json_extract(data,'$.sessionId') IS NOT NULL").all(); },
        event(scope, message, level = 'info', relatedId = '') { return create('event', scope, { message: String(message).slice(0, 600), level, relatedId }); },
        close() { db.close(); }, path: path.join(dataDir, 'media-library.sqlite') };
}
module.exports = { createMediaDatabase };
