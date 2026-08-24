const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const initSqlJs = require('sql.js');

async function createInfraStore({ dataDir }) {
    fs.mkdirSync(dataDir, { recursive: true });
    const dbPath = path.join(dataDir, 'infra.sqlite');
    const wasmPath = require.resolve('sql.js/dist/sql-wasm.wasm');
    const SQL = await initSqlJs({
        locateFile: file => file === 'sql-wasm.wasm' ? wasmPath : file
    });
    const db = fs.existsSync(dbPath)
        ? new SQL.Database(fs.readFileSync(dbPath))
        : new SQL.Database();
    const store = new InfraStore(db, dbPath);
    store.migrate();
    store.save();
    return store;
}

class InfraStore {
    constructor(db, dbPath) {
        this.db = db;
        this.dbPath = dbPath;
        this.saveRetryTimer = null;
        this.lastSaveError = null;
    }

    migrate() {
        this.db.run(`
            PRAGMA foreign_keys = ON;
            CREATE TABLE IF NOT EXISTS tunnels (
                session_id TEXT PRIMARY KEY,
                short_code TEXT UNIQUE,
                created_at INTEGER NOT NULL,
                last_activity INTEGER NOT NULL,
                remark TEXT,
                owner_device_id TEXT,
                permissions_json TEXT,
                deleted_at INTEGER
            );
            CREATE TABLE IF NOT EXISTS devices (
                device_id TEXT PRIMARY KEY,
                session_id TEXT,
                device_name TEXT,
                device_model TEXT,
                local_ip TEXT,
                external_ip TEXT,
                ip TEXT,
                socket_id TEXT,
                user_agent TEXT,
                first_seen INTEGER NOT NULL,
                last_access INTEGER NOT NULL,
                online INTEGER NOT NULL DEFAULT 0,
                active INTEGER NOT NULL DEFAULT 0
            );
            CREATE TABLE IF NOT EXISTS tunnel_members (
                session_id TEXT NOT NULL,
                device_id TEXT NOT NULL,
                device_name TEXT,
                device_type TEXT,
                first_seen INTEGER NOT NULL,
                last_seen INTEGER NOT NULL,
                PRIMARY KEY (session_id, device_id)
            );
            CREATE TABLE IF NOT EXISTS transfer_records (
                session_id TEXT NOT NULL,
                message_id TEXT NOT NULL,
                message_type TEXT NOT NULL,
                sender_device_id TEXT,
                source TEXT,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                payload_json TEXT NOT NULL,
                deleted_at INTEGER,
                PRIMARY KEY (session_id, message_id)
            );
            CREATE TABLE IF NOT EXISTS transfer_files (
                session_id TEXT NOT NULL,
                message_id TEXT NOT NULL,
                file_id TEXT NOT NULL,
                file_name TEXT,
                mime_type TEXT,
                file_size INTEGER NOT NULL DEFAULT 0,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                removed_at INTEGER,
                PRIMARY KEY (session_id, message_id, file_id)
            );
            CREATE TABLE IF NOT EXISTS file_assets (
                session_id TEXT NOT NULL,
                file_id TEXT NOT NULL,
                file_name TEXT,
                mime_type TEXT,
                file_size INTEGER NOT NULL DEFAULT 0,
                source_device_id TEXT,
                metadata_json TEXT NOT NULL DEFAULT '{}',
                first_seen INTEGER NOT NULL,
                last_seen INTEGER NOT NULL,
                removed_at INTEGER,
                PRIMARY KEY (session_id, file_id)
            );
            CREATE TABLE IF NOT EXISTS asset_transfer_events (
                session_id TEXT NOT NULL,
                event_id TEXT NOT NULL,
                event_type TEXT NOT NULL,
                file_id TEXT NOT NULL,
                file_name TEXT,
                mime_type TEXT,
                declared_size INTEGER NOT NULL DEFAULT 0,
                bytes_transferred INTEGER NOT NULL DEFAULT 0,
                source_device_id TEXT,
                target_device_id TEXT,
                transfer_id TEXT,
                request_id TEXT,
                transport TEXT,
                occurred_at INTEGER NOT NULL,
                details_json TEXT NOT NULL DEFAULT '{}',
                PRIMARY KEY (session_id, event_id)
            );
            CREATE TABLE IF NOT EXISTS vclient_tunnels (
                session_id TEXT PRIMARY KEY,
                desired_enabled INTEGER NOT NULL DEFAULT 0,
                desired_updated_at INTEGER NOT NULL,
                state TEXT NOT NULL DEFAULT 'disabled',
                status_detail TEXT,
                last_error TEXT,
                instance_id TEXT,
                device_id TEXT,
                heartbeat_at INTEGER,
                cached_files INTEGER NOT NULL DEFAULT 0,
                cached_bytes INTEGER NOT NULL DEFAULT 0,
                last_sync_at INTEGER,
                started_at INTEGER,
                stopped_at INTEGER,
                updated_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS vclient_asset_states (
                session_id TEXT NOT NULL,
                file_id TEXT NOT NULL,
                state TEXT NOT NULL,
                bytes_cached INTEGER NOT NULL DEFAULT 0,
                bytes_total INTEGER NOT NULL DEFAULT 0,
                cache_path TEXT,
                error TEXT,
                started_at INTEGER,
                updated_at INTEGER NOT NULL,
                completed_at INTEGER,
                PRIMARY KEY (session_id, file_id)
            );
            CREATE INDEX IF NOT EXISTS idx_tunnels_short_code ON tunnels(short_code);
            CREATE INDEX IF NOT EXISTS idx_devices_session_id ON devices(session_id);
            CREATE INDEX IF NOT EXISTS idx_devices_last_access ON devices(last_access);
            CREATE INDEX IF NOT EXISTS idx_tunnel_members_session_id ON tunnel_members(session_id);
            CREATE INDEX IF NOT EXISTS idx_transfer_records_session_created ON transfer_records(session_id, created_at DESC);
            CREATE INDEX IF NOT EXISTS idx_transfer_records_deleted ON transfer_records(session_id, deleted_at);
            CREATE INDEX IF NOT EXISTS idx_transfer_files_session_file ON transfer_files(session_id, file_id);
            CREATE INDEX IF NOT EXISTS idx_transfer_files_message ON transfer_files(session_id, message_id);
            CREATE INDEX IF NOT EXISTS idx_file_assets_session ON file_assets(session_id, removed_at);
            CREATE INDEX IF NOT EXISTS idx_asset_transfer_events_session_time ON asset_transfer_events(session_id, occurred_at DESC);
            CREATE INDEX IF NOT EXISTS idx_asset_transfer_events_session_file ON asset_transfer_events(session_id, file_id);
            CREATE INDEX IF NOT EXISTS idx_vclient_tunnels_desired ON vclient_tunnels(desired_enabled, updated_at DESC);
            CREATE INDEX IF NOT EXISTS idx_vclient_assets_session_state ON vclient_asset_states(session_id, state, updated_at DESC);
        `);
        try {
            this.db.run('ALTER TABLE tunnels ADD COLUMN remark TEXT');
        } catch (_) {
            // Existing databases already have this column after the first migration.
        }
        try {
            this.db.run('ALTER TABLE tunnels ADD COLUMN owner_device_id TEXT');
        } catch (_) {
            // Existing databases already have this column after the first migration.
        }
        try {
            this.db.run('ALTER TABLE tunnels ADD COLUMN permissions_json TEXT');
        } catch (_) {
            // Existing databases already have this column after the first migration.
        }
        for (const column of [
            'cached_files INTEGER NOT NULL DEFAULT 0',
            'cached_bytes INTEGER NOT NULL DEFAULT 0',
            'last_sync_at INTEGER'
        ]) {
            try {
                this.db.run(`ALTER TABLE vclient_tunnels ADD COLUMN ${column}`);
            } catch (_) {
                // The additive VClient migration may already include this column.
            }
        }
        // Older versions only tracked the most recently joined tunnel on devices.
        // Preserve every usable legacy row as the initial historical-member baseline.
        this.db.run(`
            INSERT OR IGNORE INTO tunnel_members (
                session_id, device_id, device_name, device_type, first_seen, last_seen
            )
            SELECT session_id, device_id, COALESCE(device_name, ''), 'browser',
                   first_seen, MAX(first_seen, last_access)
            FROM devices
            WHERE session_id IS NOT NULL AND TRIM(session_id) <> ''
              AND device_id IS NOT NULL AND TRIM(device_id) <> ''
        `);
        // A persisted "online" bit cannot survive a server restart. New joins will
        // mark the currently connected devices online again.
        this.db.run('UPDATE devices SET online = 0, active = 0 WHERE online <> 0 OR active <> 0');
    }

