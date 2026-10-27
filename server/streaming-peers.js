'use strict';
const crypto = require('node:crypto');

// Signaling only. Bytes travel on a host-candidate WebRTC data channel. Network
// addresses are a candidate hint, never an authorization grant.
function createStreamingPeers({ authorize, providers, now = Date.now }) {
    const clients = new Map(), sessions = new Map();
    const fail = () => { throw Error('STREAM_PEER_UNAVAILABLE'); };
    const clientKey = (actor, id) => actor.deviceId + ':' + id;
    const validId = id => /^[\w-]{8,80}$/.test(id || '');
    function sweep() {
        for (const [id, item] of clients) if (item.seen < now() - 45000) { item.wake?.([]); clients.delete(id); }
        for (const [id, item] of sessions) if (item.expiresAt <= now()) { item.finish?.(null); sessions.delete(id); }
    }
    async function candidates(actor, network, data) {
        sweep(); if (!validId(data.clientId)) fail();
        const resource = await authorize(data.ticket, actor);
        const allowed = new Set(providers(resource));
        return [...clients.values()].filter(client => client.key !== clientKey(actor,data.clientId) && client.network === network &&
            (client.cache.has(resource.key) || allowed.has(client.actor.deviceId)))
            .sort((a,b) => Number(b.cache.has(resource.key))-Number(a.cache.has(resource.key)))
            .slice(0,3).map(client => client.key);
    }
    function poll(actor, network, id, cache) {
        sweep(); if (!validId(id)) fail(); const key = clientKey(actor,id);
        if (!clients.has(key) && clients.size >= 128) fail();
        let client = clients.get(key);
        if (!client) { client = { key, queue:[] }; clients.set(key,client); }
        client.actor = actor; client.network = network; client.seen = now();
        client.cache = new Set(String(cache || '').split(',').filter(key => /^[a-f0-9]{64}$/.test(key)).slice(0,64));
        return client.queue.splice(0);
    }
    async function offer(actor, network, data, actorNow) {
        if (!(await candidates(actor,network,data)).includes(data.provider) || typeof data.sdp !== 'string' || data.sdp.length > 16000 || sessions.size >= 128) fail();
        const resource = await authorize(data.ticket,actor), id = crypto.randomUUID(), provider = clients.get(data.provider);
        if (!provider || provider.queue.length >= 8) fail();
        const session = { id, provider:data.provider, viewer:actor.deviceId, ticket:data.ticket, actorNow, expiresAt:now()+300000 };
        sessions.set(id,session);
        return new Promise(resolve => {
            const timer = setTimeout(() => { session.finish(null); sessions.delete(id); },6000);
            session.finish = answer => { clearTimeout(timer); session.finish = null; resolve(answer ? { id, sdp:answer, expiresAt:session.expiresAt } : null); };
            provider.queue.push({ id, sdp:data.sdp, key:resource.key });
            provider.wake?.(provider.queue.splice(0));
        });
    }
    async function check(actor, clientId, id) {
        sweep(); const session = sessions.get(id);
        if (!session || session.provider !== clientKey(actor,clientId)) fail();
        return authorize(session.ticket,session.actorNow());
    }
    async function answer(actor, clientId, id, sdp) {
        await check(actor,clientId,id); const session = sessions.get(id);
        if (!session.finish || typeof sdp !== 'string' || sdp.length > 16000) fail();
        session.finish(sdp); return { ok:true };
    }
    return { poll, candidates, offer, check, answer,
        close() { for(const client of clients.values())client.wake?.([]);for(const session of sessions.values())session.finish?.(null);clients.clear();sessions.clear(); } };
}
module.exports = { createStreamingPeers };
