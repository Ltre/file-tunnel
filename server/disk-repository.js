'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync, backup } = require('node:sqlite');
const { migrateContentSchema, createContentRepository, representationSignature } = require('./disk-content-repository');

function transaction(connection, work, write = false) {
    connection.exec(write ? 'BEGIN IMMEDIATE' : 'BEGIN');
    try {
        const result = work();
        connection.exec('COMMIT');
        return result;
    } catch (error) {
        if (connection.isTransaction) connection.exec('ROLLBACK');
        throw error;
    }
}

// The domain stores deal in records. SQL, WAL and transaction boundaries stay here.
const TABLES = new Set([
    'files', 'directories', 'users', 'apps', 'backends', 'tokens',
    'spaces', 'space_usage', 'shares', 'operations', 'chunk_ids',
    'cache_owners', 'collaborations', 'placeholders', 'static_resources'
]);
const connections = new Map();

function openDiskRepository(dataDir) {
    const root = path.resolve(dataDir);
    if (connections.has(root)) return connections.get(root);
    fs.mkdirSync(root, { recursive: true });
    const filename = path.join(root, 'disk.sqlite');
    if (process.platform !== 'win32') {
        const handle = fs.openSync(filename, 'a', 0o600);
        fs.closeSync(handle);
        fs.chmodSync(filename, 0o600);
    }
    const db = new DatabaseSync(filename);
    try {
        db.exec('PRAGMA journal_mode = WAL');
        db.exec('PRAGMA foreign_keys = ON');
        db.exec('PRAGMA busy_timeout = 5000');
        db.exec('PRAGMA synchronous = FULL');
        db.exec('CREATE TABLE IF NOT EXISTS disk_schema_migrations (version INTEGER PRIMARY KEY)');
        const schemaVersion = Number(db.prepare('SELECT MAX(version) AS version FROM disk_schema_migrations').get().version) || 0;
        if (schemaVersion > 2) throw new Error('DISK_SCHEMA_TOO_NEW');
        if (schemaVersion === 1) {
            const destination = path.join(root, `disk-before-content-${Date.now()}-${crypto.randomUUID()}.sqlite`);
            db.prepare('VACUUM INTO ?').run(destination);
        }
        for (const table of TABLES) {
            db.exec(`CREATE TABLE IF NOT EXISTS disk_${table} (
            scope TEXT NOT NULL DEFAULT '', id TEXT NOT NULL,
            owner_id TEXT NOT NULL DEFAULT '', folder_path TEXT NOT NULL DEFAULT '',
            name TEXT NOT NULL DEFAULT '', payload TEXT NOT NULL,
            PRIMARY KEY (scope, id)
        );
        CREATE INDEX IF NOT EXISTS disk_${table}_owner_path ON disk_${table}(scope, owner_id, folder_path);`);
        }
        db.exec(`CREATE TABLE IF NOT EXISTS disk_file_parts (
        scope TEXT NOT NULL, file_id TEXT NOT NULL, part_index INTEGER NOT NULL,
        payload TEXT NOT NULL, PRIMARY KEY (scope, file_id, part_index),
        FOREIGN KEY (scope, file_id) REFERENCES disk_files(scope, id) ON DELETE CASCADE
    );`);
        db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS disk_files_owner_name ON disk_files(scope, owner_id, folder_path, name);
        CREATE UNIQUE INDEX IF NOT EXISTS disk_users_username ON disk_users(lower(json_extract(payload, '$.username')))
        WHERE json_extract(payload, '$.username') IS NOT NULL AND json_extract(payload, '$.username') != '';
        CREATE UNIQUE INDEX IF NOT EXISTS disk_users_telegram_provider ON disk_users(json_extract(payload, '$.telegramId'), json_extract(payload, '$.provider'))
        WHERE json_extract(payload, '$.telegramId') IS NOT NULL AND json_extract(payload, '$.telegramId') != '';
        CREATE UNIQUE INDEX IF NOT EXISTS disk_shares_token ON disk_shares(json_extract(payload, '$.token'));
        CREATE UNIQUE INDEX IF NOT EXISTS disk_backends_fingerprint ON disk_backends(json_extract(payload, '$.fingerprint'));`);
        db.exec('INSERT OR IGNORE INTO disk_schema_migrations(version) VALUES (1)');
        transaction(db, () => {
            migrateContentSchema(db);
            const content = createContentRepository(work => work(db), { dataDir: root });
            // Import only real logical records. Bot archives are a separate store.
            for (const row of db.prepare('SELECT scope,id,payload FROM disk_files').all()) {
                if (db.prepare('SELECT 1 FROM disk_content_refs WHERE scope=? AND logical_file_id=?').get(row.scope,row.id)) continue;
                const file = JSON.parse(row.payload);
                if (file.reviewStatus === 'deleted') continue;
                file.parts = db.prepare('SELECT payload FROM disk_file_parts WHERE scope=? AND file_id=? ORDER BY part_index').all(row.scope,row.id).map(part=>JSON.parse(part.payload));
                content.syncFile(db,row.scope,file);
                const payload=content.strip(file); delete payload.__partsHash;
                payload.__partsHash=representationSignature(file);
                db.prepare('UPDATE disk_files SET payload=? WHERE scope=? AND id=?').run(JSON.stringify(payload),row.scope,row.id);
            }
            db.exec('INSERT OR IGNORE INTO disk_schema_migrations(version) VALUES(2)');
        }, true);
    } finally { db.close(); }

    let activeConnection = null;
    function withDatabase(work) {
        if (activeConnection) return work(activeConnection);
        const connection = new DatabaseSync(filename);
        connection.exec('PRAGMA foreign_keys = ON');
        connection.exec('PRAGMA busy_timeout = 5000');
        connection.exec('PRAGMA synchronous = FULL');
        try { return work(connection); }
        finally { connection.close(); }
    }

    function statementsFor(connection, table) {
        if (!TABLES.has(table)) throw new Error('DISK_TABLE_INVALID');
        return {
            all: connection.prepare(`SELECT id, payload FROM disk_${table} WHERE scope = ?`),
            put: connection.prepare(`INSERT INTO disk_${table}(scope,id,owner_id,folder_path,name,payload)
                VALUES (?,?,?,?,?,?) ON CONFLICT(scope,id) DO UPDATE SET
                owner_id=excluded.owner_id, folder_path=excluded.folder_path,
                name=excluded.name, payload=excluded.payload`),
            remove: connection.prepare(`DELETE FROM disk_${table} WHERE scope = ? AND id = ?`)
        };
    }
    const content = createContentRepository(withDatabase, { dataDir: root });
    function loadWithRevision(table, scope = '') {
        return withDatabase(connection => {
            const read = () => {
                const rows = statementsFor(connection, table).all.all(String(scope));
                const revisions = new Map(rows.map(row => [row.id, row.payload]));
                if (table !== 'files') return { items: rows.map(row => JSON.parse(row.payload)), revisions };
                const parts = connection.prepare('SELECT file_id, payload FROM disk_file_parts WHERE scope = ? ORDER BY file_id, part_index').all(String(scope));
                const grouped = new Map();
                for (const part of parts) {
                    if (!grouped.has(part.file_id)) grouped.set(part.file_id, []);
                    grouped.get(part.file_id).push(JSON.parse(part.payload));
                }
                const items = rows.map(row => {
                    const file = JSON.parse(row.payload);
                    delete file.__partsHash;
                    return content.project(connection, { ...file, parts: grouped.get(row.id) || [] }, String(scope));
                });
                return { items, revisions };
            };
            return activeConnection ? read() : transaction(connection, read);
        });
    }
    const load = (table, scope = '') => loadWithRevision(table, scope).items;
    function encodePayload(table, item) {
        const payload = table === 'files' ? content.strip(item) : { ...item };
        if (table === 'files') {
            delete payload.parts;
            payload.__partsHash = representationSignature(item);
        }
        return JSON.stringify(payload);
    }
    function replaceInside(connection, table, scope, items, keyOf, base) {
        const sql = statementsFor(connection, table);
        const existing = base ? null : new Map(sql.all.all(scope).map(row => [row.id, row.payload]));
        const getCurrent = base ? connection.prepare(`SELECT payload FROM disk_${table} WHERE scope = ? AND id = ?`) : null;
        const seen = new Set();
        for (const item of items) {
            const rawId = keyOf(item);
            if (rawId === undefined || rawId === null || rawId === '') throw new Error('DISK_RECORD_KEY_INVALID');
            const id = String(rawId);
            if (seen.has(id)) throw new Error('DISK_RECORD_KEY_INVALID');
            seen.add(id);
            let encoded = encodePayload(table, item);
            if (base?.get(id) === encoded) continue;
            const previousPayload = base ? getCurrent.get(scope, id)?.payload : existing.get(id);
            if (base) {
                if (base.get(id) !== previousPayload) throw new Error('DISK_WRITE_CONFLICT');
            }
            if (previousPayload !== encoded) sql.put.run(scope, id, String(item.ownerId || item.userId || ''),
                String(item.folderPath || item.path || ''), String(item.name || ''), encoded);
            if (table === 'files' && previousPayload !== encoded) {
                content.syncFile(connection,scope,item);
                const projected=content.project(connection,item,scope);
                Object.assign(item,projected);
                encoded=encodePayload(table,item);
                sql.put.run(scope,id,String(item.ownerId || ''),String(item.folderPath || ''),String(item.name || ''),encoded);
            }
            if (table === 'files' && !item.contentId && previousPayload !== encoded && (!previousPayload || JSON.parse(previousPayload).__partsHash !== JSON.parse(encoded).__partsHash)) {
                const previous = connection.prepare('SELECT part_index, payload FROM disk_file_parts WHERE scope = ? AND file_id = ?').all(scope, id);
                const oldParts = new Map(previous.map(row => [row.part_index, row.payload]));
                const parts = Array.isArray(item.parts) ? item.parts : [];
                const putPart = connection.prepare('INSERT INTO disk_file_parts(scope,file_id,part_index,payload) VALUES (?,?,?,?) ON CONFLICT(scope,file_id,part_index) DO UPDATE SET payload=excluded.payload');
                const removePart = connection.prepare('DELETE FROM disk_file_parts WHERE scope = ? AND file_id = ? AND part_index = ?');
                for (let index = 0; index < parts.length; index++) {
                    const value = JSON.stringify(parts[index]);
                    if (oldParts.get(index) !== value) putPart.run(scope, id, index, value);
                    oldParts.delete(index);
                }
                for (const index of oldParts.keys()) removePart.run(scope, id, index);
            }
        }
        for (const id of base ? base.keys() : existing.keys()) if (!seen.has(id)) {
            if (base && getCurrent.get(scope, id)?.payload !== base.get(id)) throw new Error('DISK_WRITE_CONFLICT');
            if(table === 'files') content.detach(connection,scope,id);
            sql.remove.run(scope, id);
        }
    }
    const replaceTransaction = (changes, batch) => withDatabase(connection => {
        const write = () => {
            for (const change of changes) replaceInside(connection, change.table, String(change.scope || ''), change.items, change.keyOf, change.base);
            if(batch) content.commitBatch(connection,batch.id,batch.ids);
        };
        return activeConnection ? write() : transaction(connection, write, true);
    });
    function replaceMany(changes, batch) {
        replaceTransaction(changes, batch);
        for (const change of changes) if (change.base) {
            change.base.clear();
            for (const item of change.items) change.base.set(String(change.keyOf(item)), encodePayload(change.table, item));
        }
    }
    const repository = {
        load,
        loadWithRevision,
        replace(table, items, keyOf, scope = '') { replaceMany([{ table, items, keyOf, scope }]); },
        replaceMany,
        atomic(work, onRollback) {
            if (activeConnection) throw new Error('DISK_TRANSACTION_NESTED');
            try {
                return withDatabase(connection => transaction(connection, () => {
                    activeConnection = connection;
                    try {
                        const result = work();
                        if (result && typeof result.then === 'function') throw new Error('DISK_TRANSACTION_ASYNC');
                        return result;
                    }
                    finally { activeConnection = null; }
                }, true));
            } catch (error) {
                try { onRollback?.(); }
                catch (reloadError) { if (error && typeof error === 'object') error.reloadError = reloadError; }
                throw error;
            }
        },
        checkpoint() { return withDatabase(connection => connection.prepare('PRAGMA wal_checkpoint(PASSIVE)').all()); },
        assertIntegrity() {
            return withDatabase(connection => {
                const result = connection.prepare('PRAGMA integrity_check').all();
                if (result.length !== 1 || result[0].integrity_check !== 'ok') throw new Error('DISK_SQLITE_INTEGRITY_FAILED');
                if (connection.prepare('PRAGMA foreign_key_check').all().length) throw new Error('DISK_SQLITE_FOREIGN_KEY_FAILED');
            });
        },
        async backup(destination) {
            const connection = new DatabaseSync(filename);
            try { await backup(connection, destination); }
            finally { connection.close(); }
        },
        close() { connections.delete(root); },
        filename
        ,content,
        projectFile(file, scope='') { return withDatabase(db=>content.project(db,file,String(scope))); },
        projectFiles(files, scope='') { return withDatabase(db=>files.map(file=>content.project(db,file,String(scope)))); },
        commitUploadBatch(id, ids) { if(!activeConnection) throw new Error('CONTENT_BATCH_REQUIRES_TRANSACTION'); content.commitBatch(activeConnection,id,ids); }
    };
    connections.set(root, repository);
    return repository;
}

module.exports = { openDiskRepository };
