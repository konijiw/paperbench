const fs = require('node:fs');
const assert = require('node:assert/strict');
const bib = require('../assets/citations.js');
const cases = JSON.parse(fs.readFileSync(require('node:path').join(__dirname, 'citation-key-fixtures.json'), 'utf8').replace(/^\uFEFF/, ''));
for (const [author, year, title, expected] of cases) assert.equal(bib.makeKey({author, year, title}), expected);
assert.equal(bib.makeKey({author:'Smith, Alice', date:'2025-02-01', title:'A new hand'}), 'Smith2025NewHand');
console.log('Readable citation key fixtures passed.');
