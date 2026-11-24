'use strict';

// Disk objects are untrusted bytes served from the same host as application APIs.
// Evaluate both the filename and the declared MIME; neither is an authorization proof.
const RISKY_EXTENSIONS = new Set([
    'html', 'htm', 'xhtml', 'xht', 'svg', 'svgz', 'js', 'mjs',
    'xml', 'xsl', 'xslt', 'mht', 'mhtml', 'css', 'wasm',
    'php', 'phtml', 'phar', 'jsp', 'jspx', 'asp', 'aspx', 'cgi', 'pl', 'py', 'sh'
]);
const RISKY_NAMES = new Set(['.htaccess', '.htpasswd', 'web.config', '.user.ini']);
const RISKY_MIMES = new Set([
    'text/html', 'application/xhtml+xml', 'image/svg+xml',
    'text/javascript', 'application/javascript', 'application/x-javascript',
    'text/xml', 'application/xml', 'text/xsl', 'application/xslt+xml',
    'message/rfc822', 'multipart/related', 'application/x-mimearchive',
    'text/css', 'application/wasm', 'application/x-httpd-php'
]);

function normalizeMime(value) {
    const mime = String(value || '').split(';', 1)[0].trim().toLowerCase();
    return /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(mime) ? mime : 'application/octet-stream';
}

function isRiskyFile(name, type) {
    const basename = String(name || '').normalize('NFKC').split(/[\\/]/).pop().trim().toLowerCase().replace(/[.\s]+$/, '');
    const ext = basename.includes('.') ? basename.slice(basename.lastIndexOf('.') + 1) : '';
    return RISKY_NAMES.has(basename) || RISKY_EXTENSIONS.has(ext) || RISKY_MIMES.has(normalizeMime(type));
}

function assertRiskyUploadAllowed(auth, userId, name, type) {
    if (isRiskyFile(name, type) && !auth.hasPermission(userId, 'disk.riskyUpload')) {
        throw new Error('DISK_RISKY_UPLOAD_FORBIDDEN');
    }
}

module.exports = { normalizeMime, isRiskyFile, assertRiskyUploadAllowed,
    riskyFileTypes:()=>({extensions:[...RISKY_EXTENSIONS],names:[...RISKY_NAMES],mimes:[...RISKY_MIMES]}) };
