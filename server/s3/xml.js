'use strict';
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[char]);
const tag = (name, value) => `<${name}>${esc(value)}</${name}>`;
const document = (name, content) => `<?xml version="1.0" encoding="UTF-8"?><${name} xmlns="http://s3.amazonaws.com/doc/2006-03-01/">${content}</${name}>`;
const unescape = value => String(value).replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (match, entity) => {
    if (entity[0] === '#') { const number = entity[1]?.toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10); return Number.isSafeInteger(number) && number <= 0x10ffff ? String.fromCodePoint(number) : match; }
    return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[entity.toLowerCase()] || match;
});
function deleteRequest(xml) {
    if (/<!DOCTYPE|<!ENTITY/i.test(xml) || !/^\s*(?:<\?xml[^>]*>\s*)?<Delete(?:\s[^>]*)?>[\s\S]*<\/Delete>\s*$/.test(xml)) throw new Error('MalformedXML');
    const rawObjects = [...xml.matchAll(/<Object>\s*<Key>([\s\S]*?)<\/Key>\s*<\/Object>/g)].map(match => match[1]);
    if (!rawObjects.length || rawObjects.length > 1000 || [...xml.matchAll(/<Object\b/g)].length !== rawObjects.length
        || rawObjects.some(value => /<|&(?!(?:#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);)/i.test(value))) throw new Error('MalformedXML');
    const objects = rawObjects.map(unescape);
    return { keys: objects, quiet: /<Quiet>\s*true\s*<\/Quiet>/i.test(xml) };
}
module.exports = { esc, tag, document, deleteRequest };
