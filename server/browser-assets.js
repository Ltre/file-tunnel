'use strict';
const fs = require('fs');
const path = require('path');
function resolvePasskeyBrowserAsset(root, resolveModule = name => require.resolve(name, { paths: [root] })) {
    // Release builds already contain this bundle; no runtime browser npm package needed.
    try {
        const manifest = JSON.parse(fs.readFileSync(path.join(root, 'build-manifest.json'), 'utf8'));
        const asset = manifest.scripts?.['client/simplewebauthn.js'];
        if (/^\/assets\/[a-zA-Z0-9_.-]+\.js$/.test(asset || '')) {
            const filename = path.join(root, asset.slice(1));
            if (fs.existsSync(filename)) return filename;
        }
    } catch (_) {}
    try {
        const filename = path.resolve(path.dirname(resolveModule('@simplewebauthn/browser')), '../dist/bundle/index.umd.min.js');
        if (fs.existsSync(filename)) return filename;
    } catch (_) {}
    return null;
}
module.exports = { resolvePasskeyBrowserAsset };
