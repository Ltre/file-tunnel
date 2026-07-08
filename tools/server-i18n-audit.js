'use strict';

const fs = require('fs');
const path = require('path');
const { translateTelegramText } = require('../server/i18n');

const languages = ['zh-Hant', 'en', 'ja', 'fr', 'ru', 'es', 'it', 'ko', 'ms', 'id', 'vi', 'th'];
const files = ['server.js', ...fs.readdirSync('server').filter(name => name.endsWith('.js')).map(name => path.join('server', name))];
const outboundMarkers = /socket\.emit|emitSocketError|telegramSendMessage|answerCallbackQuery|message\s*:|res\.(?:json|send|status)|input_field_placeholder/;
const quotedChinese = /(['"`])([^'"`\r\n]*[\u3400-\u9fff][^'"`\r\n]*)\1/g;
const phrases = new Map();

for (const file of files) {
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
    lines.forEach((line, index) => {
        if (!outboundMarkers.test(line)) return;
        let match;
        while ((match = quotedChinese.exec(line))) {
            const phrase = match[2].trim();
            if (!phrase || phrase.includes('${')) continue;
            if (!phrases.has(phrase)) phrases.set(phrase, []);
            phrases.get(phrase).push(`${file.replace(/\\/g, '/')}:${index + 1}`);
        }
    });
}

const missing = [];
for (const [phrase, locations] of phrases) {
    const untranslated = languages.filter(language => translateTelegramText(phrase, language) === phrase);
    if (untranslated.length) missing.push({ phrase, untranslated, locations });
}

console.log(`Checked ${phrases.size} outbound Chinese phrases in ${files.length} server files.`);
missing.forEach(item => {
    console.log(`${item.phrase}\tmissing=${item.untranslated.join(',')}\t${item.locations.join(',')}`);
});
if (missing.length) process.exitCode = 1;
