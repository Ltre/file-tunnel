'use strict';

const fs = require('fs');
const path = require('path');

const roots = ['pages/index.html', 'app.js', 'client', 'server.js', 'server'];
const ignoredFiles = new Set(['client/i18n-catalog.js']);
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
const quotedText = /(['"`])((?:\\.|(?!\1)[^\\])*?[\u3400-\u9fff](?:\\.|(?!\1)[^\\])*)\1/g;
for (const file of files) {
    const content = fs.readFileSync(file, 'utf8');
    let match;
    while ((match = quotedText.exec(content))) {
        const phrase = match[2].replace(/\\[nrt]/g, ' ').replace(/\s+/g, ' ').trim();
        if (phrase.length < 2 || phrase.length > 240) continue;
        if (!phrases.has(phrase)) phrases.set(phrase, new Set());
        phrases.get(phrase).add(file.replace(/\\/g, '/'));
    }
}

const catalogPath = path.join('client', 'i18n-catalog.js');
const catalogSource = fs.existsSync(catalogPath) ? fs.readFileSync(catalogPath, 'utf8') : '';
const canonical = value => String(value || '').replace(/\s+/g, '');
const uncovered = [...phrases.entries()]
    .filter(([phrase]) => !catalogSource.includes(`['${phrase.replace(/'/g, "\\'")}'`))
    .sort(([left], [right]) => left.localeCompare(right, 'zh-CN'));

console.log(`Scanned ${files.length} files; found ${phrases.size} Chinese phrases; ${uncovered.length} are not in the client catalog.`);
uncovered.forEach(([phrase, sources]) => {
    console.log(`${canonical(phrase)}\t${phrase}\t${[...sources].join(',')}`);
});

process.exitCode = uncovered.length ? 1 : 0;
