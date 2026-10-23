'use strict';

// The station service owns identities, grants and the clock. Media adapters own
// reads; neither playlists nor bookmarks retain or protect source bytes.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const digest = value => crypto.createHash('sha256').update(String(value)).digest('hex');
const copy = value => structuredClone(value);
const fail = code => { throw new Error(code); };
const id = () => crypto.randomUUID();
const validId = value => typeof value === 'string' && /^[\w:.-]{1,128}$/.test(value);
const number = (value, min, max, code = 'STREAM_PARAMETER_INVALID') => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < min || parsed > max) fail(code);
    return parsed;
};
function mediaKind(name, type = '') {
    type = String(type).split(';')[0].trim().toLowerCase();
    if (type && !['application/octet-stream', 'binary/octet-stream'].includes(type)) {
        if (/^image\//.test(type) && type !== 'image/svg+xml') return 'image';
        if (/^video\//.test(type)) return 'video';
        if (/^audio\//.test(type)) return 'audio';
        if (/^(text\/markdown|text\/x-markdown)$/.test(type)) return 'markdown';
        if (type === 'text/plain') return /\.(md|markdown)$/i.test(name) ? 'markdown' : 'text';
        fail('STREAM_TYPE_UNSUPPORTED');
    }
    if (/^image\//.test(type) || /\.(png|jpe?g|gif|webp|avif|bmp)$/i.test(name)) return 'image';
    if (/^video\//.test(type) || /\.(mp4|webm|mkv|mov|m4v)$/i.test(name)) return 'video';
    if (/^audio\//.test(type) || /\.(mp3|m4a|ogg|opus|wav|flac|aac)$/i.test(name)) return 'audio';
    if (/\.(md|markdown)$/i.test(name) || /markdown/.test(type)) return 'markdown';
    if (/\.txt$/i.test(name) || type === 'text/plain') return 'text';
    fail('STREAM_TYPE_UNSUPPORTED');
}
function createStreamingConsole({ dataDir, now = Date.now, user = () => null,
    loginRevoked = () => false, visibleDevices = () => [], sources = {}, onChange = () => {}, viewerLeaseMs = 45000 }) {
    const filename = path.join(dataDir, 'streaming-console.json');
    let db = { version: 1, devices: {}, stations: {}, bookmarks: {} };
    if (fs.existsSync(filename)) {
        db = JSON.parse(fs.readFileSync(filename, 'utf8'));
        if (db.version !== 1 || !db.devices || !db.stations || !db.bookmarks) fail('STREAM_STORE_INVALID');
    }
    const viewers = new Map(), closedViewers = new Map();
    function persist() {
        fs.mkdirSync(dataDir, { recursive: true });
        const temp = filename + '.' + process.pid + '.tmp';
        fs.writeFileSync(temp, JSON.stringify(db)); fs.renameSync(temp, filename);
    }
    function change(work) {
        const before = copy(db);
        try { const result = work(); if (JSON.stringify(before) !== JSON.stringify(db)) { persist(); onChange(); } return result; }
        catch (error) { db = before; throw error; }
    }
    function register(deviceId, secret, name) {
        if (!validId(deviceId) || !/^[\w-]{32,128}$/.test(secret || '')) fail('STREAM_DEVICE_INVALID');
        const existing = db.devices[deviceId];
        if (existing && existing.secret !== digest(secret)) fail('STREAM_DEVICE_DENIED');
        if (!existing && Object.keys(db.devices).length >= 10000) fail('STREAM_LIMIT');
        return change(() => {
            db.devices[deviceId] ||= { secret: digest(secret), name: '', follows: [] };
            db.devices[deviceId].name = String(name || deviceId).slice(0, 100);
            return { deviceId };
        });
    }
    function authenticate(deviceId, secret) {
        if (!validId(deviceId) || !secret || db.devices[deviceId]?.secret !== digest(secret)) fail('STREAM_DEVICE_DENIED');
        return deviceId;
    }
    function station(stationId) { return db.stations[stationId] || fail('STREAM_NOT_FOUND'); }
    function sourceLoggedIn(s) { return !s.ownerId || Boolean(s.login && s.login.expiresAt > now() && !loginRevoked(s.login.hash)); }
    function authority(s, actor, operation = 'control') {
        const local = actor.deviceId === s.deviceId;
        if (operation === 'delete' && local && !sourceLoggedIn(s)) return true;
        if (!sourceLoggedIn(s)) fail('STREAM_SOURCE_LOGIN_REQUIRED');
        if (s.ownerId ? actor.userId !== s.ownerId : !local) fail('STREAM_OWNER_REQUIRED');
        if (['edit', 'delete', 'claim', 'release'].includes(operation) && !local) fail('STREAM_LOCAL_ONLY');
        return true;
    }
    function canManage(s, actor) { try { return authority(s, actor); } catch (_) { return false; } }
    function allowed(s, actor, allowOffline = false) {
        if (isBlocked(s, actor)) fail('STREAM_KICKED');
        if (s.visibility === 'offline' && !allowOffline) fail('STREAM_OFFLINE');
        if (canManage(s, actor)) return true;
        if (s.visibility === 'public') return true;
        if (s.grants.some(g => g.epoch === s.epoch && (g.deviceId === actor.deviceId || g.userId && g.userId === actor.userId))) return true;
        fail('STREAM_INVITATION_REQUIRED');
    }
    function isBlocked(s, actor) { return Boolean([actor.deviceId, ...(db.devices[actor.deviceId]?.aliases || [])].some(deviceId => s.blocked[deviceId]) || actor.userId && s.blockedUsers?.[actor.userId]); }
    function length(item) { return ['video', 'audio'].includes(item.kind) ? item.duration - item.start : item.stay; }
    const transientSourceError = reason => ['STREAM_PROVIDER_OFFLINE', 'STREAM_PROVIDER_TIMEOUT', 'STREAM_SOURCE_MISSING'].includes(reason);
    function available(s) { return s.items.filter(item => !item.unavailable || transientSourceError(item.unavailable)); }
    function advance(s, time = now()) {
        const p = s.playback;
        if (s.visibility === 'offline' || p.status !== 'playing') return false;
        const items = available(s);
        if (!items.length) { Object.assign(p, { status: 'stopped', itemId: null, position: 0, at: time, version: p.version + 1 }); return true; }
        let index = items.findIndex(item => item.id === p.itemId);
        if (index < 0) index = 0;
        let elapsed = p.position + Math.max(0, time - p.at) / 1000;
        if (elapsed < length(items[index])) return false;
        // Skip complete cycles arithmetically, even after a long server outage.
        const cycle = items.reduce((sum, item) => sum + length(item), 0);
        if (s.loop && cycle > 0) elapsed %= cycle;
        let transitions = 0;
        while (elapsed >= length(items[index]) && transitions <= items.length) {
            elapsed -= length(items[index]);
            if (index === items.length - 1 && !s.loop) {
                Object.assign(p, { itemId: items[index].id, position: length(items[index]), at: time, status: 'stopped', version: p.version + 1 }); return true;
            }
            index = (index + 1) % items.length; transitions++;
        }
        Object.assign(p, { itemId: items[index].id, position: elapsed, at: time, version: p.version + 1 }); return true;
    }
    function position(s, time = now()) {
        const p = s.playback, item = s.items.find(item => item.id === p.itemId);
        return item ? Math.min(length(item), p.position + (p.status === 'playing' && s.visibility !== 'offline' ? Math.max(0, time - p.at) / 1000 : 0)) : 0;
    }
    function audience(s) { return [...viewers.values()].filter(v => v.stationId === s.id && v.expiresAt > now()).length; }
    function pauseWithoutAudience(s, time) {
        if (s.playback.status !== 'playing') return false;
        advance(s, time);
        Object.assign(s.playback, { position: position(s, time), at: now(), status: s.playback.status === 'stopped' ? 'stopped' : 'paused', version: s.playback.version + 1 });
        return true;
    }
    function summary(s, actor) {
        const manageable = canManage(s, actor);
        const owner = s.ownerId && user(s.ownerId);
        return { id: s.id, number: s.number, name: s.name, deviceId: s.deviceId, deviceName: db.devices[s.deviceId]?.name || s.deviceId,
            owner: owner ? { id: owner.id, name: owner.name || owner.username || owner.id } : null,
            ownerId: s.ownerId, visibility: s.visibility, locked: !sourceLoggedIn(s), local: s.deviceId === actor.deviceId,
            manageable, configVersion: s.configVersion, itemCount: s.items.length, loop: s.loop, countdown: s.countdown,
            createdAt: s.createdAt || 0, updatedAt: s.updatedAt || s.createdAt || 0,
            subscribedAt: actor.userId ? db.bookmarkTimes?.[actor.userId]?.[s.id] || 0 : 0,
            subscribed: Boolean(actor.userId && db.bookmarks[actor.userId]?.includes(s.id)), viewerCount: audience(s),
            playback: { ...s.playback, position: position(s), at: now() }, serverTime: now(), epoch: s.epoch };
    }
    function view(stationId, actor, { manage = false } = {}) {
        const s = station(stationId); tick();
        if (manage) authority(s, actor); else allowed(s, actor);
        return { ...summary(s, actor), items: s.items.map(item => {
            const { source, references, ...publicItem } = item;
            return { ...publicItem, unavailable: transientSourceError(item.unavailable) ? null : item.unavailable, sourceKind: source.kind };
        }), viewers: canManage(s, actor) ? [...viewers.values()].filter(v => v.stationId === s.id && v.expiresAt > now()).map(({ actor: _actor, ...report }) => report) : undefined,
        blocked: canManage(s, actor) ? Object.keys(s.blocked) : undefined,
        blockedUsers: canManage(s, actor) ? Object.keys(s.blockedUsers || {}) : undefined };
    }
    function syncDevice(actor, { follows = [], aliases = [] } = {}) {
        const d = db.devices[actor.deviceId] || fail('STREAM_DEVICE_DENIED');
        const next = [...new Set(follows.filter(validId))].slice(0, 1000);
        let dirty = JSON.stringify(d.follows) !== JSON.stringify(next);
        return change(() => {
            if (dirty) d.follows = next;
            d.aliases = [...new Set([actor.deviceId, ...aliases.filter(validId)])].slice(0, 500);
            for (const s of Object.values(db.stations)) {
                if (s.deviceId !== actor.deviceId || !s.ownerId) continue;
                const proof = actor.logins?.find(proof => proof.id === s.ownerId);
                // Missing cookies alone are not evidence of logout (network and
                // partial cookie delivery must not impersonate session expiry).
                if (proof && JSON.stringify(s.login) !== JSON.stringify(proof)) s.login = copy(proof);
                if (!sourceLoggedIn(s)) lock(s);
            }
            if (actor.userId) for (const s of Object.values(db.stations)) {
                for (const g of s.grants.slice()) if (g.kind === 'general' && g.deviceId === actor.deviceId && g.epoch === s.epoch
                    && !isBlocked(s, actor) && !s.grants.some(v => v.userId === actor.userId && v.epoch === s.epoch))
                    s.grants.push({ kind: 'general', userId: actor.userId, epoch: s.epoch });
            }
            return { ok: true };
        });
    }
    function lock(s) {
        if (s.visibility === 'offline') return false;
        Object.assign(s.playback, { position: position(s), at: now(), version: s.playback.version + 1 });
        s.lastVisibility = s.visibility; s.visibility = 'offline'; return true;
    }
    function tick() {
        let dirty = false;
        for (const [key, expiresAt] of closedViewers) if (expiresAt <= now()) closedViewers.delete(key);
        const ended = new Map();
        for (const [key, value] of viewers) {
            let valid = value.expiresAt > now();
            try { allowed(station(value.stationId), value.actor); } catch (_) { valid = false; }
            if (!valid) { viewers.delete(key); ended.set(value.stationId, Math.max(ended.get(value.stationId) || 0, Math.min(now(), value.expiresAt))); }
        }
        for (const s of Object.values(db.stations)) {
            if (!sourceLoggedIn(s)) dirty = lock(s) || dirty;
            if (!audience(s)) dirty = pauseWithoutAudience(s, ended.get(s.id) ?? s.playback.at) || dirty;
            dirty = advance(s) || dirty;
        }
        if (dirty) { persist(); onChange(); }
    }
    function revokeLogin(hash) {
        change(() => { for (const s of Object.values(db.stations)) if (s.login?.hash === hash) { lock(s); s.login = null; } });
    }
    function create(actor, input) {
        if (input.creationId) {
            if (!validId(input.creationId)) fail('STREAM_PARAMETER_INVALID');
            const existing = Object.values(db.stations).find(s => s.deviceId === actor.deviceId && s.creationId === input.creationId);
            if (existing) return summary(existing, actor);
        }
        if (Object.values(db.stations).filter(s => s.deviceId === actor.deviceId).length >= 100) fail('STREAM_LIMIT');
        const ownerId = input.unowned ? null : actor.userId || null;
        const login = ownerId ? actor.logins?.find(proof => proof.id === ownerId) : null;
        if (ownerId && !login) fail('STREAM_SOURCE_LOGIN_REQUIRED');
        return change(() => {
            const stationId = id();
            const used = new Set(Object.values(db.stations).filter(s => s.deviceId === actor.deviceId).map(s => s.number));
            let index = 1; while (used.has(String(index).padStart(2, '0'))) index++;
            const s = { id: stationId, creationId: input.creationId || null, deviceId: actor.deviceId, ownerId, login: copy(login), number: String(index).padStart(2, '0'),
                name: String(input.name || '').trim().slice(0, 120) || String(index).padStart(2, '0'),
                visibility: 'offline', lastVisibility: 'public', items: [], loop: true, countdown: 'bottom-right', configVersion: 1, createdAt: now(), updatedAt: now(),
                epoch: 1, grants: [], invites: [], blocked: {},
                playback: { itemId: null, position: 0, status: 'stopped', at: now(), version: 1 } };
            db.stations[stationId] = s; return summary(s, actor);
        });
    }
    async function edit(stationId, actor, input, req, progress = () => {}) {
        let s = station(stationId); authority(s, actor, 'edit');
        const expected = input.configVersion;
        if (expected !== s.configVersion) throw Object.assign(Error('STREAM_CONFLICT'), { expectedVersion: expected, currentVersion: s.configVersion });
        if (!Array.isArray(input.items) || input.items.length > 500) fail('STREAM_PLAYLIST_INVALID');
        const ids = new Set();
        const items = [], resolutions = new Map();
        for (const value of input.items) {
            progress({ phase: 'checking', completed: items.length, total: input.items.length, name: String(value.name || '').slice(0, 255) });
            if (!validId(value.id) || ids.has(value.id)) fail('STREAM_PLAYLIST_INVALID');
            ids.add(value.id);
            const previous = s.items.find(item => item.id === value.id);
            const locator = value.source && JSON.stringify(value.source);
            if (locator && !resolutions.has(locator)) resolutions.set(locator, await sources.resolve(value.source, actor, req));
            let resolved = locator ? resolutions.get(locator) : previous;
            if (!resolved?.source) fail('STREAM_SOURCE_INVALID');
            if (!locator) {
                const current = sources.stat?.(resolved.source);
                if (current) {
                    const mime = value => String(value || 'application/octet-stream').split(';')[0].trim().toLowerCase();
                    if (mime(current.type) !== mime(resolved.type) || current.size !== resolved.size || mediaKind(current.name, current.type) !== mediaKind(resolved.name, resolved.type)) fail('STREAM_SOURCE_CHANGED');
                    resolved = { ...resolved, name: current.name, type: current.type, size: current.size };
                }
            }
            const kind = mediaKind(resolved.name, resolved.type);
            const duration = ['video', 'audio'].includes(kind) ? number(value.duration ?? previous?.duration, 0.01, 31536000, 'STREAM_DURATION_REQUIRED') : null;
            const start = duration ? number(value.start ?? 0, 0, duration - 0.001, 'STREAM_START_INVALID') : 0;
            items.push({ id: value.id, name: resolved.name, type: resolved.type, size: resolved.size,
                source: copy(resolved.source), references: copy(resolved.references || []), kind, duration, start,
                stay: duration ? null : number(value.stay ?? 10, 0.1, 86400), unavailable: null });
            progress({ phase: 'checked', completed: items.length, total: input.items.length, name: resolved.name });
        }
        // Source resolution can await network metadata; recheck both authority
        // and configuration revision before committing any of the new list.
        s = station(stationId); authority(s, actor, 'edit');
        if (s.configVersion !== expected) throw Object.assign(Error('STREAM_CONFLICT'), { expectedVersion: expected, currentVersion: s.configVersion });
        progress({ phase: 'persisting', completed: items.length, total: input.items.length });
        return change(() => {
            advance(s); const oldIndex = s.items.findIndex(item => item.id === s.playback.itemId), oldPosition = position(s), oldStart = s.items[oldIndex]?.start || 0;
            const current = items.find(item => item.id === s.playback.itemId);
            s.items = items; s.loop = input.loop !== false;
            s.name = String(input.name || s.name).trim().slice(0, 120);
            if (!['top-left', 'top-right', 'bottom-left', 'bottom-right', 'edge'].includes(input.countdown || s.countdown)) fail('STREAM_PARAMETER_INVALID');
            s.countdown = input.countdown || s.countdown; s.configVersion++; s.updatedAt = now();
            const selected = current || items[Math.min(Math.max(oldIndex, 0), items.length - 1)];
            Object.assign(s.playback, { itemId: selected?.id || null, position: current ? Math.max(0, Math.min(oldPosition + oldStart - current.start, length(current))) : 0,
                at: now(), version: s.playback.version + 1, status: items.length ? s.playback.status : 'stopped' });
            return view(stationId, actor, { manage: true });
        });
    }
    function revision(stationId, actor, baseline) {
        const s = station(stationId); authority(s, actor, 'edit');
        const shape = value => ({ name: value.name, loop: value.loop !== false, countdown: value.countdown || 'bottom-right', items: (value.items || []).map(item => ({
            id: item.id, name: item.name, kind: item.kind, size: item.size, type: item.type, duration: item.duration || null, start: item.start || 0, stay: item.stay || null,
            source: { ...Object.fromEntries(['kind', 'fileId', 'diskSpace', 'sessionId', 'messageId'].map(key => [key, item.source?.[key] || ''])), accountId: item.source?.accountId || item.source?.userId || '' }
        })) });
        return { configVersion: s.configVersion, matches: JSON.stringify(shape(s)) === JSON.stringify(shape(baseline || {})) };
    }
    function control(stationId, actor, input) {
        const s = station(stationId); tick(); authority(s, actor);
        if (s.visibility === 'offline') fail('STREAM_OFFLINE');
        if (input.version !== s.playback.version) fail('STREAM_CONFLICT');
        return change(() => {
            if (input.action === 'retry') s.items.forEach(item => { item.unavailable = null; });
            const p = s.playback, items = available(s); p.position = position(s); p.at = now();
            if (!items.length) fail('STREAM_PLAYLIST_EMPTY');
            const index = Math.max(0, items.findIndex(item => item.id === p.itemId));
            if (input.action === 'play') { p.status = 'playing'; if (!p.itemId || p.position >= length(items[index])) { p.itemId = items[index].id; p.position = 0; } }
            else if (input.action === 'pause') p.status = 'paused';
            else if (input.action === 'stop') { p.status = 'stopped'; p.position = 0; }
            else if (input.action === 'retry') { if (!p.itemId) p.itemId = items[0].id; p.status = 'paused'; p.position = 0; }
            else if (['next', 'previous', 'select'].includes(input.action)) {
                const item = input.action === 'select' ? items.find(v => v.id === input.itemId)
                    : items[(index + (input.action === 'next' ? 1 : items.length - 1)) % items.length];
                if (!item) fail('STREAM_ITEM_NOT_FOUND'); p.itemId = item.id; p.position = 0;
            } else if (input.action === 'seek') p.position = number(input.position, 0, length(items[index]));
            else fail('STREAM_COMMAND_INVALID');
            if (p.status === 'playing' && !audience(s)) p.status = 'paused';
            p.controlVersion = (p.controlVersion || 0) + 1; p.version++; return view(stationId, actor, { manage: true });
        });
    }
    function visibility(stationId, actor, input) {
        const s = station(stationId); authority(s, actor);
        if (!['public', 'invite', 'offline'].includes(input.visibility)) fail('STREAM_PARAMETER_INVALID');
        if (input.version !== s.playback.version) fail('STREAM_CONFLICT');
        const privateReset = input.visibility === 'invite' && (s.visibility === 'public' || s.visibility === 'offline' && s.lastVisibility === 'public');
        if (privateReset && input.confirmReset !== true) fail('STREAM_CONFIRM_RESET');
        return change(() => {
            advance(s); s.playback.position = position(s); s.playback.at = now();
            if (privateReset) { s.epoch++; s.grants = []; s.invites.forEach(invite => { invite.revoked = true; }); }
            if (s.visibility !== 'offline') s.lastVisibility = s.visibility;
            s.visibility = input.visibility;
            s.updatedAt = now();
            if (s.visibility !== 'offline') s.lastVisibility = s.visibility;
            s.playback.version++; return summary(s, actor);
        });
    }
    function ownership(stationId, actor, action) {
        const s = station(stationId);
        if (actor.deviceId !== s.deviceId) fail('STREAM_LOCAL_ONLY');
        if (action === 'claim') {
            if (s.ownerId || !actor.userId) fail('STREAM_OWNER_REQUIRED');
        } else if (action === 'release') authority(s, actor, 'release'); else fail('STREAM_COMMAND_INVALID');
        return change(() => {
            s.ownerId = action === 'claim' ? actor.userId : null;
            s.login = s.ownerId ? copy(actor.logins?.find(proof => proof.id === s.ownerId)) : null;
            if (s.ownerId && !s.login) fail('STREAM_SOURCE_LOGIN_REQUIRED');
            s.configVersion++; s.updatedAt = now(); return summary(s, actor);
        });
    }
    function remove(stationId, actor) {
        const s = station(stationId); authority(s, actor, 'delete');
        return change(() => { delete db.stations[stationId]; return { ok: true }; });
    }
    function rootsForAliases(values) {
        return Object.keys(db.devices).filter(deviceId => values.includes(deviceId) || db.devices[deviceId].aliases?.some(alias => values.includes(alias)));
    }
    function relatedTo(actor) {
        const related = [...(db.devices[actor.deviceId]?.follows || []), ...visibleDevices(actor.deviceId, db.devices[actor.deviceId]?.aliases || [])];
        return new Set([...related, ...rootsForAliases(related)]);
    }
    function invitableDevices(actor) {
        const own = new Set([actor.deviceId, ...(db.devices[actor.deviceId]?.aliases || [])]), targets = new Map();
        for (const candidate of relatedTo(actor)) {
            const canonical = rootsForAliases([candidate])[0] || candidate;
            if (!own.has(candidate) && !own.has(canonical)) targets.set(canonical, { deviceId: canonical, name: db.devices[canonical]?.name || candidate });
        }
        return [...targets.values()];
    }
    function inviteTargets(invite, actor) {
        return invite.deviceId && (invite.deviceId === actor.deviceId || !db.devices[invite.deviceId] && db.devices[actor.deviceId]?.aliases?.includes(invite.deviceId));
    }
    function list(actor, kind = 'discover', ownerId = '') {
        tick();
        const visible = relatedTo(actor); visible.add(actor.deviceId);
        const bookmarks = db.bookmarks[actor.userId] || [];
        if (kind === 'bookmarks' && !actor.userId) fail('LOGIN_REQUIRED');
        const listed = Object.values(db.stations).filter(s => {
            if (kind === 'local') return s.deviceId === actor.deviceId;
            if (kind === 'bookmarks') return bookmarks.includes(s.id);
            if (kind === 'creator') return s.ownerId === ownerId && s.visibility === 'public' && !isBlocked(s, actor);
            if (!visible.has(s.deviceId) || s.visibility === 'offline' || isBlocked(s, actor)) return false;
            try { allowed(s, actor); return true; } catch (_) { return false; }
        }).map(s => summary(s, actor));
        if (kind === 'bookmarks') { const byId = new Map(listed.map(s => [s.id, s])); return bookmarks.slice().reverse().map(id => byId.get(id)).filter(Boolean); }
        return listed;
    }
    function bookmark(stationId, actor, add) {
        if (!actor.userId) fail('LOGIN_REQUIRED');
        if (add) allowed(station(stationId), actor);
        return change(() => {
            const entries = db.bookmarks[actor.userId] ||= [];
            const times = (db.bookmarkTimes ||= {})[actor.userId] ||= {};
            if (add && !entries.includes(stationId)) { if (entries.length >= 1000) fail('STREAM_LIMIT'); entries.push(stationId); times[stationId] = now(); }
            if (!add) { db.bookmarks[actor.userId] = entries.filter(value => value !== stationId); delete times[stationId]; }
            return { subscribed: add };
        });
    }
    function inviteStatus(invite) { return invite.revoked ? 'revoked' : invite.expiresAt && invite.expiresAt <= now() ? 'expired' : invite.response || (invite.deviceId || invite.sentAt ? 'sent' : 'generated'); }
    function invitation(stationId, actor, input) {
        const s = station(stationId); authority(s, actor);
        if (input.requestId) {
            if (!validId(input.requestId)) fail('STREAM_PARAMETER_INVALID');
            const previous = s.invites.find(value => value.requestId === input.requestId);
            if (previous) return { ...copy(previous), stationId, status: inviteStatus(previous) };
        }
        const requested = input.deviceId || null;
        const target = requested ? rootsForAliases([requested])[0] || requested : null;
        const visible = relatedTo(actor);
        if (target && (!validId(target) || !visible.has(target) || target === actor.deviceId)) fail('STREAM_TARGET_NOT_VISIBLE');
        if (s.invites.length >= 1000) fail('STREAM_LIMIT');
        const lifetime = input.hours === null ? null : number(input.hours ?? 24, 1 / 60, 87600);
        return change(() => {
            if (target) delete s.blocked[target];
            const invite = { id: id(), requestId: input.requestId || null, token: crypto.randomBytes(24).toString('base64url'), deviceId: target,
                epoch: s.epoch, createdAt: now(), expiresAt: lifetime === null ? null : now() + lifetime * 3600000,
                revoked: false, thumbnail: typeof input.thumbnail === 'string' && input.thumbnail.length <= 90000 && /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(input.thumbnail) ? input.thumbnail : null };
            s.invites.push(invite); return { ...copy(invite), stationId, status: inviteStatus(invite) };
        });
    }
    function invitations(stationId, actor) {
        const s = station(stationId); authority(s, actor);
        return s.invites.map(invite => ({ ...copy(invite), stationId, status: inviteStatus(invite) }));
    }
    function findInvite(token) {
        for (const s of Object.values(db.stations)) {
            const invite = s.invites.find(value => value.token === token || value.id === token);
            if (invite) return { s, invite };
        }
        fail('STREAM_INVITE_INVALID');
    }
    function checkInvite(s, invite, actor) {
        if (invite.deviceId && !inviteTargets(invite, actor)) fail('STREAM_INVITE_DEVICE');
        if (isBlocked(s, actor)) fail('STREAM_KICKED');
        if (invite.revoked || invite.epoch !== s.epoch) fail('STREAM_INVITE_REVOKED');
        if (invite.expiresAt && invite.expiresAt <= now()) fail('STREAM_INVITE_EXPIRED');
    }
    function inspectInvite(token, actor) {
        const { s, invite } = findInvite(token); checkInvite(s, invite, actor);
        return { station: summary(s, actor), deviceId: invite.deviceId, expiresAt: invite.expiresAt, thumbnail: invite.thumbnail };
    }
    function accept(token, actor, decision = 'accept') {
        const { s, invite } = findInvite(token); checkInvite(s, invite, actor);
        if (!['accept', 'reject'].includes(decision)) fail('STREAM_PARAMETER_INVALID');
        return change(() => {
            if (invite.deviceId) invite.deviceId = actor.deviceId;
            if (invite.deviceId) invite.response = decision === 'accept' ? 'accepted' : 'rejected';
            if (decision === 'accept') {
                const kind = invite.deviceId ? 'direct' : 'general';
                if (!s.grants.some(g => g.deviceId === actor.deviceId && g.kind === kind && g.epoch === s.epoch)) s.grants.push({ kind, deviceId: actor.deviceId, epoch: s.epoch });
                if (kind === 'general' && actor.userId && !s.grants.some(g => g.userId === actor.userId && g.epoch === s.epoch)) s.grants.push({ kind, userId: actor.userId, epoch: s.epoch });
            }
            return { stationId: s.id, accepted: decision === 'accept' };
        });
    }
    function revoke(stationId, actor, inviteId) {
        const s = station(stationId); authority(s, actor);
        const invite = s.invites.find(value => value.id === inviteId) || fail('STREAM_INVITE_INVALID');
        return change(() => { if (invite.deviceId) invite.revoked = true; else s.invites = s.invites.filter(value => value.id !== inviteId); return { ok: true }; });
    }
    function inbox(actor) {
        const result = [];
        for (const s of Object.values(db.stations)) for (const invite of s.invites) {
            if (!inviteTargets(invite, actor)) continue;
            result.push({ id: invite.id, stationId: s.id, token: invite.token, stationName: s.name,
                deviceName: db.devices[s.deviceId]?.name || s.deviceId, expiresAt: invite.expiresAt,
                createdAt: invite.createdAt, status: inviteStatus(invite), thumbnail: invite.thumbnail });
        }
        return result.slice(-300);
    }
    function delivered(token, actor) {
        const { invite } = findInvite(token);
        if (!inviteTargets(invite, actor)) fail('STREAM_INVITE_DEVICE');
        return change(() => { invite.deviceId = actor.deviceId; return { ok: true }; }); // Compatibility only; no delivery state.
    }
    function markInviteSent(token, actor) {
        const { s, invite } = findInvite(token); authority(s, actor); checkInvite(s, invite, actor);
        return change(() => { invite.sentAt ||= now(); return { ok: true }; });
    }
    function access(stationId, actor, target, allow, kind = 'device') {
        const s = station(stationId); authority(s, actor);
        if (kind === 'device') target = rootsForAliases([target])[0] || target;
        if (!['device', 'user'].includes(kind) || !validId(target) || kind === 'device' && target === s.deviceId || kind === 'user' && target === s.ownerId) fail('STREAM_DEVICE_INVALID');
        return change(() => {
            const blocked = kind === 'user' ? s.blockedUsers ||= {} : s.blocked;
            if (allow) delete blocked[target]; else blocked[target] = now() || 1;
            if (!allow) for (const [key, viewer] of viewers) if (viewer.stationId === stationId && (kind === 'user' ? viewer.actor.userId === target : viewer.deviceId === target)) { viewers.delete(key); closedViewers.set(key, now() + viewerLeaseMs); }
            if (!audience(s)) pauseWithoutAudience(s, now());
            return { ok: true };
        });
    }
    function report(stationId, actor, input) {
        tick(); const s = station(stationId); allowed(s, actor);
        const allowedStatus = ['playing', 'paused', 'buffering', 'waiting', 'blocked', 'error', 'reading'];
        if (!allowedStatus.includes(input.status)) fail('STREAM_PARAMETER_INVALID');
        const watchId = input.watchId || actor.deviceId;
        if (!validId(watchId)) fail('STREAM_DEVICE_INVALID');
        const key = stationId + ':' + actor.deviceId + ':' + watchId, empty = !audience(s);
        if (closedViewers.has(key)) fail('STREAM_WATCH_ENDED');
        if (!viewers.has(key) && viewers.size >= 1024) fail('STREAM_LIMIT');
        const report = { stationId, watchId, actor: { deviceId: actor.deviceId, userId: actor.userId }, deviceId: actor.deviceId, name: db.devices[actor.deviceId]?.name || actor.deviceId,
            itemId: s.items.some(v => v.id === input.itemId) ? input.itemId : null,
            position: number(input.position || 0, 0, 31536000), status: input.status, updatedAt: now(), expiresAt: now() + viewerLeaseMs };
        viewers.set(key, report);
        if (empty || s.playback.status === 'playing' && now() - s.playback.at >= 15000) change(() => {
            if (empty && available(s).length) {
                const items = available(s), p = s.playback;
                const current = items.find(item => item.id === p.itemId);
                if (!current || p.position >= length(current)) { p.itemId = items[0].id; p.position = 0; }
                p.status = 'playing'; p.at = now(); p.version++;
            } else { advance(s); s.playback.position = position(s); s.playback.at = now(); }
        });
        return { ok: true, station: view(stationId, actor) };
    }
    function unwatch(stationId, actor, watchId) {
        if (!validId(watchId)) fail('STREAM_DEVICE_INVALID');
        const key = stationId + ':' + actor.deviceId + ':' + watchId;
        closedViewers.set(key, now() + viewerLeaseMs);
        if (closedViewers.size > 2048) closedViewers.delete(closedViewers.keys().next().value);
        if (!viewers.has(key)) return { ok: true };
        viewers.delete(key); const s = db.stations[stationId];
        if (s && !audience(s)) change(() => pauseWithoutAudience(s, now()));
        return { ok: true };
    }
    async function resource(stationId, itemId, actor, reference) {
        const s = station(stationId); tick(); allowed(s, actor);
        const item = s.items.find(value => value.id === itemId) || fail('STREAM_ITEM_NOT_FOUND');
        const source = reference ? item.references.find(value => value.id === reference)?.source : item.source;
        if (!source) fail('STREAM_SOURCE_INVALID');
        return { source: copy(source), item: copy(item), deviceId: s.deviceId, epoch: s.epoch, sourceVersion: digest(JSON.stringify(source)) };
    }
    function unavailable(stationId, itemId, reason) {
        if (transientSourceError(reason)) return;
        const s = station(stationId), item = s.items.find(value => value.id === itemId);
        if (!item || item.unavailable && !transientSourceError(item.unavailable)) return;
        change(() => {
            item.unavailable = String(reason).slice(0, 100);
            if (s.playback.itemId === item.id) {
                const oldIndex = s.items.indexOf(item), next = [...s.items.slice(oldIndex + 1), ...(s.loop ? s.items.slice(0, oldIndex) : [])].find(value => !value.unavailable || transientSourceError(value.unavailable));
                Object.assign(s.playback, { itemId: next?.id || null, position: 0, at: now(), version: s.playback.version + 1,
                    status: next ? s.playback.status : 'stopped' });
            }
        });
    }
    function references(stationId, itemId, actor) {
        const s = station(stationId); allowed(s, actor);
        return copy(s.items.find(item => item.id === itemId)?.references || []).map(({ id, url }) => ({ id, url }));
    }
    return { register, authenticate, syncDevice, create, edit, view, control, visibility, ownership, remove, list, bookmark,
        invitation, invitations, inspectInvite, accept, revoke, inbox, delivered, markInviteSent, access, report, unwatch, resource, unavailable, references, revision,
        tick, revokeLogin, authority, station, allowed, sourceLoggedIn, rootsForAliases, invitableDevices, snapshot: () => copy(db) };
}
module.exports = { createStreamingConsole, mediaKind, digest };