    save() {
        try {
            const bytes = Buffer.from(this.db.export());
            this.writeDatabaseFile(bytes);
            this.lastSaveError = null;
            return true;
        } catch (err) {
            this.lastSaveError = err;
            console.error('Failed to persist SQLite infra store:', err);
            this.scheduleSaveRetry();
            return false;
        }
    }

    writeDatabaseFile(bytes) {
        const suffix = `${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}`;
        const tempPath = `${this.dbPath}.${suffix}.tmp`;
        fs.writeFileSync(tempPath, bytes);
        try {
            fs.renameSync(tempPath, this.dbPath);
        } catch (err) {
            if (process.platform === 'win32' && ['EPERM', 'EACCES', 'EBUSY'].includes(err.code)) {
                try {
                    fs.copyFileSync(tempPath, this.dbPath);
                    try {
                        fs.unlinkSync(tempPath);
                    } catch {
                        // Windows may keep the temp handle briefly; the persisted copy is already valid.
                    }
                    return;
                } catch (copyErr) {
                    try {
                        fs.unlinkSync(tempPath);
                    } catch {
                        // Ignore cleanup errors; the next successful save writes a fresh temp file.
                    }
                    throw copyErr;
                }
            }
            try {
                fs.unlinkSync(tempPath);
            } catch {
                // Ignore cleanup errors; the next successful save writes a fresh temp file.
            }
            throw err;
        }
    }

    scheduleSaveRetry() {
        if (this.saveRetryTimer) return;
        this.saveRetryTimer = setTimeout(() => {
            this.saveRetryTimer = null;
            this.save();
        }, 1000);
        this.saveRetryTimer.unref?.();
    }

    run(sql, params = []) {
        this.db.run(sql, params);
    }

    query(sql, params = []) {
        const statement = this.db.prepare(sql, params);
        const rows = [];
        try {
            while (statement.step()) rows.push(statement.getAsObject());
        } finally {
            statement.free();
        }
        return rows;
    }

    get(sql, params = []) {
        return this.query(sql, params)[0] || null;
    }

    findSessionIdByShortCode(shortCode) {
        const row = this.get(
            'SELECT session_id FROM tunnels WHERE short_code = ? AND deleted_at IS NULL',
            [shortCode]
        );
        return row?.session_id || '';
    }

    findShortCodeForSession(sessionId) {
        const row = this.get(
            'SELECT short_code FROM tunnels WHERE session_id = ? AND deleted_at IS NULL',
            [sessionId]
        );
        return row?.short_code || '';
    }

    reserveShortCode(shortCode, sessionId, now = Date.now()) {
        const existingSession = this.findSessionIdByShortCode(shortCode);
        if (existingSession && existingSession !== sessionId) return '';

        const existingCode = this.findShortCodeForSession(sessionId);
        if (existingCode && existingCode !== shortCode) return '';

        this.run(`
            INSERT INTO tunnels (session_id, short_code, created_at, last_activity, deleted_at)
            VALUES (?, ?, ?, ?, NULL)
            ON CONFLICT(session_id) DO UPDATE SET
                short_code = COALESCE(tunnels.short_code, excluded.short_code),
                last_activity = MAX(tunnels.last_activity, excluded.last_activity),
                deleted_at = NULL
        `, [sessionId, shortCode, now, now]);
        this.save();
        return shortCode;
    }

    touchTunnel(sessionId, { shortCode = '', createdAt = Date.now(), lastActivity = Date.now() } = {}) {
        this.touchTunnelRow(sessionId, { shortCode, createdAt, lastActivity });
        this.save();
    }

    touchTunnelRow(sessionId, { shortCode = '', createdAt = Date.now(), lastActivity = Date.now() } = {}) {
        this.run(`
            INSERT INTO tunnels (session_id, short_code, created_at, last_activity, deleted_at)
            VALUES (?, NULLIF(?, ''), ?, ?, NULL)
            ON CONFLICT(session_id) DO UPDATE SET
                short_code = COALESCE(tunnels.short_code, NULLIF(excluded.short_code, '')),
                created_at = MIN(tunnels.created_at, excluded.created_at),
                last_activity = MAX(tunnels.last_activity, excluded.last_activity)
        `, [sessionId, shortCode, createdAt, lastActivity]);
    }

    getTunnel(sessionId) {
        return this.get(
            'SELECT session_id, short_code, created_at, last_activity, remark, owner_device_id, permissions_json FROM tunnels WHERE session_id = ? AND deleted_at IS NULL',
            [sessionId]
        );
    }

    setTunnelAccess(sessionId, ownerDeviceId = '', permissions = {}, lastActivity = Date.now(), admins = {}) {
        const now = Date.now();
        this.run(`
            INSERT INTO tunnels (session_id, short_code, created_at, last_activity, owner_device_id, permissions_json, deleted_at)
            VALUES (?, NULL, ?, ?, ?, ?, NULL)
            ON CONFLICT(session_id) DO UPDATE SET
                owner_device_id = COALESCE(NULLIF(tunnels.owner_device_id, ''), excluded.owner_device_id),
                permissions_json = excluded.permissions_json,
                last_activity = MAX(tunnels.last_activity, excluded.last_activity)
        `, [sessionId, now, lastActivity || now, ownerDeviceId, JSON.stringify({ permissions: permissions || {}, admins: admins || {} })]);
        this.save();
    }

