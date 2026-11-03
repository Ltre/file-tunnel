'use strict';
const crypto = require('node:crypto');

// Admin-only selection/editing. Existing front-office roles and permission checks
// are supplied by the caller; selecting a device never enrols it or grants access.
function createAdminDeviceAccess({ get, findDevice, normalize, canUse, save }) {
    function selected(sessionId, deviceId) {
        const access = get(sessionId);
        if (!access) throw Object.assign(Error('session-not-found'), { status: 404 });
        const { session, payload } = access;
        const device = findDevice(deviceId) || payload.knownDevices.find(value => value.deviceId === deviceId);
        if (!device) throw Object.assign(Error('device-not-found'), { status: 404 });
        const custom = session.devicePermissions?.[deviceId], manager = session.managementDevices?.[deviceId];
        const owner = session.ownerDeviceId === deviceId;
        const fallback = { ...session, devicePermissions: { ...session.devicePermissions }, managementDevices: { ...session.managementDevices } };
        delete fallback.devicePermissions[deviceId]; delete fallback.managementDevices[deviceId];
        const effective = value => Object.fromEntries(Object.keys(normalize()).map(key => [key, canUse(value, deviceId, key)]));
        const value = {
            deviceId, deviceName: device.deviceName || device.device_name || deviceId,
            mode: owner ? 'owner' : manager ? 'administrator' : custom ? 'custom' : 'default',
            permissions: effective(session), defaultPermissions: effective(fallback),
            version: crypto.createHash('sha256').update(JSON.stringify([session.ownerDeviceId, normalize(session.permissions),
                session.admins?.[deviceId] ? normalize(session.admins[deviceId].permissions) : null,
                custom ? normalize(custom.permissions) : null, Boolean(manager)])).digest('hex')
        };
        return { session, value };
    }
    return {
        get: (sessionId, deviceId) => selected(sessionId, deviceId).value,
        save(sessionId, deviceId, data) {
            const { session, value } = selected(sessionId, deviceId);
            if (value.mode === 'owner') throw Error('creator-permissions-fixed');
            if (data.version !== value.version) throw Object.assign(Error('device-permissions-changed'), { status: 409 });
            if (!['default', 'custom', 'administrator'].includes(data.mode)) throw Error('invalid-device-permissions');
            if (data.mode === 'custom' && (!data.permissions || Object.keys(normalize()).some(key => typeof data.permissions[key] !== 'boolean'))) throw Error('invalid-device-permissions');
            const managementDevices = { ...session.managementDevices }, devicePermissions = { ...session.devicePermissions };
            delete managementDevices[deviceId]; delete devicePermissions[deviceId];
            if (data.mode !== 'default') {
                const destination = data.mode === 'administrator' ? managementDevices : devicePermissions;
                destination[deviceId] = { ...(session.devicePermissions?.[deviceId] || session.managementDevices?.[deviceId]),
                    deviceId, deviceName: value.deviceName, permissions: normalize(data.permissions) };
            }
            save(sessionId, session, { managementDevices, devicePermissions });
            return selected(sessionId, deviceId).value;
        }
    };
}

// Back-office authentication authorizes configuration, not a front-office role.
function mountTunnelPermissionRoutes(app, { requireAuth, get, save, validSessionId, validDeviceId, deviceAccess }) {
    app.get('/api/sessions/:sessionId/access', requireAuth, (req, res) => {
        if (!validSessionId(req.params.sessionId)) return res.status(400).json({ error: 'invalid-session' });
        const access = get(req.params.sessionId);
        if (!access) return res.status(404).json({ error: 'session-not-found' });
        res.json(access);
    });
    app.put('/api/sessions/:sessionId/access', requireAuth, (req, res) => {
        if (!validSessionId(req.params.sessionId)) return res.status(400).json({ error: 'invalid-session' });
        if (!get(req.params.sessionId)) return res.status(404).json({ error: 'session-not-found' });
        try { res.json({ ok: true, ...save(req.params.sessionId, req.body || {}) }); }
        catch (error) { res.status(400).json({ error: error.message || 'invalid-permissions' }); }
    });
    if (deviceAccess) {
        const respond = operation => (req, res) => {
            if (!validSessionId(req.params.sessionId)) return res.status(400).json({ error: 'invalid-session' });
            if (!validDeviceId(req.params.deviceId)) return res.status(400).json({ error: 'invalid-device' });
            try { res.json(operation(req.params.sessionId, req.params.deviceId, req.body || {})); }
            catch (error) { res.status(error.status || 400).json({ error: error.message || 'invalid-permissions' }); }
        };
        app.get('/api/sessions/:sessionId/access/devices/:deviceId', requireAuth, respond(deviceAccess.get));
        app.put('/api/sessions/:sessionId/access/devices/:deviceId', requireAuth, respond(deviceAccess.save));
    }
}
module.exports = { mountTunnelPermissionRoutes, createAdminDeviceAccess };
