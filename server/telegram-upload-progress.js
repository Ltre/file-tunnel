'use strict';
const { AsyncLocalStorage } = require('node:async_hooks');
const diagnostics = require('node:diagnostics_channel');

// Correlate only the fetch belonging to this upload. Proxy CONNECT requests and
// concurrent Telegram calls must never contribute to its progress.
const contexts = new AsyncLocalStorage();
const requests = new WeakMap();
diagnostics.channel('undici:request:create').subscribe(({ request }) => {
    const tracker = contexts.getStore();
    if (!tracker?.active || request.method !== 'POST') return;
    if (String(request.origin) + request.path !== tracker.url) return;
    requests.set(request, tracker); tracker.requests.add(request);
});
diagnostics.channel('undici:request:bodyChunkSent').subscribe(({ request, chunk }) => {
    const tracker = requests.get(request);
    if (tracker?.active) tracker.sent(typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.byteLength);
});
diagnostics.channel('undici:request:bodySent').subscribe(({ request }) => {
    const tracker = requests.get(request);
    if (tracker?.active) tracker.sent(0, true);
});

function observeTelegramUpload(url, ranges = [], onProgress = () => {}) {
    const total = ranges.reduce((sum, range) => sum + range.end - range.start, 0);
    const tracker = {
        active: true, url, requests: new Set(), wireBytes: 0, payloadBytes: 0,
        lastSentAt: 0, bodySentAt: 0, lastNotifiedAt: 0, lastNotifiedBytes: 0, observed: false,
        sent(length, complete = false) {
            const before = this.wireBytes;
            this.wireBytes += length; this.observed = true;
            this.lastSentAt = Date.now();
            let current, boundary = false;
            for (const range of ranges) {
                const bytes = Math.max(0, Math.min(this.wireBytes, range.end) - Math.max(before, range.start));
                this.payloadBytes += bytes;
                if (bytes) current = range;
                if (before < range.end && this.wireBytes >= range.end) boundary = true;
            }
            if (complete) this.bodySentAt = this.lastSentAt;
            if (!complete && !boundary && !(this.payloadBytes > 0 && this.lastNotifiedBytes === 0) && this.lastNotifiedAt && this.lastSentAt - this.lastNotifiedAt < 250) return;
            this.lastNotifiedAt = this.lastSentAt;
            this.lastNotifiedBytes = this.payloadBytes;
            // Diagnostics subscribers execute inside the HTTP client. A UI or
            // persistence observer failure must not throw into its transport.
            try { onProgress({ bytes: this.payloadBytes, total, name: current?.name || '', complete }); }
            catch (_) {}
        }
    };
    return {
        run: work => contexts.run(tracker, work),
        snapshot: () => ({ sentBodyBytes: tracker.wireBytes, sentFileBytes: tracker.observed && ranges.length ? tracker.payloadBytes : null,
            lastSentAt: tracker.lastSentAt, bodySentAt: tracker.bodySentAt }),
        close() { tracker.active = false; for (const request of tracker.requests) requests.delete(request); tracker.requests.clear(); tracker.url = ''; }
    };
}
module.exports = { observeTelegramUpload };
