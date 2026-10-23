'use strict';
// Short-lived, ticket-scoped read-ahead. No disk files or shared source cache.
function createStreamingBuffer({ now = Date.now, maxBytes = 64 * 1024 * 1024, perTicket = 16 * 1024 * 1024, ttl = 45000 } = {}) {
    const entries = new Map(); let bytes = 0;
    function remove(key) { const value = entries.get(key); if (value) { bytes -= value.body.length; entries.delete(key); } }
    function sweep() { for (const [key, value] of entries) if (value.expiresAt <= now()) remove(key); }
    function get(ticket, start, end) {
        sweep();
        for (const [key, value] of entries) if (value.ticket === ticket && value.start <= start && value.start + value.body.length > end) {
            entries.delete(key); entries.set(key, value); return value.body.subarray(start - value.start, end - value.start + 1);
        }
        return null;
    }
    function put(ticket, start, body) {
        sweep(); if (body.length > perTicket) return;
        const key = ticket + ':' + start; remove(key);
        let ownBytes = [...entries.values()].filter(value => value.ticket === ticket).reduce((n, value) => n + value.body.length, 0);
        for (const [oldKey, value] of entries) { if (ownBytes + body.length <= perTicket) break; if (value.ticket === ticket) { ownBytes -= value.body.length; remove(oldKey); } }
        while (bytes + body.length > maxBytes && entries.size) remove(entries.keys().next().value);
        entries.set(key, { ticket, start, body, expiresAt: now() + ttl }); bytes += body.length;
    }
    return { get, put, clear() { entries.clear(); bytes = 0; }, get bytes() { sweep(); return bytes; } };
}
module.exports = { createStreamingBuffer };
