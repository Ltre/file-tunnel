'use strict';
const crypto = require('node:crypto');

const abortError = () => Object.assign(new Error('OPERATION_CANCELLED'), { name: 'AbortError' });
const botKey = backend => crypto.createHash('sha256').update(String(backend.baseUrl) + '\0' + String(backend.token)).digest('hex');

// Uploads use their own fair scheduler. A slow chat does not hold a global slot
// while waiting for pacing or retry_after, and no unrelated API adopts it.
function createTelegramUploadScheduler({ globalLimit = 4, botLimit = 4, chatLimit = 2, pacingMs = 1000, now = Date.now, random = Math.random, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
    const queue = [], bots = new Map(), chats = new Map(), owners = new Map();
    let inflight = 0, timer = null, dispatchSequence = 0, sequence = 0, retries = 0, rateLimits = 0;
    const retireOwner = owner => {
        if (!owners.get(owner)?.inflight && !queue.some(item => item.owner === owner)) owners.delete(owner);
    };
    const state = backend => {
        const bot = botKey(backend), chat = bot + ':' + String(backend.channelId);
        if (!bots.has(bot)) bots.set(bot, { inflight: 0 });
        if (!chats.has(chat)) chats.set(chat, { inflight: 0, nextAt: 0, restrictedUntil: 0 });
        return { bot: bots.get(bot), chat: chats.get(chat) };
    };
    function pump() {
        if (timer) { clearTimer(timer); timer = null; }
        let waitAt = Infinity;
        while (inflight < globalLimit) {
            const candidates = [];
            for (let index = 0; index < queue.length; index++) {
                const item = queue[index], current = state(item.backend);
                const limit = current.chat.restrictedUntil > now() ? 1 : chatLimit;
                if (current.bot.inflight >= botLimit || current.chat.inflight >= limit) continue;
                if (current.chat.nextAt > now()) { waitAt = Math.min(waitAt, current.chat.nextAt); continue; }
                candidates.push({ index, item, current });
            }
            if (!candidates.length) break;
            const priority = Math.min(...candidates.map(candidate => candidate.item.priority));
            const eligible = candidates.filter(candidate => candidate.item.priority === priority);
            // Choose the longest-waiting task, not merely an owner different
            // from the last one. Two busy owners must not keep alternating
            // ahead of the remaining uploads when many jobs share a chat.
            const choice = eligible.reduce((selected, candidate) =>
                owners.get(candidate.item.owner).lastDispatch < owners.get(selected.item.owner).lastDispatch ? candidate : selected);
            const { item, current } = choice;
            queue.splice(choice.index, 1); item.signal?.removeEventListener('abort', item.onAbort);
            if (item.signal?.aborted) { item.reject(abortError()); retireOwner(item.owner); continue; }
            const owner = owners.get(item.owner);
            owner.lastDispatch = ++dispatchSequence; owner.inflight++;
            inflight++; current.bot.inflight++; current.chat.inflight++;
            current.chat.nextAt = now() + pacingMs * item.cost;
            Promise.resolve().then(item.work).then(item.resolve, item.reject).finally(() => {
                inflight--; current.bot.inflight--; current.chat.inflight--; owner.inflight--; retireOwner(item.owner); pump();
            });
        }
        if (queue.length && waitAt < Infinity && inflight < globalLimit) timer = setTimer(pump, Math.max(1, waitAt - now()));
    }
    return {
        enqueue(backend, work, { signal, taskKey, cost = 1, priority = 0 } = {}) {
            if (signal?.aborted) return Promise.reject(abortError());
            return new Promise((resolve, reject) => {
                const item = { backend, work, signal, resolve, reject, owner: String(taskKey || 'anonymous-' + (++sequence)), cost: Math.max(1, Math.min(10, Number(cost) || 1)), priority: Number(priority) || 0 };
                // New tasks get their first turn before a task just dispatched,
                // but not ahead of older waiting turns forever as jobs arrive.
                if (!owners.has(item.owner)) owners.set(item.owner, { lastDispatch: dispatchSequence - 0.5, inflight: 0 });
                item.onAbort = () => {
                    const index = queue.indexOf(item);
                    if (index >= 0) { queue.splice(index, 1); signal.removeEventListener('abort', item.onAbort); reject(abortError()); retireOwner(item.owner); pump(); }
                };
                signal?.addEventListener('abort', item.onAbort, { once: true });
                queue.push(item); pump();
            });
        },
        feedback(backend, error, attempt = 1) {
            retries++;
            const base = Math.min(30000, 500 * (2 ** Math.max(0, attempt - 1)));
            const delay = Math.max(error?.message === 'TELEGRAM_429' ? (Number(error.retryAfter) || 1) * 1000 : 0, base) + Math.floor(Math.max(0, Math.min(1, random())) * 500);
            const current = state(backend);
            current.chat.nextAt = Math.max(current.chat.nextAt, now() + delay);
            if (error?.message === 'TELEGRAM_429') { rateLimits++; current.chat.restrictedUntil = Math.max(current.chat.restrictedUntil, now() + delay + 30000); }
            pump();
            return delay;
        },
        snapshot() { return { queueLength: queue.length, inflight, retries, rateLimits, activeBots: [...bots.values()].filter(item => item.inflight).length, activeChats: [...chats.values()].filter(item => item.inflight).length }; }
    };
}

const telegramUploadScheduler = createTelegramUploadScheduler();
module.exports = { createTelegramUploadScheduler, telegramUploadScheduler };
