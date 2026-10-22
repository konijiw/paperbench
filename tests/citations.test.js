const assert = require('node:assert/strict');
const bib = require('../assets/citations.js');
const original = '@article{smith2025, title = {A {NASA} study with \\LaTeX{}}, author = {Smith, Alice and Doe, Bob}, year = 2025, journal = "Robotics", doi = {10.1234/test(1)}, pages = {1--10}}';
const parsed = bib.parse(original);
assert.equal(parsed.fields.title, 'A {NASA} study with \\LaTeX{}');
assert.equal(parsed.fields.author, 'Smith, Alice and Doe, Bob');
assert.equal(bib.parse(bib.serialize(parsed)).fields.doi, '10.1234/test(1)');
assert.equal(bib.parse(bib.serialize(parsed, 'biblatex')).fields.journaltitle, 'Robotics');
assert.equal(bib.parse(bib.serialize(bib.parse('@online{a, title={Web}, date={2024-01-02}, journaltitle={Journal}}'), 'bibtex')).fields.year, '2024');
for (const bad of ['@article{x,title={No close}', '@article{x,title={One}} @article{y,title={Two}}', '@article{x,title=macro}', '@article{x,title={A} # {B}}', '@article{x,title={A},title={B}}', '@article{x,author={A}}']) assert.throws(() => bib.parse(bad));
console.log('BibTeX parsing, preservation, export conversion and malformed-input checks passed.');

assert.equal(bib.parse('@article{x,title={Months},month=May}').fields.month, 'May');
assert.equal(bib.parse(bib.serialize(bib.parse('@article{x,title={Months},month=May}'), 'biblatex')).fields.month, '5');