    setTunnelRemark(sessionId, remark = '', lastActivity = Date.now()) {
        const now = Date.now();
        this.run(`
            INSERT INTO tunnels (session_id, short_code, created_at, last_activity, remark, deleted_at)
            VALUES (?, NULL, ?, ?, ?, NULL)
            ON CONFLICT(session_id) DO UPDATE SET
                remark = excluded.remark,
                last_activity = MAX(tunnels.last_activity, excluded.last_activity)
        `, [sessionId, now, lastActivity || now, remark]);
        this.save();
    }

    deleteTunnel(sessionId) {
        const now = Date.now();
        this.run('BEGIN');
        try {
            this.run(
                'UPDATE tunnels SET deleted_at = COALESCE(deleted_at, ?), short_code = NULL WHERE session_id = ?',
                [now, sessionId]
            );
            this.run(`
                UPDATE vclient_tunnels
                SET desired_enabled = 0, desired_updated_at = ?, state = 'stopping', updated_at = ?
                WHERE session_id = ?
            `, [now, now, sessionId]);
            this.run('COMMIT');
        } catch (err) {
            this.run('ROLLBACK');
            throw err;
        }
        this.save();
    }

    deleteShortCode(shortCode) {
        this.run('UPDATE tunnels SET short_code = NULL WHERE short_code = ?', [shortCode]);
        this.save();
    }

    listTunnels() {
        return this.query(`
            SELECT session_id, short_code, created_at, last_activity, remark
            FROM tunnels
            WHERE deleted_at IS NULL
            ORDER BY last_activity DESC
        `);
    }

    recordTunnelMember(sessionId, member = {}, now = Date.now()) {
        const deviceId = String(member.deviceId || member.device_id || '').trim();
        if (!sessionId || !deviceId) return { inserted: false, reason: 'invalid-member' };
        const seenAt = normalizeTimestamp(member.lastSeen || member.last_seen, now);
        const existed = Boolean(this.get(
            'SELECT 1 AS found FROM tunnel_members WHERE session_id = ? AND device_id = ?',
            [sessionId, deviceId]
        ));
        this.run('BEGIN');
        try {
            this.touchTunnelRow(sessionId, { createdAt: seenAt, lastActivity: seenAt });
            this.run(`
                INSERT INTO tunnel_members (
                    session_id, device_id, device_name, device_type, first_seen, last_seen
                ) VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(session_id, device_id) DO UPDATE SET
                    device_name = CASE WHEN excluded.device_name <> '' THEN excluded.device_name ELSE tunnel_members.device_name END,
                    device_type = CASE WHEN excluded.device_type <> '' THEN excluded.device_type ELSE tunnel_members.device_type END,
                    first_seen = MIN(tunnel_members.first_seen, excluded.first_seen),
                    last_seen = MAX(tunnel_members.last_seen, excluded.last_seen)
            `, [
                sessionId,
                deviceId,
                String(member.deviceName || member.device_name || ''),
                String(member.deviceType || member.device_type || member.clientType || member.client_type || ''),
                normalizeTimestamp(member.firstSeen || member.first_seen, seenAt),
                seenAt
            ]);
            this.run('COMMIT');
        } catch (err) {
            this.run('ROLLBACK');
            throw err;
        }
        this.save();
        return { inserted: !existed };
    }

    recordHistoryMessage(sessionId, message, options = {}) {
        const messageId = String(message?.id || message?.messageId || message?.message_id || '').trim();
        if (!sessionId || !messageId || !message || typeof message !== 'object') {
            return { inserted: false, updated: false, fileCount: 0, totalFileSize: 0, reason: 'invalid-message' };
        }
        const now = normalizeTimestamp(options.now, Date.now());
        const createdAt = normalizeTimestamp(message.timestamp || message.createdAt || message.created_at, now);
        const previous = this.get(
            'SELECT deleted_at FROM transfer_records WHERE session_id = ? AND message_id = ?',
            [sessionId, messageId]
        );
        const files = extractTransferFiles(message, options.fileAssets).map(file => {
            if (file.name && file.type && file.size > 0) return file;
            const known = this.getFileAsset(sessionId, file.fileId);
            return known ? {
                ...file,
                name: file.name || known.file_name || '',
                type: file.type || known.mime_type || '',
                size: Math.max(file.size, normalizeFileSize(known.file_size))
            } : file;
        });
        const fileIds = new Set(files.map(file => file.fileId));
        const payloadJson = safeJsonStringify(message, '{}');

        this.run('BEGIN');
        try {
            this.touchTunnelRow(sessionId, { createdAt, lastActivity: now });
            this.run(`
                INSERT INTO transfer_records (
                    session_id, message_id, message_type, sender_device_id, source,
                    created_at, updated_at, payload_json, deleted_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)
                ON CONFLICT(session_id, message_id) DO UPDATE SET
                    message_type = excluded.message_type,
                    sender_device_id = CASE WHEN excluded.sender_device_id <> '' THEN excluded.sender_device_id ELSE transfer_records.sender_device_id END,
                    source = CASE WHEN excluded.source <> '' THEN excluded.source ELSE transfer_records.source END,
                    created_at = MIN(transfer_records.created_at, excluded.created_at),
                    updated_at = MAX(transfer_records.updated_at, excluded.updated_at),
                    payload_json = excluded.payload_json
            `, [
                sessionId,
                messageId,
                String(message.type || 'unknown'),
                String(message.sender || message.senderDeviceId || message.sender_device_id || ''),
                String(options.source || message.source || ''),
                createdAt,
                now,
                payloadJson
            ]);

            const existingFiles = this.query(
                'SELECT file_id FROM transfer_files WHERE session_id = ? AND message_id = ?',
                [sessionId, messageId]
            );
            for (const existing of existingFiles) {
                if (fileIds.has(existing.file_id)) continue;
                this.run(`
                    UPDATE transfer_files
                    SET removed_at = COALESCE(removed_at, ?), updated_at = MAX(updated_at, ?)
                    WHERE session_id = ? AND message_id = ? AND file_id = ?
                `, [now, now, sessionId, messageId, existing.file_id]);
            }
            for (const file of files) {
                this.run(`
                    INSERT INTO transfer_files (
                        session_id, message_id, file_id, file_name, mime_type, file_size,
                        created_at, updated_at, removed_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)
                    ON CONFLICT(session_id, message_id, file_id) DO UPDATE SET
                        file_name = CASE WHEN excluded.file_name <> '' THEN excluded.file_name ELSE transfer_files.file_name END,
                        mime_type = CASE WHEN excluded.mime_type <> '' THEN excluded.mime_type ELSE transfer_files.mime_type END,
                        file_size = MAX(transfer_files.file_size, excluded.file_size),
                        updated_at = MAX(transfer_files.updated_at, excluded.updated_at),
                        removed_at = NULL
                `, [
                    sessionId, messageId, file.fileId, file.name, file.type, file.size,
                    createdAt, now
                ]);
                this.recordFileAssetRow(sessionId, {
                    id: file.fileId,
                    name: file.name,
                    type: file.type,
                    size: file.size,
                    assetKind: file.assetKind || 'file'
                }, { now, sourceDeviceId: message.sender || '' });
            }
            this.run('COMMIT');
        } catch (err) {
            this.run('ROLLBACK');
            throw err;
        }
        this.save();
        return {
            inserted: !previous,
            updated: Boolean(previous),
            fileCount: files.length,
            totalFileSize: files.reduce((sum, file) => sum + file.size, 0),
            deleted: Boolean(previous?.deleted_at)
        };
    }

