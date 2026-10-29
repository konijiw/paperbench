import assert from 'node:assert/strict';
import { pdfTextContentToText } from '../assets/pdf-reader/text-content.mjs';

const item = (str, x, width, size = 10, y = 100, hasEOL = false) =>
  ({ str, width, dir: 'ltr', transform: [size, 0, 0, size, x, y], hasEOL });

assert.equal(pdfTextContentToText({ items: [
  item('E', 0, 10, 17), item('IGEN', 10.8, 35, 14),
  item('DEX', 46.6, 37, 17), item('PLORE', 84.4, 47, 14),
] }), 'EIGENDEXPLORE');
assert.equal(pdfTextContentToText({ items: [
  item('Human', 0, 25), item('priors', 29, 25),
] }), 'Human priors');
assert.equal(pdfTextContentToText({ items: [
  item('First', 0, 25, 10, 100, true), item('Second', 0, 30, 10, 80),
] }), 'First\nSecond');
assert.equal(pdfTextContentToText({ items: [
  item('Alice Smith', 0, 55), item(' ', 55, 15), item('Bob Jones', 70, 45),
] }), 'Alice Smith   Bob Jones');
console.log('PASS: font fragments, word gaps, line breaks and author-column gaps.');
