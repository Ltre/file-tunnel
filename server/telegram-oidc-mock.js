'use strict';

const crypto = require('crypto');

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

function isLoopbackAddress(value) {
    const address = String(value || '').trim().toLowerCase().replace(/^::ffff:/, '');
    if (address === '::1' || address === 'localhost') return true;
    const parts = address.split('.').map(Number);
    return parts.length === 4 && parts.every(Number.isInteger) && parts[0] === 127;
}

function isLoopbackOrigin(value) {
    try {
        const url = new URL(String(value || ''));
        return ['http:', 'https:'].includes(url.protocol) && LOOPBACK_HOSTS.has(url.hostname.toLowerCase());
    } catch (_) {
        return false;
    }
}

function escapeHtml(value) {
    return String(value || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function createTelegramOidcMock(options = {}) {
    const enabled = options.enabled === true;
    const defaultUserId = /^\d+$/.test(String(options.defaultUserId || ''))
        ? String(options.defaultUserId)
        : '999000001';
    const sessionSecret = crypto.randomBytes(32);

    function isAllowed({ publicOrigin, remoteAddress } = {}) {
        return enabled && isLoopbackOrigin(publicOrigin) && isLoopbackAddress(remoteAddress);
    }

    function createAuthorizationRequest({ publicOrigin }) {
        if (!isLoopbackOrigin(publicOrigin)) throw new Error('telegram-oidc-mock-origin-invalid');
        const state = crypto.randomBytes(32).toString('base64url');
        const url = new URL('/api/telegram/drive/oidc/mock', publicOrigin);
        url.searchParams.set('state', state);
        return { state, url: url.href };
    }

    function parseIdentity(value) {
        const id = String(value || '').trim();
        if (!/^\d{1,20}$/.test(id)) throw new Error('telegram-oidc-mock-user-id-invalid');
        return { id, name: `本地 Mock 用户 ${id}`, username: `mock_${id}` };
    }

    function renderAuthorizationPage({ state, error = '' } = {}) {
        return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Telegram OIDC 本地 Mock</title>
<style>body{font-family:system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;background:#f5f7fb;color:#26324d}main{box-sizing:border-box;width:min(420px,calc(100% - 32px));padding:28px;border:1px solid #dce3f0;border-radius:16px;background:white;box-shadow:0 16px 42px #1d31551f}h1{font-size:1.3rem;margin-top:0}.notice{padding:12px;border-radius:10px;background:#fff5d7;color:#704f00}.error{color:#b42318}label,input,button{display:block;width:100%;box-sizing:border-box}label{margin:18px 0 7px;font-weight:650}input{padding:11px;border:1px solid #abb8cc;border-radius:8px;font:inherit}button{margin-top:14px;padding:11px;border:0;border-radius:8px;background:#2979ff;color:white;font:inherit;font-weight:700;cursor:pointer}.secondary{background:#e9eef7;color:#26324d}</style></head>
<body><main><h1>Telegram OIDC 本地 Mock</h1><p class="notice">此页面只模拟本机开发登录，不会连接 Telegram，也不应把 localhost 登记到 BotFather。</p>${error ? `<p class="error">${escapeHtml(error)}</p>` : ''}
<form method="post" action="/api/telegram/drive/oidc/mock/authorize"><input type="hidden" name="state" value="${escapeHtml(state)}"><label for="telegramUserId">Telegram User ID</label><input id="telegramUserId" name="telegramUserId" inputmode="numeric" pattern="[0-9]{1,20}" maxlength="20" value="${escapeHtml(defaultUserId)}" required autofocus><button type="submit">使用此 Mock 身份登录</button></form>
<button type="button" class="secondary" onclick="window.close()">取消并关闭</button></main></body></html>`;
    }

    return {
        createAuthorizationRequest,
        getSessionSecret: () => sessionSecret,
        isAllowed,
        parseIdentity,
        renderAuthorizationPage
    };
}

module.exports = { createTelegramOidcMock, isLoopbackAddress, isLoopbackOrigin };