    markHistoryDeleted(sessionId, messageId, deletedAt = Date.now()) {
        if (!sessionId || !messageId) return false;
        const existing = this.get(
            'SELECT 1 AS found FROM transfer_records WHERE session_id = ? AND message_id = ?',
            [sessionId, messageId]
        );
        // Do not let a forged delete create a record that never existed. Current
        // messages are persisted before their delete event is accepted.
        if (!existing) return false;
        const when = normalizeTimestamp(deletedAt, Date.now());
        this.run('BEGIN');
        try {
            this.touchTunnelRow(sessionId, { createdAt: when, lastActivity: when });
            this.run(`
                UPDATE transfer_records
                SET deleted_at = COALESCE(deleted_at, ?), updated_at = MAX(updated_at, ?)
                WHERE session_id = ? AND message_id = ?
            `, [when, when, sessionId, messageId]);
            this.run(`
                UPDATE transfer_files
                SET removed_at = COALESCE(removed_at, ?), updated_at = MAX(updated_at, ?)
                WHERE session_id = ? AND message_id = ?
            `, [when, when, sessionId, messageId]);
            this.run('COMMIT');
        } catch (err) {
            this.run('ROLLBACK');
            throw err;
        }
        this.save();
        return true;
    }

    listHistoryRecords(sessionId, { includeDeleted = false, limit = 1000, offset = 0 } = {}) {
        const rows = this.query(`
            SELECT * FROM (
                SELECT session_id, message_id, message_type, sender_device_id, source,
                       created_at, updated_at, payload_json, deleted_at
                FROM transfer_records
                WHERE session_id = ? ${includeDeleted ? '' : 'AND deleted_at IS NULL'}
                ORDER BY created_at DESC, message_id DESC
                LIMIT ? OFFSET ?
            ) recent_records
            ORDER BY created_at ASC, message_id ASC
        `, [sessionId, clampLimit(limit, 1000, 5000), nonNegativeInteger(offset)]);
        return rows.map(hydrateTransferRecord);
    }

    listDeletedHistoryIds(sessionId, { since = 0, limit = 1000 } = {}) {
        return this.query(`
            SELECT message_id, deleted_at
            FROM transfer_records
            WHERE session_id = ? AND deleted_at IS NOT NULL AND deleted_at >= ?
            ORDER BY deleted_at DESC, message_id DESC
            LIMIT ?
        `, [sessionId, nonNegativeInteger(since), clampLimit(limit, 1000, 5000)])
            .map(row => row.message_id);
    }

    hydrateTunnelHistory(sessionId, { limit = 1000 } = {}) {
        const records = this.listHistoryRecords(sessionId, { includeDeleted: false, limit });
        return {
            messages: records.map(record => record.message).filter(Boolean),
            deletedMessageIds: this.listDeletedHistoryIds(sessionId, { limit })
        };
    }

    listTunnelsWithStats({ includeDeleted = false, limit = 2000, offset = 0 } = {}) {
        return this.query(`
            SELECT
                t.session_id,
                t.short_code,
                t.created_at,
                t.last_activity,
                t.remark,
                t.deleted_at,
                COALESCE(active_devices.count, 0) AS active_device_count,
                COALESCE(members.count, 0) AS historical_device_count,
                COALESCE(members.real_count, 0) AS historical_real_device_count,
                COALESCE(members.vclient_count, 0) AS historical_vclient_device_count,
                COALESCE(records.count, 0) AS transfer_record_count,
                COALESCE(files.file_reference_count, 0) AS transfer_file_count,
                COALESCE(files.unique_file_count, 0) AS unique_file_count,
                COALESCE(files.total_file_size, 0) AS total_file_size
            FROM tunnels t
            LEFT JOIN (
                SELECT session_id, COUNT(*) AS count FROM devices
                WHERE online = 1 AND active = 1 GROUP BY session_id
            ) active_devices ON active_devices.session_id = t.session_id
            LEFT JOIN (
                SELECT session_id,
                       COUNT(*) AS count,
                       SUM(CASE WHEN LOWER(COALESCE(device_type, '')) = 'vclient' THEN 0 ELSE 1 END) AS real_count,
                       SUM(CASE WHEN LOWER(COALESCE(device_type, '')) = 'vclient' THEN 1 ELSE 0 END) AS vclient_count
                FROM tunnel_members GROUP BY session_id
            ) members ON members.session_id = t.session_id
            LEFT JOIN (
                SELECT session_id, SUM(count) AS count
                FROM (
                    SELECT session_id, COUNT(*) AS count
                    FROM transfer_records GROUP BY session_id
                    UNION ALL
                    SELECT fa.session_id, COUNT(*) AS count
                    FROM file_assets fa
                    WHERE NOT EXISTS (
                        SELECT 1 FROM transfer_files tf
                        WHERE tf.session_id = fa.session_id AND tf.file_id = fa.file_id
                    )
                    GROUP BY fa.session_id
                ) record_sources
                GROUP BY session_id
            ) records ON records.session_id = t.session_id
            LEFT JOIN (
                SELECT session_id,
                       SUM(reference_count) AS file_reference_count,
                       COUNT(*) AS unique_file_count,
                       SUM(file_size) AS total_file_size
                FROM (
                    SELECT session_id, file_id, SUM(reference_count) AS reference_count,
                           MAX(file_size) AS file_size
                    FROM (
                        SELECT session_id, file_id, COUNT(*) AS reference_count, MAX(file_size) AS file_size
                        FROM transfer_files GROUP BY session_id, file_id
                        UNION ALL
                        SELECT fa.session_id, fa.file_id, 1 AS reference_count, fa.file_size
                        FROM file_assets fa
                        WHERE NOT EXISTS (
                            SELECT 1 FROM transfer_files tf
                            WHERE tf.session_id = fa.session_id AND tf.file_id = fa.file_id
                        )
                    ) file_sources
                    GROUP BY session_id, file_id
                ) unique_files
                GROUP BY session_id
            ) files ON files.session_id = t.session_id
            WHERE ${includeDeleted ? '1 = 1' : 't.deleted_at IS NULL'}
            ORDER BY t.last_activity DESC
            LIMIT ? OFFSET ?
        `, [clampLimit(limit, 2000, 10000), nonNegativeInteger(offset)]);
    }

