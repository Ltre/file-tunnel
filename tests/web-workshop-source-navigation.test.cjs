'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '../client/web-workshop.js'), 'utf8');

test('网页工坊原记录跳转只最小化界面，不得关闭网页工坊', () => {
    const line = source.split('\n').find(entry => entry.includes("if(action==='source')"));
    assert.ok(line, '应存在原记录按钮处理分支');
    const start = line.indexOf("if(action==='source')");
    const end = line.indexOf("if(action==='rename')", start);
    const branch = line.slice(start, end > start ? end : undefined);
    assert.match(branch, /if\(presentationMode==='open'\)minimize\(\)/);
    assert.doesNotMatch(branch, /\bclose\(/, '原记录跳转不得关闭网页工坊');
    assert.match(branch, /config\.focusMessage\?\.\(draft\.sourceMessageId\)/);
});
