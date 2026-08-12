'use strict';

const fs = require('fs');
const path = require('path');
const { translateTelegramText } = require('../server/i18n');

const languages = ['zh-Hant', 'en', 'ja', 'fr', 'ru', 'es', 'it', 'ko', 'ms', 'id', 'vi', 'th', 'fa', 'km', 'my'];
const files = ['server.js', ...fs.readdirSync('server').filter(name => name.endsWith('.js')).map(name => path.join('server', name))];
const outboundMarkers = /socket\.emit|emitSocketError|telegramSendMessage|answerCallbackQuery|message\s*:|res\.(?:json|send|status)|input_field_placeholder/;
const quotedChinese = /(['"`])([^'"`\r\n]*[\u3400-\u9fff][^'"`\r\n]*)\1/g;
const phrases = new Map();
const dynamicSamples = [
    '当前处于 A1B2C 隧道中转模式',
    '当前处于 A1B2C 隧道中转模式，直接发送任何内容，将转发到此隧道。',
    '文件太大，当前 Telegram bot 接收上限是 50MB。',
    '已发送到隧道 A1B2C：example.txt',
    '已将 3 个媒体文件以合辑发送到隧道 A1B2C。',
    '以下文件超过 20MB，已拦截，无法通过 Telegram 官方云端 Bot API 转发到隧道：\nexample.mp4\n……以及另外 2 个文件\n\nTelegram 官方说明：Bot API 的 getFile 目前只能下载不超过 20MB 的文件。\nhttps://core.telegram.org/bots/api#getfile'
];

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
for (const phrase of dynamicSamples) {
    const untranslated = languages.filter(language => translateTelegramText(phrase, language) === phrase);
    if (untranslated.length) missing.push({ phrase: phrase.split('\n')[0], untranslated, locations: ['dynamic-sample'] });
}

console.log(`Checked ${phrases.size} outbound Chinese phrases in ${files.length} server files.`);
missing.forEach(item => {
    console.log(`${item.phrase}\tmissing=${item.untranslated.join(',')}\t${item.locations.join(',')}`);
});
if (missing.length) process.exitCode = 1;