    listTransferRecords(sessionId, { includeDeleted = true, limit = 100, offset = 0 } = {}) {
        const safeLimit = clampLimit(limit, 100, 1000);
        const safeOffset = nonNegativeInteger(offset);
        const deletedFilter = includeDeleted ? '' : 'AND tr.deleted_at IS NULL';
        const removedFilter = includeDeleted ? '' : 'AND fa.removed_at IS NULL';
        const total = Number(this.get(`
            SELECT SUM(count) AS count
            FROM (
                SELECT COUNT(*) AS count FROM transfer_records tr
                WHERE tr.session_id = ? ${deletedFilter}
                UNION ALL
                SELECT COUNT(*) AS count FROM file_assets fa
                WHERE fa.session_id = ? ${removedFilter}
                  AND NOT EXISTS (
                      SELECT 1 FROM transfer_files tf
                      WHERE tf.session_id = fa.session_id AND tf.file_id = fa.file_id
                  )
            ) combined_counts
        `, [sessionId, sessionId])?.count || 0);
        const rows = this.query(`
            SELECT * FROM (
                SELECT tr.session_id, tr.message_id, tr.message_type, tr.sender_device_id,
                       tr.source, tr.created_at, tr.updated_at, tr.payload_json, tr.deleted_at,
                       COUNT(tf.file_id) AS file_count,
                       COALESCE(SUM(tf.file_size), 0) AS total_file_size,
                       COALESCE(SUM(CASE WHEN tf.file_id IS NOT NULL AND tf.removed_at IS NULL THEN 1 ELSE 0 END), 0) AS active_file_count,
                       COALESCE(SUM(CASE WHEN tf.removed_at IS NULL THEN tf.file_size ELSE 0 END), 0) AS active_total_file_size,
                       NULL AS direct_file_id, NULL AS direct_file_name, NULL AS direct_mime_type,
                       NULL AS direct_metadata_json
                FROM transfer_records tr
                LEFT JOIN transfer_files tf
                  ON tf.session_id = tr.session_id AND tf.message_id = tr.message_id
                WHERE tr.session_id = ? ${deletedFilter}
                GROUP BY tr.session_id, tr.message_id
                UNION ALL
                SELECT fa.session_id, 'direct-file:' || fa.file_id, 'file', fa.source_device_id,
                       'direct-file-asset', fa.first_seen, fa.last_seen, NULL, fa.removed_at,
                       1, fa.file_size, CASE WHEN fa.removed_at IS NULL THEN 1 ELSE 0 END,
                       CASE WHEN fa.removed_at IS NULL THEN fa.file_size ELSE 0 END,
                       fa.file_id, fa.file_name, fa.mime_type, fa.metadata_json
                FROM file_assets fa
                WHERE fa.session_id = ? ${removedFilter}
                  AND NOT EXISTS (
                      SELECT 1 FROM transfer_files tf
                      WHERE tf.session_id = fa.session_id AND tf.file_id = fa.file_id
                  )
            ) combined_records
            ORDER BY created_at DESC, message_id DESC
            LIMIT ? OFFSET ?
        `, [sessionId, sessionId, safeLimit, safeOffset]);
        const items = rows.map(row => {
            const item = hydrateTransferRecord(row);
            if (!row.direct_file_id) return item;
            const metadata = safeJsonParse(row.direct_metadata_json, {});
            const file = {
                session_id: row.session_id,
                message_id: row.message_id,
                file_id: row.direct_file_id,
                id: row.direct_file_id,
                file_name: row.direct_file_name || '',
                name: row.direct_file_name || '',
                mime_type: row.direct_mime_type || '',
                type: row.direct_mime_type || '',
                file_size: Number(row.total_file_size) || 0,
                size: Number(row.total_file_size) || 0,
                declared_size: Number(row.total_file_size) || 0,
                created_at: row.created_at,
                updated_at: row.updated_at,
                removed_at: row.deleted_at,
                metadata,
                asset_kind: String(metadata.assetKind || metadata.asset_kind || 'file').toLowerCase() === 'editor'
                    ? 'editor'
                    : 'file'
            };
            item.message = {
                id: row.message_id,
                type: 'file',
                sender: row.sender_device_id || '',
                timestamp: row.created_at,
                fileInfo: {
                    id: file.id,
                    name: file.name,
                    type: file.type,
                    size: file.size
                }
            };
            item.payload = item.message;
            item.files = [file];
            return item;
        });
        if (items.length) {
            const regularItems = items.filter(item => item.source !== 'direct-file-asset');
            const placeholders = regularItems.map(() => '?').join(', ');
            if (!regularItems.length) return { items, total, limit: safeLimit, offset: safeOffset };
            const files = this.query(`
                SELECT tf.session_id, tf.message_id, tf.file_id, tf.file_id AS id,
                       tf.file_name, tf.file_name AS name, tf.mime_type, tf.mime_type AS type,
                        tf.file_size, tf.file_size AS size, tf.file_size AS declared_size,
                        tf.created_at, tf.updated_at, tf.removed_at,
                        fa.metadata_json AS asset_metadata_json,
                        vs.state AS cache_state, vs.bytes_cached, vs.bytes_total,
                       vs.cache_path, vs.error AS cache_error, vs.updated_at AS cache_updated_at,
                       vs.completed_at AS cache_completed_at
                FROM transfer_files tf
                LEFT JOIN file_assets fa
                  ON fa.session_id = tf.session_id AND fa.file_id = tf.file_id
                LEFT JOIN vclient_asset_states vs
                  ON vs.session_id = tf.session_id AND vs.file_id = tf.file_id
                WHERE tf.session_id = ? AND tf.message_id IN (${placeholders})
                ORDER BY tf.created_at ASC, tf.file_id ASC
            `, [sessionId, ...regularItems.map(item => item.message_id)]);
            const byMessage = new Map();
            for (const file of files) {
                file.metadata = safeJsonParse(file.asset_metadata_json, {});
                file.asset_kind = String(file.metadata?.assetKind || file.metadata?.asset_kind || 'file').toLowerCase() === 'editor'
                    ? 'editor'
                    : 'file';
                delete file.asset_metadata_json;
                if (!byMessage.has(file.message_id)) byMessage.set(file.message_id, []);
                byMessage.get(file.message_id).push(file);
            }
            for (const item of regularItems) item.files = byMessage.get(item.message_id) || [];
        }
        return {
            items,
            total,
            limit: safeLimit,
            offset: safeOffset
        };
    }

    recordFileAsset(sessionId, asset, options = {}) {
        if (!sessionId || !asset?.id) return null;
        this.run('BEGIN');
        try {
            this.touchTunnelRow(sessionId, {
                createdAt: normalizeTimestamp(options.now, Date.now()),
                lastActivity: normalizeTimestamp(options.now, Date.now())
            });
            this.recordFileAssetRow(sessionId, asset, options);
            this.run('COMMIT');
        } catch (err) {
            this.run('ROLLBACK');
            throw err;
        }
        this.save();
        return this.getFileAsset(sessionId, asset.id);
    }

