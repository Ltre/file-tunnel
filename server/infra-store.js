const fs = require('fs');
const path = require('path');
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
    }

    migrate() {
        this.db.run(`
            PRAGMA foreign_keys = ON;
            CREATE TABLE IF NOT EXISTS tunnels (
                session_id TEXT PRIMARY KEY,
                short_code TEXT UNIQUE,
                created_at INTEGER NOT NULL,
                last_activity INTEGER NOT NULL,
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
            CREATE INDEX IF NOT EXISTS idx_tunnels_short_code ON tunnels(short_code);
            CREATE INDEX IF NOT EXISTS idx_devices_session_id ON devices(session_id);
            CREATE INDEX IF NOT EXISTS idx_devices_last_access ON devices(last_access);
        `);
    }

    save() {
        const bytes = Buffer.from(this.db.export());
        const tempPath = `${this.dbPath}.${process.pid}.tmp`;
        fs.writeFileSync(tempPath, bytes);
        fs.renameSync(tempPath, this.dbPath);
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
        this.run(`
            INSERT INTO tunnels (session_id, short_code, created_at, last_activity, deleted_at)
            VALUES (?, NULLIF(?, ''), ?, ?, NULL)
            ON CONFLICT(session_id) DO UPDATE SET
                short_code = COALESCE(tunnels.short_code, NULLIF(excluded.short_code, '')),
                last_activity = MAX(tunnels.last_activity, excluded.last_activity),
                deleted_at = NULL
        `, [sessionId, shortCode, createdAt, lastActivity]);
        this.save();
    }

    deleteTunnel(sessionId) {
        this.run('DELETE FROM tunnels WHERE session_id = ?', [sessionId]);
        this.save();
    }

    deleteShortCode(shortCode) {
        this.run('UPDATE tunnels SET short_code = NULL WHERE short_code = ?', [shortCode]);
        this.save();
    }

    listTunnels() {
        return this.query(`
            SELECT session_id, short_code, created_at, last_activity
            FROM tunnels
            WHERE deleted_at IS NULL
            ORDER BY last_activity DESC
        `);
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
}

module.exports = { createInfraStore };
