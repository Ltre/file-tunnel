'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const roots = ['pages', 'app.js', 'client'];
const ignoredFiles = new Set([
    'client/i18n-catalog.js', 'client/i18n.js', 'client/localization-runtime.js',
    'client/qrcode-1.0.0.min.js'
]);
const files = [];

function collect(target) {
    if (!fs.existsSync(target)) return;
    const stat = fs.statSync(target);
    if (stat.isFile()) {
        if (/\.(?:js|html)$/.test(target) && !ignoredFiles.has(target.replace(/\\/g, '/'))) files.push(target);
        return;
    }
    fs.readdirSync(target, { withFileTypes: true }).forEach(entry => {
        collect(path.join(target, entry.name));
    });
}

roots.forEach(collect);

const phrases = new Map();
const quotedPatterns = [
    /'((?:\\.|[^'\\\r\n])*?[\u3400-\u9fff](?:\\.|[^'\\\r\n])*)'/g,
    /"((?:\\.|[^"\\\r\n])*?[\u3400-\u9fff](?:\\.|[^"\\\r\n])*)"/g,
    /`((?:\\.|[^`\\\r\n])*?[\u3400-\u9fff](?:\\.|[^`\\\r\n])*)`/g
];
for (const file of files) {
    const content = fs.readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    for (const pattern of quotedPatterns) {
        let match;
        while ((match = pattern.exec(content))) {
            const phrase = match[1]
                .replace(/\$\{[^}]*\}/g, '{value}')
                .replace(/<[^>]*>/g, ' ')
                .replace(/\\[nrt]/g, ' ')
                .replace(/\s+/g, ' ')
                .trim();
            if (phrase.length < 2 || phrase.length > 240 || !/[\u3400-\u9fff]/.test(phrase)) continue;
            if (!phrases.has(phrase)) phrases.set(phrase, new Set());
            phrases.get(phrase).add(file.replace(/\\/g, '/'));
        }
    }
}

const context = { window: { __drop2TunnelLegacyCatalogOnly: true } };
vm.createContext(context);
vm.runInContext(fs.readFileSync(path.join('client', 'i18n-catalog.js'), 'utf8'), context);
vm.runInContext(fs.readFileSync(path.join('client', 'i18n.js'), 'utf8'), context);
const canonical = value => String(value || '').replace(/\s+/g, '');
const catalogKeys = new Set(Object.keys(context.window.Drop2TunnelI18nCatalog || {}).map(canonical));
const uncovered = [...phrases.entries()]
    .filter(([phrase]) => !catalogKeys.has(canonical(phrase)))
    .sort(([left], [right]) => left.localeCompare(right, 'zh-CN'));

console.log(`Scanned ${files.length} files; found ${phrases.size} Chinese phrases; ${uncovered.length} are not in the client catalog.`);
uncovered.forEach(([phrase, sources]) => {
    console.log(`${canonical(phrase)}\t${phrase}\t${[...sources].join(',')}`);
});

process.exitCode = uncovered.length ? 1 : 0;