    recordAssetTransferEvent(sessionId, eventType, asset, options = {}) {
        const fileId = String(asset?.id || asset?.fileId || asset?.file_id || '').trim();
        const normalizedEventType = String(eventType || '').trim().toLowerCase();
        if (!sessionId || !fileId || ![
            'announced', 'requested', 'relay-completed', 'client-completed', 'failed'
        ].includes(normalizedEventType)) return null;
        const occurredAt = normalizeTimestamp(options.now || options.occurredAt, Date.now());
        const eventId = crypto.randomUUID();
        const declaredSize = normalizeFileSize(asset.size ?? asset.fileSize ?? asset.file_size);
        const transferred = normalizeFileSize(options.bytesTransferred ?? options.bytes_transferred);
        const details = {
            ...(options.details && typeof options.details === 'object' ? options.details : {}),
            asset: {
                id: fileId,
                name: String(asset.name || asset.fileName || asset.file_name || ''),
                type: String(asset.type || asset.mimeType || asset.mime_type || ''),
                size: declaredSize
            }
        };
        this.run('BEGIN');
        try {
            this.touchTunnelRow(sessionId, { createdAt: occurredAt, lastActivity: occurredAt });
            this.recordFileAssetRow(sessionId, {
                ...asset,
                id: fileId,
                size: declaredSize
            }, {
                now: occurredAt,
                sourceDeviceId: options.sourceDeviceId || options.source_device_id || ''
            });
            this.run(`
                INSERT INTO asset_transfer_events (
                    session_id, event_id, event_type, file_id, file_name, mime_type,
                    declared_size, bytes_transferred, source_device_id, target_device_id,
                    transfer_id, request_id, transport, occurred_at, details_json
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `, [
                sessionId,
                eventId,
                normalizedEventType,
                fileId,
                String(asset.name || asset.fileName || asset.file_name || ''),
                String(asset.type || asset.mimeType || asset.mime_type || ''),
                declaredSize,
                transferred,
                String(options.sourceDeviceId || options.source_device_id || ''),
                String(options.targetDeviceId || options.target_device_id || ''),
                String(options.transferId || options.transfer_id || ''),
                String(options.requestId || options.request_id || ''),
                String(options.transport || ''),
                occurredAt,
                safeJsonStringify(details, '{}')
            ]);
            this.run('COMMIT');
        } catch (err) {
            this.run('ROLLBACK');
            throw err;
        }
        this.save();
        return this.get(
            'SELECT * FROM asset_transfer_events WHERE session_id = ? AND event_id = ?',
            [sessionId, eventId]
        );
    }

    listAssetTransferEvents(sessionId, { limit = 1000, offset = 0 } = {}) {
        return this.query(`
            SELECT session_id, event_id, event_type, file_id, file_name, mime_type,
                   declared_size, bytes_transferred, source_device_id, target_device_id,
                   transfer_id, request_id, transport, occurred_at, details_json
            FROM asset_transfer_events
            WHERE session_id = ?
            ORDER BY occurred_at DESC, event_id DESC
            LIMIT ? OFFSET ?
        `, [sessionId, clampLimit(limit, 1000, 5000), nonNegativeInteger(offset)])
            .map(row => ({ ...row, details: safeJsonParse(row.details_json, {}) }));
    }

    recordFileAssetRow(sessionId, asset, options = {}) {
        const now = normalizeTimestamp(options.now, Date.now());
        const metadata = options.metadata || asset;
        this.run(`
            INSERT INTO file_assets (
                session_id, file_id, file_name, mime_type, file_size, source_device_id,
                metadata_json, first_seen, last_seen, removed_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
            ON CONFLICT(session_id, file_id) DO UPDATE SET
                file_name = CASE WHEN excluded.file_name <> '' THEN excluded.file_name ELSE file_assets.file_name END,
                mime_type = CASE WHEN excluded.mime_type <> '' THEN excluded.mime_type ELSE file_assets.mime_type END,
                file_size = MAX(file_assets.file_size, excluded.file_size),
                source_device_id = CASE WHEN excluded.source_device_id <> '' THEN excluded.source_device_id ELSE file_assets.source_device_id END,
                metadata_json = CASE WHEN excluded.metadata_json <> '{}' THEN excluded.metadata_json ELSE file_assets.metadata_json END,
                last_seen = MAX(file_assets.last_seen, excluded.last_seen),
                removed_at = NULL
        `, [
            sessionId,
            String(asset.id),
            String(asset.name || asset.fileName || ''),
            String(asset.type || asset.mimeType || ''),
            normalizeFileSize(asset.size ?? asset.fileSize),
            String(options.sourceDeviceId || asset.ownerDeviceId || asset.sourceDeviceId || ''),
            safeJsonStringify(metadata, '{}'),
            now,
            now
        ]);
    }

    getFileAsset(sessionId, fileId) {
        const row = this.get(`
            SELECT session_id, file_id, file_name, mime_type, file_size, source_device_id,
                   metadata_json, first_seen, last_seen, removed_at
            FROM file_assets WHERE session_id = ? AND file_id = ?
        `, [sessionId, fileId]);
        return hydrateFileAsset(row);
    }

    listFileAssets(sessionId, { includeRemoved = false, limit = 1000, offset = 0 } = {}) {
        return this.query(`
            SELECT session_id, file_id, file_name, mime_type, file_size, source_device_id,
                   metadata_json, first_seen, last_seen, removed_at
            FROM file_assets
            WHERE session_id = ? ${includeRemoved ? '' : 'AND removed_at IS NULL'}
            ORDER BY first_seen ASC, file_id ASC
            LIMIT ? OFFSET ?
        `, [sessionId, clampLimit(limit, 1000, 5000), nonNegativeInteger(offset)]).map(hydrateFileAsset);
    }

    markFileAssetRemoved(sessionId, fileId, removedAt = Date.now()) {
        this.run(`
            UPDATE file_assets
            SET removed_at = COALESCE(removed_at, ?), last_seen = MAX(last_seen, ?)
            WHERE session_id = ? AND file_id = ?
        `, [removedAt, removedAt, sessionId, fileId]);
        const changed = this.db.getRowsModified() > 0;
        this.save();
        return changed;
    }

    setVClientDesired(sessionId, enabled, updatedAt = Date.now()) {
        if (!sessionId) return null;
        const now = normalizeTimestamp(updatedAt, Date.now());
        const desired = enabled ? 1 : 0;
        this.run('BEGIN');
        try {
            this.touchTunnelRow(sessionId, { createdAt: now, lastActivity: now });
            this.run(`
                INSERT INTO vclient_tunnels (
                    session_id, desired_enabled, desired_updated_at, state, updated_at
                ) VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(session_id) DO UPDATE SET
                    desired_enabled = excluded.desired_enabled,
                    desired_updated_at = excluded.desired_updated_at,
                    state = CASE
                        WHEN excluded.desired_enabled = 1 AND vclient_tunnels.state IN ('disabled', 'stopped') THEN 'starting'
                        WHEN excluded.desired_enabled = 0 AND vclient_tunnels.state NOT IN ('disabled', 'stopped') THEN 'stopping'
                        ELSE vclient_tunnels.state
                    END,
                    updated_at = excluded.updated_at
            `, [sessionId, desired, now, desired ? 'starting' : 'disabled', now]);
            this.run('COMMIT');
        } catch (err) {
            this.run('ROLLBACK');
            throw err;
        }
        this.save();
        return this.getVClientTunnel(sessionId);
    }

