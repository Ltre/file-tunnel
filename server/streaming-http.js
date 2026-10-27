'use strict';
const express = require('express');
const rateLimit = require('express-rate-limit');
const crypto = require('node:crypto');
function waitForDrain(res) {
    return new Promise((resolve, reject) => {
        const cleanup = () => { res.removeListener('drain', drained); res.removeListener('close', closed); res.removeListener('error', failed); };
        const drained = () => { cleanup(); resolve(); };
        const failed = error => { cleanup(); reject(error); };
        const closed = () => failed(new Error('STREAM_READ_CANCELLED'));
        res.once('drain', drained); res.once('close', closed); res.once('error', failed);
        if (res.destroyed || res.writableEnded) closed();
    });
}
const { createStreamingConsole, digest } = require('./streaming-console');
const { parseByteRange } = require('./object-storage');
const { Readable } = require('node:stream');
const { createStreamingBuffer } = require('./streaming-buffer');
const { createStreamingCovers } = require('./streaming-covers');
const { createStreamingPeers } = require('./streaming-peers');

function registerStreamingConsole(app, { dataDir, identity, proofs, user, loginRevoked, origin,
    visibleDevices, sources, tunnel, now = Date.now }) {
    const listeners = new Map(); let scheduled = false;
    const publish = () => { if (scheduled) return; scheduled = true; queueMicrotask(() => { scheduled = false; for (const listener of listeners.values()) listener.send(); }); };
    const covers=createStreamingCovers(dataDir);
    const service = createStreamingConsole({ dataDir, user, loginRevoked, visibleDevices, sources, covers, now, onChange: publish });
    const router = express.Router(), tickets = new Map(), readAhead = createStreamingBuffer({ now });
    const wrap = action => async (req, res, next) => { try { await action(req, res, next); } catch (error) { next(error); } };
    const actor = req => {
        const deviceId = service.authenticate(req.get('X-Stream-Device'), req.get('X-Stream-Key'));
        return { deviceId, userId: identity(req)?.id || null, logins: proofs(req) };
    };
    async function peerResource(token, viewer) {
        const ticket = tickets.get(token);
        if (!ticket || ticket.preview || ticket.expiresAt <= now() || ticket.deviceId !== viewer.deviceId || ticket.userId !== viewer.userId) throw Error('STREAM_TICKET_EXPIRED');
        const resource = await service.resource(ticket.stationId,ticket.itemId,viewer,ticket.reference);
        if(resource.epoch !== ticket.epoch || resource.sourceVersion !== ticket.sourceVersion)throw Error('STREAM_TICKET_EXPIRED');
        const metadata = sources.stat(resource.source);
        const key = crypto.createHash('sha256').update(JSON.stringify([ticket.stationId,ticket.itemId,ticket.reference,ticket.epoch,ticket.sourceVersion])).digest('hex');
        // Do not send disk cookies, login proofs or tunnel grants to peers.
        const fields=resource.source.kind==='disk'?['kind']:['kind','sessionId','messageId','fileId','deviceId','size','name','type'];
        const source = Object.fromEntries(fields.filter(name=>resource.source[name]!==undefined).map(name=>[name,resource.source[name]]));
        return { key, source, deviceId:resource.deviceId, size:metadata.size, type:metadata.type };
    }
    const peers = createStreamingPeers({ authorize:peerResource, providers:resource=>sources.peerProviders?.(resource)||[], now });
    router.use((_req, res, next) => { res.set({ 'Cache-Control': 'private, no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' }); next(); });
    router.use((req, res, next) => {
        if (req.get('Sec-Fetch-Site') === 'cross-site' || req.get('Origin') && req.get('Origin') !== origin(req)) return res.status(403).json({ error: 'ORIGIN_MISMATCH' });
        next();
    });
    // Streaming has long-lived viewers and Range reads. Keep its budget local
    // to this router so a busy station cannot exhaust the page/tunnel budget.
    router.use(rateLimit({ windowMs: 60000, max: 1200, standardHeaders: true, legacyHeaders: false,
        handler: (_req, res) => res.status(429).json({ error: 'STREAM_RATE_LIMIT' }) }));
    router.post('/devices', rateLimit({ windowMs: 60000, max: 120, standardHeaders: true, legacyHeaders: false }), wrap((req, res) => {
        const result = service.register(req.body?.deviceId, req.body?.key, req.body?.name);
        res.cookie('stream_device_' + digest(result.deviceId).slice(0, 20), req.body.key, { httpOnly: true, sameSite: 'strict', secure: origin(req).startsWith('https:'), path: '/', maxAge: 30 * 86400000 });
        res.json(result);
    }));
    router.get('/media/:ticket', wrap(async (req, res) => {
        const ticket = tickets.get(req.params.ticket);
        if (!ticket || ticket.expiresAt < now()) throw new Error('STREAM_TICKET_EXPIRED');
        const cookies = new Map(String(req.headers.cookie || '').split(';').map(part => part.trim().split('=')));
        const proof = req.get('X-Stream-Device') === ticket.deviceId ? req.get('X-Stream-Key') : cookies.get('stream_device_' + digest(ticket.deviceId).slice(0, 20));
        service.authenticate(ticket.deviceId, proof);
        const selected = Object.create(req); selected.headers = { ...req.headers, 'x-disk-account': ticket.userId || '' };
        selected.query = { ...req.query }; delete selected.query.disk_account;
        const a = { deviceId: ticket.deviceId, userId: identity(selected)?.id || null };
        const get = async () => {
            if (ticket.preview) {
                if (ticket.userId && a.userId !== ticket.userId) throw new Error('LOGIN_REQUIRED');
                sources.stat(ticket.source); return { source: ticket.source, deviceId: ticket.deviceId, epoch: 0 };
            }
            const value = await service.resource(ticket.stationId, ticket.itemId, a, ticket.reference);
            if (value.sourceVersion !== ticket.sourceVersion || value.epoch !== ticket.epoch) throw new Error('STREAM_TICKET_EXPIRED'); return value; };
        const resource = await get();
        if (resource.epoch !== ticket.epoch) throw new Error('STREAM_TICKET_EXPIRED');
        let metadata;
        try { metadata = sources.stat(resource.source); }
        catch (error) { if (!ticket.preview && !ticket.reference && ['STREAM_SOURCE_DELETED', 'STREAM_SOURCE_REVOKED'].includes(error.message)) service.unavailable(ticket.stationId, ticket.itemId, error.message); throw error; }
        const size = Number(metadata.size);
        let range;
        try { range = size ? parseByteRange(req.get('Range'), size) : { start: 0, end: -1, partial: false }; }
        catch (_) { res.status(416).set('Content-Range', 'bytes */' + size).end(); return; }
        if (!range || size && (range.start < 0 || range.end >= size)) { res.status(416).set('Content-Range', 'bytes */' + size).end(); return; }
        const warming = req.get('X-Stream-Buffer') === '1';
        if (warming && (!range.partial || range.end - range.start + 1 > 4 * 1024 * 1024)) { res.status(416).end(); return; }
        const controller = new AbortController(); res.once('close', () => { if (!res.writableEnded) controller.abort(); });
        const mime = /^(video|audio|image)\//.test(metadata.type || '') && metadata.type !== 'image/svg+xml' ? metadata.type : 'text/plain; charset=utf-8';
        const headers = () => {
            res.status(range.partial ? 206 : 200).set({ 'Content-Type': mime, 'Content-Length': String(Math.max(0, range.end - range.start + 1)),
                'Accept-Ranges': 'bytes', 'Content-Security-Policy': "sandbox; default-src 'none'" });
            if (range.partial) res.set('Content-Range', `bytes ${range.start}-${range.end}/${size}`);
        };
        if (req.method === 'HEAD' || !size) { headers(); res.end(); return; }
        try {
            for (let start = range.start; start <= range.end && !controller.signal.aborted;) {
                await get();
                // A broker supplies a whole requested block before returning a
                // stream. Deliver a small first block for prompt startup/seek;
                // subsequent blocks retain the existing 1 MiB/cache boundaries.
                // Warming keeps full blocks so native reads can reuse them.
                const end = Math.min(range.end, (Math.floor(start / sources.MAX_CHUNK) + 1) * sources.MAX_CHUNK - 1,
                    start === range.start && !warming ? start + 64 * 1024 - 1 : Infinity);
                const cached = readAhead.get(req.params.ticket, start, end);
                const stream = cached ? Readable.from([cached]) : await sources.read(resource.source, start, end, controller.signal, resource.deviceId);
                try {
                    await get(); // Access may have changed while the provider was reading.
                    if (!res.headersSent) headers();
                    const buffered = []; let bufferedSize = 0;
                    for await (const chunk of stream) {
                        await get();
                        if (warming && !cached) { bufferedSize += chunk.length; if (bufferedSize > sources.MAX_CHUNK) throw Error('STREAM_READ_INVALID'); buffered.push(Buffer.from(chunk)); continue; }
                        if (!res.write(chunk)) await waitForDrain(res);
                    }
                    if (warming && !cached) {
                        if (controller.signal.aborted || bufferedSize !== end - start + 1) throw Error('STREAM_READ_INVALID');
                        await get(); const bytes = Buffer.concat(buffered); readAhead.put(req.params.ticket, start, bytes);
                        // Publish the bounded warm chunk before its HTTP body can
                        // complete; the next native read may start immediately.
                        if (!res.write(bytes)) await waitForDrain(res);
                    }
                } finally { stream.destroy(); }
                start = end + 1;
            }
            res.end();
        } catch (error) {
            if (!ticket.preview && !ticket.reference && ['STREAM_SOURCE_DELETED', 'STREAM_SOURCE_MISSING', 'STREAM_SOURCE_REVOKED', 'STREAM_PROVIDER_OFFLINE'].includes(error.message)) service.unavailable(ticket.stationId, ticket.itemId, error.message);
            throw error;
        }
    }));
    router.get('/stations/:id/covers/:hash',wrap((req,res)=>{
        const deviceId=String(req.query.device || req.get('X-Stream-Device') || '');
        const cookies=new Map(String(req.headers.cookie||'').split(';').map(part=>part.trim().split('=')));
        service.authenticate(deviceId,req.get('X-Stream-Key')||cookies.get('stream_device_'+digest(deviceId).slice(0,20)));
        const selected=Object.create(req);selected.headers={...req.headers,'x-disk-account':String(req.query.account || '')};selected.query={...req.query};delete selected.query.disk_account;
        const hash=service.cover(req.params.id,{deviceId,userId:identity(selected)?.id||null});
        if(!hash || hash!==req.params.hash)throw Error('STREAM_COVER_INVALID');
        const body=covers.read(req.params.id,hash),etag='"'+hash+'"';
        res.set({'Content-Type':'image/png','Cache-Control':'private, max-age=86400, immutable',ETag:etag,'Content-Security-Policy':"sandbox; default-src 'none'"});
        if(req.get('If-None-Match')===etag)return res.status(304).end();res.send(body);
    }));
    router.use((req, _res, next) => { try { req.streamActor = actor(req); next(); } catch (error) { next(error); } });
    router.post('/stations/:id/cover',express.raw({type:'image/png',limit:'2mb'}),wrap((req,res)=>{
        service.cover(req.params.id,req.streamActor,true);res.json({coverId:covers.put(req.params.id,req.body)});
    }));
    router.post('/sync', wrap((req, res) => {
        const aliases = (Array.isArray(req.body?.tunnels) ? req.body.tunnels : []).slice(0, 500).flatMap(entry => { try { return [tunnel.alias(entry, req.streamActor)]; } catch (_) { return []; } });
        service.syncDevice(req.streamActor, { follows: Array.isArray(req.body?.follows) ? req.body.follows : [], aliases });
        res.json({ identity: identity(req), accounts: proofs(req).map(({ hash, ...proof }) => proof), invitations: service.inbox(req.streamActor) });
    }));
    router.get('/devices', wrap((req, res) => res.json({ devices: service.invitableDevices(req.streamActor) })));
    router.get('/stations', wrap((req, res) => res.json({ stations: service.list(req.streamActor, req.query.kind, req.query.ownerId) })));
    router.post('/stations', wrap((req, res) => res.status(201).json(service.create(req.streamActor, req.body || {}))));
    router.get('/stations/:id', wrap((req, res) => res.json(service.view(req.params.id, req.streamActor, { manage: req.query.manage === '1' }))));
    router.get('/stations/:id/edit-config',wrap((req,res)=>{
        const s=service.station(req.params.id);service.authority(s,req.streamActor,'edit');
        const items=s.items.map(item=>{const source=Object.fromEntries(['kind','fileId','name','type','size','diskSpace','sessionId','messageId'].filter(key=>item.source[key]!==undefined).map(key=>[key,item.source[key]]));if(item.source.kind==='disk')source.accountId=item.source.userId;return {...item,source,references:undefined,sourceSaved:true};});
        res.json({name:s.name,coverId:s.coverId || '',configVersion:s.configVersion,loop:s.loop,countdown:s.countdown,items});
    }));
    router.post('/stations/:id/revision', wrap((req, res) => res.json(service.revision(req.params.id, req.streamActor, req.body))));
    router.get('/stations/:id/events', wrap((req, res) => {
        const deviceId = req.streamActor.deviceId;
        if (listeners.size >= 128 || [...listeners.values()].filter(value => value.deviceId === deviceId).length >= 16) throw new Error('STREAM_LIMIT');
        service.view(req.params.id, req.streamActor);
        res.status(200).set({ 'Content-Type': 'application/x-ndjson; charset=utf-8', 'X-Accel-Buffering': 'no', 'Cache-Control': 'private, no-store, no-transform' });
        res.flushHeaders(); const key = crypto.randomUUID();
        const close = () => { clearInterval(heartbeat); listeners.delete(key); };
        const send = () => {
            if (res.writableEnded || res.destroyed) { close(); return; }
            try { if (!res.write(JSON.stringify({ station: service.view(req.params.id, actor(req)) }) + '\n')) res.end(); }
            catch (error) { close(); if (!res.writableEnded && !res.destroyed) res.end(JSON.stringify({ error: error.message }) + '\n'); }
        };
        const heartbeat = setInterval(send, 10000); heartbeat.unref();
        res.once('close', close); res.once('finish', close); listeners.set(key, { deviceId, send, end: () => res.end() }); send();
    }));
    router.put('/stations/:id', wrap(async (req, res) => {
        if (!req.get('Accept')?.includes('application/x-ndjson')) return res.json(await service.edit(req.params.id, req.streamActor, req.body || {}, req));
        // Progress describes real validation work; only the final record confirms persistence.
        res.type('application/x-ndjson').set('X-Accel-Buffering', 'no'); res.flushHeaders();
        const send = value => { if (!res.destroyed && !res.writableEnded) res.write(JSON.stringify(value) + '\n'); };
        try { const result = await service.edit(req.params.id, req.streamActor, req.body || {}, req, progress => send({ progress })); send({ result }); }
        catch (error) { send({ error: /^(STREAM_[A-Z_]+|LOGIN_REQUIRED)$/.test(error.message) ? error.message : 'STREAM_SOURCE_UNAVAILABLE', ...(error.message === 'STREAM_CONFLICT' ? { expectedVersion: error.expectedVersion, currentVersion: error.currentVersion } : {}) }); }
        res.end();
    }));
    router.delete('/stations/:id', wrap((req, res) => res.json(service.remove(req.params.id, req.streamActor))));
    router.post('/stations/:id/control', wrap((req, res) => res.json(service.control(req.params.id, req.streamActor, req.body || {}))));
    router.post('/stations/:id/visibility', wrap((req, res) => res.json(service.visibility(req.params.id, req.streamActor, req.body || {}))));
    router.post('/stations/:id/ownership', wrap((req, res) => res.json(service.ownership(req.params.id, req.streamActor, req.body?.action))));
    router.put('/stations/:id/bookmark', wrap((req, res) => res.json(service.bookmark(req.params.id, req.streamActor, true))));
    router.delete('/stations/:id/bookmark', wrap((req, res) => res.json(service.bookmark(req.params.id, req.streamActor, false))));
    router.get('/stations/:id/invitations', wrap((req, res) => res.json({ invitations: service.invitations(req.params.id, req.streamActor) })));
    router.post('/stations/:id/invitations', wrap((req, res) => res.status(201).json(service.invitation(req.params.id, req.streamActor, req.body || {}))));
    router.delete('/stations/:id/invitations/:inviteId', wrap((req, res) => res.json(service.revoke(req.params.id, req.streamActor, req.params.inviteId))));
    router.get('/invitations/:token', wrap((req, res) => res.json(service.inspectInvite(req.params.token, req.streamActor))));
    router.post('/invitations/:token', wrap((req, res) => res.json(service.accept(req.params.token, req.streamActor, req.body?.decision))));
    router.get('/inbox', wrap((req, res) => res.json({ invitations: service.inbox(req.streamActor) })));
    router.post('/invitations/:token/delivered', wrap((req, res) => res.json(service.delivered(req.params.token, req.streamActor))));
    router.post('/stations/:id/access', wrap((req, res) => res.json(service.access(req.params.id, req.streamActor, req.body?.userId || req.body?.deviceId, req.body?.allow === true, req.body?.userId ? 'user' : 'device'))));
    router.post('/stations/:id/report', wrap((req, res) => res.json(service.report(req.params.id, req.streamActor, req.body || {}))));
    router.post('/stations/:id/unwatch', wrap((req, res) => res.json(service.unwatch(req.params.id, req.streamActor, req.body?.watchId))));
    router.post('/stations/:id/ticket', wrap(async (req, res) => {
        const a = req.streamActor, itemId = req.body?.itemId, reference = req.body?.reference;
        const resource = await service.resource(req.params.id, itemId, a, reference);
        for (const [key, ticket] of tickets) if (ticket.expiresAt <= now()) tickets.delete(key);
        if (tickets.size >= 4096) throw new Error('STREAM_LIMIT');
        const token = crypto.randomBytes(24).toString('base64url'), expiresAt = now() + 3600000;
        tickets.set(token, { stationId: req.params.id, itemId, reference, epoch: resource.epoch, sourceVersion: resource.sourceVersion, deviceId: a.deviceId, userId: a.userId, expiresAt });
        const metadata = sources.stat(resource.source);
        res.json({ url: '/api/streaming/media/' + token, expiresAt, size: metadata.size, type: metadata.type, references: service.references(req.params.id, itemId, a) });
    }));
    router.post(['/preview', '/blob-preview'], wrap(async (req, res) => {
        const allFiles = req.path === '/blob-preview';
        if (allFiles && req.body?.source?.kind !== 'tunnel') throw new Error('STREAM_TUNNEL_DENIED');
        const a = req.streamActor, resolved = await sources.resolve(req.body?.source, a, req, allFiles);
        for (const [key, ticket] of tickets) if (ticket.expiresAt <= now()) tickets.delete(key);
        if (tickets.size >= 4096) throw new Error('STREAM_LIMIT');
        const token = crypto.randomBytes(24).toString('base64url'), expiresAt = now() + 600000;
        tickets.set(token, { preview: true, source: resolved.source, epoch: 0, deviceId: a.deviceId, userId: a.userId, expiresAt });
        res.json({ url: '/api/streaming/media/' + token, expiresAt });
    }));
    router.get('/provider-work', wrap(async (req, res) => {
        const controller = new AbortController(); res.once('close', () => controller.abort());
        const requests=await sources.broker.poll(req.streamActor.deviceId,controller.signal,req.get('X-Stream-Provider')||'legacy',req.get('X-Stream-Wait'));
        const offers=req.get('X-Stream-Peer')?peers.poll(req.streamActor,req.ip,req.get('X-Stream-Peer'),req.get('X-Stream-Cache')):[];
        res.json({requests,offers});
    }));
    router.post('/peers/candidates',wrap(async(req,res)=>res.json({providers:await peers.candidates(req.streamActor,req.ip,req.body||{})})));
    router.post('/peers/validate',wrap(async(req,res)=>{const {key,size,type}=await peerResource(req.body?.ticket,req.streamActor);res.json({key,size,type});}));
    router.post('/peers/offers',wrap(async(req,res)=>res.json(await peers.offer(req.streamActor,req.ip,req.body||{},()=>actor(req)))));
    router.post('/peers/:id/check',wrap(async(req,res)=>res.json(await peers.check(req.streamActor,req.get('X-Stream-Peer'),req.params.id))));
    router.post('/peers/:id/answer',wrap(async(req,res)=>res.json(await peers.answer(req.streamActor,req.get('X-Stream-Peer'),req.params.id,req.body?.sdp))));
    router.post('/provider-work/:requestId', express.raw({ type: 'application/octet-stream', limit: sources.MAX_CHUNK }), wrap((req, res) => {
        sources.broker.provide(req.streamActor.deviceId, req.params.requestId, req.body, req.get('X-Stream-Error'));
        res.json({ ok: true });
    }));
    // The tunnel adapter uses the tunnel's signed admission and existing read /
    // send capabilities; station permissions never turn into tunnel membership.
    router.post('/tunnel-candidates', wrap((req, res) => res.json(tunnel.candidates(req.body || {}, req.streamActor))));
    router.post('/tunnel-resources', wrap((req, res) => res.json(tunnel.resources(req.body || {}, req.streamActor))));
    router.post('/tunnel-markdown', wrap((req, res) => res.json(tunnel.send(req.body || {}, req.streamActor))));
    router.use((error, _req, res, _next) => {
        if (res.headersSent) { res.destroy(); return; }
        const code = String(error.message || 'STREAM_FAILED');
        const publicCode = /^(STREAM_[A-Z_]+|LOGIN_REQUIRED|ORIGIN_MISMATCH)$/.test(code) ? code : 'STREAM_SOURCE_UNAVAILABLE';
        res.status(code === 'STREAM_CONFLICT' ? 409 : code === 'STREAM_NOT_FOUND' ? 404 : /REQUIRED|DENIED|KICKED|LOCAL_ONLY|DEVICE$|REVOKED|EXPIRED/.test(code) ? 403 : 422).json({ error: publicCode, ...(code === 'STREAM_CONFLICT' ? { expectedVersion: error.expectedVersion, currentVersion: error.currentVersion } : {}) });
    });
    app.use('/api/streaming', router);
    const timer = setInterval(() => { try { service.tick(); } catch (error) { console.warn('streaming clock persistence failed:', error.code || error.message); } }, 1000); timer.unref();
    return { service, close() { clearInterval(timer); peers.close(); sources.broker.close(); tickets.clear(); readAhead.clear(); for (const listener of listeners.values()) listener.end(); listeners.clear(); } };
}
module.exports = { registerStreamingConsole, waitForDrain };
