'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { plan, prepare } = require('../client/disk-upload-names');
const file = (name, folder) => { const f = new File(['bytes'], name, { type: 'image/jpeg', lastModified: 12 }); if (folder !== undefined) f.diskFolderPath = folder; return f; };
test('batch rename reserves all original names, retains extensions, and never edits device files', async () => {
    const original = [file('image.jpg'), file('image.jpg'), file('image (2).jpg'), file('image.jpg')];
    let prompts = 0; const result = await prepare(original, '照片', async text => { prompts++; assert.match(text, /取消将停止整次上传/); return true; });
    assert.equal(prompts, 1); assert.deepEqual(result.map(f => f.name), ['image.jpg', 'image (3).jpg', 'image (2).jpg', 'image (4).jpg']);
    assert.equal(original[1].name, 'image.jpg'); assert.equal(await result[1].text(), 'bytes'); assert.equal(result[1].lastModified, 12); assert.equal(result[0], original[0]);
});
test('folder uploads only rename collisions in the same final directory, including slash normalization', async () => {
    const input = [file('.env', 'a'), file('.env', '/a/'), file('.env', 'b'), file('hello.txt', 'b')];
    assert.deepEqual(plan(input, 'unused').map(p => [p.path, p.name]), [['a', '.env (2)']]);
    const output = await prepare(input, '', () => true); assert.equal(output[1].diskFolderPath, '/a/');
    assert.equal(await prepare(input, '', () => false), null); assert.equal(input[1].name, '.env');
});
test('names stay bounded without splitting a Unicode surrogate or renaming conflict-free batches', async () => {
    const long = '😀'.repeat(85) + '.jpg', input = [file(long), file(long)]; const renamed = plan(input, '')[0].name;
    assert.ok(renamed.length <= 180); assert.doesNotMatch(renamed, /[\uD800-\uDBFF] \(/);
    const plain = [file('a'), file('b')]; assert.equal(await prepare(plain, '', () => { throw Error('unexpected prompt'); }), plain);
});
test('batch conflict keys match server normalization of filename and destination whitespace', () => {
    const planned = plan([file('image.jpg', '/a/./ b '), file(' image.jpg ', 'a/b')], '');
    assert.equal(planned.length, 1); assert.equal(planned[0].name, 'image (2).jpg'); assert.equal(planned[0].path, 'a/b');
});