    updateVClientStatus(sessionId, state, details = {}) {
        if (!sessionId) return null;
        if (state && typeof state === 'object') {
            details = state;
            state = details.state;
        }
        const now = normalizeTimestamp(details.updatedAt || details.updated_at, Date.now());
        const existing = this.getVClientTunnel(sessionId);
        const nextState = String(state || existing?.state || 'disabled');
        const detailValue = details.statusDetail ?? details.status_detail ?? details.detail;
        const statusDetail = detailValue === undefined
            ? null
            : (typeof detailValue === 'string' ? detailValue : safeJsonStringify(detailValue, ''));
        const heartbeatAt = nullableTimestamp(details.heartbeatAt ?? details.heartbeat_at);
        let startedAt = nullableTimestamp(details.startedAt ?? details.started_at);
        let stoppedAt = nullableTimestamp(details.stoppedAt ?? details.stopped_at);
        if (startedAt === null && ['syncing', 'active', 'reconnecting'].includes(nextState) && !existing?.started_at) startedAt = now;
        if (stoppedAt === null && ['disabled', 'stopped'].includes(nextState) && !existing?.stopped_at) stoppedAt = now;
        this.run(`
            INSERT INTO vclient_tunnels (
                session_id, desired_enabled, desired_updated_at, state, status_detail,
                last_error, instance_id, device_id, heartbeat_at, cached_files, cached_bytes,
                last_sync_at, started_at, stopped_at, updated_at
            ) VALUES (?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(session_id) DO UPDATE SET
                state = excluded.state,
                status_detail = COALESCE(excluded.status_detail, vclient_tunnels.status_detail),
                last_error = COALESCE(excluded.last_error, vclient_tunnels.last_error),
                instance_id = COALESCE(excluded.instance_id, vclient_tunnels.instance_id),
                device_id = COALESCE(excluded.device_id, vclient_tunnels.device_id),
                heartbeat_at = COALESCE(excluded.heartbeat_at, vclient_tunnels.heartbeat_at),
                cached_files = COALESCE(excluded.cached_files, vclient_tunnels.cached_files),
                cached_bytes = COALESCE(excluded.cached_bytes, vclient_tunnels.cached_bytes),
                last_sync_at = COALESCE(excluded.last_sync_at, vclient_tunnels.last_sync_at),
                started_at = COALESCE(excluded.started_at, vclient_tunnels.started_at),
                stopped_at = CASE
                    WHEN excluded.state IN ('starting', 'syncing', 'active', 'reconnecting') THEN NULL
                    ELSE COALESCE(excluded.stopped_at, vclient_tunnels.stopped_at)
                END,
                updated_at = excluded.updated_at
        `, [
            sessionId,
            now,
            nextState,
            statusDetail,
            details.lastError ?? details.last_error ?? null,
            details.instanceId ?? details.instance_id ?? null,
            details.deviceId ?? details.device_id ?? null,
            heartbeatAt,
            details.cachedFiles ?? details.cached_files ?? existing?.cached_files ?? 0,
            details.cachedBytes ?? details.cached_bytes ?? existing?.cached_bytes ?? 0,
            nullableTimestamp(details.lastSyncAt ?? details.last_sync_at ?? existing?.last_sync_at),
            startedAt,
            stoppedAt,
            now
        ]);
        this.save();
        return this.getVClientTunnel(sessionId);
    }

    getVClientTunnel(sessionId) {
        return hydrateVClientTunnel(this.get(`
            SELECT session_id, desired_enabled, desired_updated_at, state, status_detail,
                   last_error, instance_id, device_id, heartbeat_at, cached_files, cached_bytes,
                   last_sync_at, started_at, stopped_at, updated_at
            FROM vclient_tunnels WHERE session_id = ?
        `, [sessionId]));
    }

    listVClientTunnels({ desiredOnly = false, limit = 2000, offset = 0 } = {}) {
        return this.query(`
            SELECT session_id, desired_enabled, desired_updated_at, state, status_detail,
                   last_error, instance_id, device_id, heartbeat_at, cached_files, cached_bytes,
                   last_sync_at, started_at, stopped_at, updated_at
            FROM vclient_tunnels
            WHERE ${desiredOnly ? 'desired_enabled = 1' : '1 = 1'}
            ORDER BY desired_enabled DESC, updated_at DESC
            LIMIT ? OFFSET ?
        `, [clampLimit(limit, 2000, 10000), nonNegativeInteger(offset)]).map(hydrateVClientTunnel);
    }

    upsertVClientAssetState(sessionId, fileId, stateOrObject, details = {}) {
        if (!sessionId || !fileId) return null;
        if (stateOrObject && typeof stateOrObject === 'object') {
            details = stateOrObject;
            stateOrObject = details.state;
        }
        const existing = this.getVClientAssetState(sessionId, fileId);
        const state = String(stateOrObject || existing?.state || 'pending');
        const now = normalizeTimestamp(details.updatedAt || details.updated_at, Date.now());
        const bytesCached = nonNegativeInteger(details.bytesCached ?? details.bytes_cached ?? existing?.bytes_cached ?? 0);
        const bytesTotal = nonNegativeInteger(details.bytesTotal ?? details.bytes_total ?? existing?.bytes_total ?? 0);
        let completedAt = nullableTimestamp(details.completedAt ?? details.completed_at);
        if (completedAt === null && state === 'cached') completedAt = now;
        let startedAt = nullableTimestamp(details.startedAt ?? details.started_at);
        if (startedAt === null && ['downloading', 'cached'].includes(state) && !existing?.started_at) startedAt = now;
        this.run(`
            INSERT INTO vclient_asset_states (
                session_id, file_id, state, bytes_cached, bytes_total, cache_path,
                error, started_at, updated_at, completed_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(session_id, file_id) DO UPDATE SET
                state = excluded.state,
                bytes_cached = excluded.bytes_cached,
                bytes_total = MAX(vclient_asset_states.bytes_total, excluded.bytes_total),
                cache_path = COALESCE(excluded.cache_path, vclient_asset_states.cache_path),
                error = excluded.error,
                started_at = COALESCE(vclient_asset_states.started_at, excluded.started_at),
                updated_at = excluded.updated_at,
                completed_at = CASE
                    WHEN excluded.state = 'cached' THEN COALESCE(excluded.completed_at, vclient_asset_states.completed_at)
                    ELSE NULL
                END
        `, [
            sessionId,
            fileId,
            state,
            bytesCached,
            bytesTotal,
            details.cachePath ?? details.cache_path ?? null,
            details.error ?? null,
            startedAt,
            now,
            completedAt
        ]);
        this.save();
        return this.getVClientAssetState(sessionId, fileId);
    }

