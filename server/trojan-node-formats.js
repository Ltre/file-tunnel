'use strict';

// Node interchange only. Client routing, DNS and advanced transports are not
// applied to this server's runtime or to its per-service exit policies.
const YAML = require('yaml');
const FORMATS = Object.freeze({
    native: ['Drop2Tunnel', 'json', 'application/json'],
    clash: ['Clash', 'yaml', 'application/yaml'],
    shadowrocket: ['Shadowrocket', 'txt', 'text/plain'],
    'sing-box': ['sing-box', 'json', 'application/json'],
    v2rayng: ['v2rayNG', 'txt', 'text/plain'],
    hiddify: ['Hiddify', 'txt', 'text/plain'],
    'trojan-qt5': ['Trojan-Qt5', 'json', 'application/json'],
    igniter: ['Igniter', 'json', 'application/json']
});
const MAX_BYTES = 2 * 1024 * 1024, MAX_NODES = 500;
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
function flag(value, fallback = true) {
    if (value === undefined) return fallback;
    if (value === true || value === 1 || value === '1' || value === 'true') return true;
    if (value === false || value === 0 || value === '0' || value === 'false') return false;
    throw Error('证书验证开关无效');
}
function normalized(node) {
    const value = { name: String(node.name || '').trim(), server: String(node.server || '').trim().replace(/^\[|\]$/g, ''),
        port: Number(node.port), password: node.password, serverName: String(node.serverName || '').trim(),
        verifyTls: flag(node.verifyTls), remark: String(node.remark || '') };
    if (!value.name || value.name.length > 200 || /[\u0000-\u001f\u007f]/.test(value.name) ||
        !value.server || value.server.length > 253 || /[\s/\\\u0000-\u001f]/.test(value.server) ||
        !Number.isInteger(value.port) || value.port < 1 || value.port > 65535 ||
        typeof value.password !== 'string' || !value.password || value.password.length > 4096 || /[\r\n\0]/.test(value.password) ||
        value.serverName.length > 253 || /[\s/\\\u0000-\u001f]/.test(value.serverName) || value.remark.length > 2000) throw Error('节点名称、地址、端口、密码或 SNI 无效');
    return value;
}
function uriNode(text) {
    let url;
    try { url = new URL(text); } catch (_) { throw Error('Trojan 链接无效'); }
    if (url.protocol !== 'trojan:') throw Error('不是 Trojan 节点，已跳过');
    const query = url.searchParams;
    const supportedQuery = new Set(['security', 'type', 'sni', 'peer', 'serverName', 'allowInsecure', 'allow_insecure', 'skip-cert-verify', 'encryption', 'headerType']);
    if ((query.has('type') && !['tcp', 'none'].includes(query.get('type'))) ||
        (query.has('security') && query.get('security') !== 'tls') ||
        ['encryption', 'headerType'].some(key => query.has(key) && query.get(key) !== 'none') ||
        [...query.keys()].some(key => !supportedQuery.has(key) && query.get(key))) {
        throw Error('包含当前节点表单不支持的传输、指纹或证书选项，已跳过');
    }
    if (url.pathname && url.pathname !== '/') throw Error('包含不支持的传输路径，已跳过');
    let password, name;
    try { password = decodeURIComponent(url.username + (url.password ? ':' + url.password : '')); name = decodeURIComponent(url.hash.slice(1)); }
    catch (_) { throw Error('链接中的字符编码无效'); }
    const insecure = query.get('allowInsecure') ?? query.get('allow_insecure') ?? query.get('skip-cert-verify');
    return normalized({ name: name || url.hostname, server: url.hostname, port: url.port || 443, password,
        serverName: query.get('sni') || query.get('peer') || query.get('serverName') || '', verifyTls: !flag(insecure === null ? undefined : insecure, false) });
}
function objectNode(node, kind) {
    if (!node || typeof node !== 'object' || Array.isArray(node)) throw Error('节点对象无效');
    if ((node.type && node.type !== 'trojan') || (node.protocol && node.protocol !== 'trojan')) throw Error('不是 Trojan 节点，已跳过');
    const tls = node.tls || node.ssl || {}, stream = node.streamSettings || {};
    if ((node.network && node.network !== 'tcp') || (stream.network && stream.network !== 'tcp') ||
        (stream.security && stream.security !== 'tls') || (tls.enabled === false) ||
        ['transport', 'plugin', 'obfs', 'ws-opts', 'grpc-opts', 'reality-opts', 'client-fingerprint', 'fingerprint', 'alpn', 'smux'].some(key => node[key] != null && node[key] !== false) ||
        Object.keys(tls).some(key => !['enabled', 'server_name', 'insecure', 'sni', 'verify'].includes(key)) ||
        node['tls-cert-sha256']) throw Error('包含当前节点表单不支持的传输、指纹或证书选项，已跳过');
    if (kind === 'v2ray') {
        const settings = stream.tlsSettings || {};
        if (Object.keys(stream).some(key => !['network', 'security', 'tlsSettings'].includes(key)) ||
            Object.keys(settings).some(key => !['serverName', 'allowInsecure'].includes(key))) throw Error('包含不支持的 v2ray TLS 或传输选项，已跳过');
        const servers = node.settings?.servers;
        if (!Array.isArray(servers) || servers.length !== 1) throw Error('每个 Trojan 出口应只包含一个服务器');
        return normalized({ name: node.tag || servers[0].address, server: servers[0].address, port: servers[0].port,
            password: servers[0].password, serverName: settings.serverName, verifyTls: !flag(settings.allowInsecure, false) });
    }
    const password = Array.isArray(node.password) && node.password.length === 1 ? node.password[0] : node.password;
    const verifyValues = ['verify', 'verify_certificate', 'verify_hostname'].filter(key => own(node, key)).map(key => flag(node[key]));
    if (verifyValues.some(value => value !== verifyValues[0])) throw Error('证书和主机名使用不同验证策略，当前表单无法完整表示，已跳过');
    const insecure = node['skip-cert-verify'] ?? tls.insecure;
    return normalized({ name: node.name || node.tag || node.remarks || node.server || node.remote_addr,
        server: node.server || node.remote_addr, port: node.port ?? node.server_port ?? node.remote_port,
        password, serverName: node.serverName || node.sni || node.SNI || tls.server_name || tls.sni,
        verifyTls: node.verifyTls ?? (insecure !== undefined ? !flag(insecure, false) : verifyValues[0] ?? tls.verify ?? true), remark: node.remark });
}
function parseTrojanNodes(content) {
    if (typeof content !== 'string' || Buffer.byteLength(content) > MAX_BYTES) throw Error('节点文件应为文本，且不超过 2 MiB');
    let text = content.replace(/^\uFEFF/, '').trim();
    if (!text) throw Error('节点文件为空');
    if (!text.includes('://') && /^[A-Za-z0-9+/_=\s-]+$/.test(text)) {
        const decoded = Buffer.from(text.replace(/\s/g, ''), 'base64').toString('utf8').trim();
        if (decoded.includes('://')) text = decoded;
    }
    let items, kind;
    const lines = text.split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith('#'));
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(lines[0] || '')) {
        items = lines; kind = 'uri';
    } else {
        let value;
        try {
            try { value = JSON.parse(text); }
            catch (_) {
                const document = YAML.parseDocument(text, { uniqueKeys: true, merge: true, logLevel: 'silent' });
                if (document.errors.length || document.warnings.length) throw Error('invalid-yaml');
                value = document.toJS({ maxAliasCount: 100 });
            }
        }
        catch (_) { throw Error('无法读取节点文件，请检查 JSON／YAML 格式或订阅编码'); }
        if (Array.isArray(value)) items = value;
        else if (value?.format === 'drop2tunnel-trojan-nodes') {
            if (value.version !== 1) throw Error('不支持此版本的本系统节点文件');
            items = value.nodes;
        } else if (Array.isArray(value?.proxies)) items = value.proxies;
        else if (Array.isArray(value?.outbounds)) { items = value.outbounds; kind = value.outbounds.some(node => node?.protocol) ? 'v2ray' : 'sing-box'; }
        else if (Array.isArray(value?.configs)) items = value.configs;
        else if (value?.server || value?.remote_addr) items = [value];
        if (!Array.isArray(items)) throw Error('未找到受支持的节点列表');
    }
    if (items.length > MAX_NODES) throw Error('单次最多导入 500 项节点');
    const nodes = [], issues = [];
    for (const [index, item] of items.entries()) {
        try { nodes.push(typeof item === 'string' ? uriNode(item) : objectNode(item, kind)); }
        catch (error) { issues.push({ index: index + 1, reason: error.message }); }
    }
    if (!nodes.length) throw Error(issues.length ? '没有可导入的 Trojan 节点；' + issues.slice(0, 3).map(item => '第' + item.index + '项：' + item.reason).join('；') : '节点列表为空');
    return { nodes, issues, skipped: issues.length };
}
function trojanUri(node) {
    const query = new URLSearchParams({ security: 'tls', type: 'tcp' });
    if (node.serverName) query.set('sni', node.serverName);
    if (!node.verifyTls) query.set('allowInsecure', '1');
    const host = node.server.includes(':') ? '[' + node.server + ']' : node.server;
    return 'trojan://' + encodeURIComponent(node.password) + '@' + host + ':' + node.port + '?' + query + '#' + encodeURIComponent(node.name);
}
function exportTrojanNodes(nodes, format) {
    if (!own(FORMATS, format)) throw Error('请选择受支持的导出格式');
    if (!Array.isArray(nodes) || !nodes.length) throw Error('请至少选择一个已保存的节点');
    const values = nodes.map(normalized);
    let body;
    if (['shadowrocket', 'v2rayng', 'hiddify'].includes(format)) {
        body = values.map(trojanUri).join('\n') + '\n';
        if (format !== 'shadowrocket') body = Buffer.from(body).toString('base64') + '\n';
    } else {
        let value;
        if (format === 'native') value = { format: 'drop2tunnel-trojan-nodes', version: 1, nodes: values };
        else if (format === 'clash') value = { proxies: values.map(n => ({ name: n.name, type: 'trojan', server: n.server, port: n.port, password: n.password,
            ...(n.serverName ? { sni: n.serverName } : {}), 'skip-cert-verify': !n.verifyTls })) };
        else if (format === 'sing-box') value = { outbounds: values.map(n => ({ type: 'trojan', tag: n.name, server: n.server, server_port: n.port, password: n.password,
            tls: { enabled: true, server_name: n.serverName || n.server, insecure: !n.verifyTls } })) };
        else value = { configs: values.map(n => ({ remarks: n.name, server: n.server, server_port: n.port, password: n.password, sni: n.serverName, verify: n.verifyTls,
            ...(format === 'trojan-qt5' ? { verify_certificate: n.verifyTls, verify_hostname: n.verifyTls } : {}) })) };
        body = format === 'clash' ? YAML.stringify(value) : JSON.stringify(value, null, 2) + '\n';
    }
    return { body, filename: format === 'trojan-qt5' || format === 'igniter' ? 'gui-config.json' : 'trojan-nodes-' + format + '.' + FORMATS[format][1], contentType: FORMATS[format][2] + '; charset=utf-8' };
}
module.exports = { parseTrojanNodes, exportTrojanNodes, FORMATS };
