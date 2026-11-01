'use strict';
const rateLimit = require('express-rate-limit');
const { BlockList, isIP } = require('node:net');

// Cloudflare's published origin-facing ranges, checked 2026-11-01:
// https://www.cloudflare.com/ips-v4 / https://www.cloudflare.com/ips-v6
const cloudflare = new BlockList();
for (const cidr of [
    '173.245.48.0/20', '103.21.244.0/22', '103.22.200.0/22', '103.31.4.0/22',
    '141.101.64.0/18', '108.162.192.0/18', '190.93.240.0/20', '188.114.96.0/20',
    '197.234.240.0/22', '198.41.128.0/17', '162.158.0.0/15', '104.16.0.0/13',
    '104.24.0.0/14', '172.64.0.0/13', '131.0.72.0/22',
    '2400:cb00::/32', '2606:4700::/32', '2803:f800::/32', '2405:b500::/32',
    '2405:8100::/32', '2a06:98c0::/29', '2c0f:f248::/32'
]) {
    const [address, prefix] = cidr.split('/');
    cloudflare.addSubnet(address, Number(prefix), isIP(address) === 6 ? 'ipv6' : 'ipv4');
}
function normalizeIp(value) {
    if (typeof value !== 'string') return '';
    const address = value.trim(), family = isIP(address);
    if (!family) return '';
    if (family === 4) return address;
    if (address.toLowerCase().startsWith('::ffff:') && isIP(address.slice(7)) === 4) return address.slice(7);
    return new URL('http://[' + address.split('%')[0] + ']/').hostname.slice(1, -1);
}
function isCloudflare(address) {
    const family = isIP(address);
    return Boolean(family && cloudflare.check(address, family === 6 ? 'ipv6' : 'ipv4'));
}
function clientIpKey(req) {
    const remote = normalizeIp(req.socket?.remoteAddress) || normalizeIp(req.ip);
    if (isCloudflare(remote)) {
        const visitor = normalizeIp(req.get('cf-connecting-ip'));
        if (visitor) return visitor;
        const header = req.get('x-forwarded-for');
        if (typeof header === 'string' && header.length <= 4096) {
            const chain = header.split(',').map(normalizeIp);
            if (chain.length <= 64 && chain.every(Boolean)) {
                for (let i = chain.length - 1; i >= 0; i--) if (!isCloudflare(chain[i])) return chain[i];
            }
        }
    }
    return remote || 'unknown';
}
// Resolve only the limiter key. Global trust-proxy changes also affect origin,
// hostname and protocol checks, which are outside this repair.
module.exports = options => rateLimit({ ...options, keyGenerator: options?.keyGenerator || clientIpKey });
module.exports.clientIpKey = clientIpKey;