    getVClientAssetState(sessionId, fileId) {
        return this.get(`
            SELECT session_id, file_id, state, bytes_cached, bytes_total, cache_path,
                   error, started_at, updated_at, completed_at
            FROM vclient_asset_states WHERE session_id = ? AND file_id = ?
        `, [sessionId, fileId]);
    }

    listVClientAssetStates(sessionId, { state = '', limit = 1000, offset = 0 } = {}) {
        return this.query(`
            SELECT session_id, file_id, state, bytes_cached, bytes_total, cache_path,
                   error, started_at, updated_at, completed_at
            FROM vclient_asset_states
            WHERE session_id = ? ${state ? 'AND state = ?' : ''}
            ORDER BY updated_at DESC, file_id ASC
            LIMIT ? OFFSET ?
        `, state
            ? [sessionId, state, clampLimit(limit, 1000, 5000), nonNegativeInteger(offset)]
            : [sessionId, clampLimit(limit, 1000, 5000), nonNegativeInteger(offset)]);
    }

    upsertDevice(device) {
        const now = Number(device.lastAccess) || Date.now();
        this.run(`
            INSERT INTO devices (
                device_id, session_id, device_name, device_model, local_ip, external_ip,
                ip, socket_id, user_agent, first_seen, last_access, online, active
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(device_id) DO UPDATE SET
                session_id = excluded.session_id,
                device_name = excluded.device_name,
                device_model = excluded.device_model,
                local_ip = excluded.local_ip,
                external_ip = excluded.external_ip,
                ip = excluded.ip,
                socket_id = excluded.socket_id,
                user_agent = excluded.user_agent,
                last_access = excluded.last_access,
                online = excluded.online,
                active = excluded.active
        `, [
            device.deviceId,
            device.sessionId || null,
            device.deviceName || '',
            device.deviceModel || '',
            device.localIp || '',
            device.externalIp || '',
            device.ip || '',
            device.socketId || '',
            device.userAgent || '',
            now,
            now,
            device.online ? 1 : 0,
            device.active ? 1 : 0
        ]);
        this.save();
    }

    markDeviceOffline(deviceId, lastAccess = Date.now()) {
        this.run(
            'UPDATE devices SET online = 0, active = 0, last_access = MAX(last_access, ?) WHERE device_id = ?',
            [lastAccess, deviceId]
        );
        this.save();
    }

    listDevices(limit = 2000) {
        return this.query(`
            SELECT device_id, session_id, device_name, device_model, local_ip, external_ip,
                   ip, socket_id, user_agent, first_seen, last_access, online, active
            FROM devices
            ORDER BY online DESC, last_access DESC
            LIMIT ?
        `, [limit]);
    }

    getDevice(deviceId) {
        return this.get(`
            SELECT device_id, session_id, device_name, device_model, local_ip, external_ip,
                   ip, socket_id, user_agent, first_seen, last_access, online, active
            FROM devices
            WHERE device_id = ?
        `, [deviceId]);
    }
}

function normalizeTimestamp(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? Math.floor(number) : Math.floor(Number(fallback) || Date.now());
}

function nullableTimestamp(value) {
    if (value === undefined || value === null || value === '') return null;
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? Math.floor(number) : null;
}

function nonNegativeInteger(value) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
}

function clampLimit(value, fallback, maximum) {
    const number = Number(value);
    if (!Number.isFinite(number) || number <= 0) return fallback;
    return Math.min(maximum, Math.floor(number));
}

function normalizeFileSize(value) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
}

function safeJsonStringify(value, fallback) {
    try {
        return JSON.stringify(value ?? {});
    } catch (_) {
        return fallback;
    }
}

function safeJsonParse(value, fallback = null) {
    if (typeof value !== 'string' || value === '') return fallback;
    try {
        return JSON.parse(value);
    } catch (_) {
        return fallback;
    }
}

function findAssetMetadata(fileAssets, fileId) {
    if (!fileAssets || !fileId) return null;
    if (fileAssets instanceof Map) return fileAssets.get(fileId)?.metadata || fileAssets.get(fileId) || null;
    if (Array.isArray(fileAssets)) {
        return fileAssets.find(asset => String(asset?.id || asset?.file_id || '') === fileId) || null;
    }
    return fileAssets[fileId]?.metadata || fileAssets[fileId] || null;
}

function extractTransferFiles(message, fileAssets) {
    const files = new Map();
    const add = file => {
        const fileId = String(file?.id || file?.fileId || file?.file_id || '').trim();
        if (!fileId) return;
        const known = findAssetMetadata(fileAssets, fileId) || {};
        const previous = files.get(fileId) || {};
        files.set(fileId, {
            fileId,
            name: String(file?.name || file?.fileName || known.name || known.file_name || previous.name || ''),
            type: String(file?.type || file?.mimeType || known.type || known.mime_type || previous.type || ''),
            assetKind: String(
                file?.assetKind || file?.asset_kind || known.assetKind || known.asset_kind || previous.assetKind || ''
            ).toLowerCase() === 'editor' ? 'editor' : 'file',
            size: Math.max(
                normalizeFileSize(previous.size),
                normalizeFileSize(file?.size ?? file?.fileSize),
                normalizeFileSize(known.size ?? known.file_size)
            )
        });
    };

    if (message.fileInfo) add(message.fileInfo);
    if (Array.isArray(message.collection?.files)) message.collection.files.forEach(add);
    if (Array.isArray(message.files)) message.files.forEach(add);
    if (Array.isArray(message.fileRefs)) message.fileRefs.forEach(ref => add(typeof ref === 'string' ? { id: ref } : ref));

    const richContent = typeof message.content === 'string' ? message.content : '';
    for (const pattern of [
        /data-tunnel-file-ref-id\s*=\s*["']([^"']+)["']/gi,
        /data-tunnel-asset-id\s*=\s*["']([^"']+)["']/gi,
        /downloadFile\(\s*["']([^"']+)["']\s*\)/gi
    ]) {
        for (const match of richContent.matchAll(pattern)) add({ id: match[1] });
    }
    return Array.from(files.values());
}

function hydrateTransferRecord(row) {
    if (!row) return null;
    const message = safeJsonParse(row.payload_json, null);
    return {
        ...row,
        message,
        payload: message
    };
}

function hydrateFileAsset(row) {
    if (!row) return null;
    return {
        ...row,
        metadata: safeJsonParse(row.metadata_json, {})
    };
}

function hydrateVClientTunnel(row) {
    if (!row) return null;
    return {
        ...row,
        desired_enabled: Boolean(row.desired_enabled),
        details: safeJsonParse(row.status_detail, row.status_detail || null)
    };
}

module.exports = { createInfraStore };
