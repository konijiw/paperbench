'use strict';
const assert = require('node:assert/strict');
const Markdown = require('../assets/codex-sidebar/markdown.js');

// Rendering-only fixture: no real browser, network, or user conversation is opened.
class Node {
  constructor(tag, text) { this.tag = tag; this.textContent = text || ''; this.children = []; this.listeners = {}; this.style = {}; this.dataset = {}; this.classList = { add() {} }; }
  append(...children) { this.children.push(...children); }
  setAttribute(key, value) { this[key] = value; }
  addEventListener(type, listener) { this.listeners[type] = listener; }
}
const doc = { createElement: tag => new Node(tag), createTextNode: text => new Node('#text', text) };
function links(markdown, options = {}) {
  const root = new Node('div'); Markdown.appendMarkdown(doc, root, markdown, options);
  const found = []; const visit = node => { if (node.tag === 'a') found.push(node); node.children.forEach(visit); }; visit(root); return found;
}
const source = '[项目介绍](https://openai.com/index/learning-dexterity/) · [期刊论文](https://doi.org/10.1177/0278364919887447) · [后续工作](https://openai.com/index/solving-rubiks-cube/)';
const browser = links(source, { openTarget() { throw new Error('Browser must not call a Zotero launcher'); } });
assert.equal(browser.length, 3);
for (const anchor of browser) {
  assert.match(anchor.href, /^https:\/\//);
  assert.equal(anchor.target, '_blank');
  assert.equal(anchor.rel, 'noopener noreferrer');
  assert.equal(anchor.listeners.click, undefined, 'Native click, Ctrl-click, middle-click and Enter must not be cancelled');
}
let launched = '', prevented = false;
const host = links('[Website](https://example.org/)', { interceptExternalLinks: true, openTarget(target) { launched = target; } })[0];
host.listeners.click({ preventDefault() { prevented = true; } });
assert.equal(launched, 'https://example.org/'); assert.equal(prevented, true);
let localTarget = '';
const local = links('[Local](file:///D:/paper/markdown.md)', { openTarget(target) { localTarget = target; } })[0];
assert.equal(local.href, '#'); local.listeners.click({ preventDefault() {} }); assert.equal(localTarget, 'file:///D:/paper/markdown.md');
for (const target of ['javascript:alert(1)', 'data:text/html,test']) {
  const anchor = links('[Unsafe](' + target + ')')[0];
  assert.equal(anchor.href, '#'); assert.equal(anchor.target, undefined);
}
console.log('PASS: real web links use native browser navigation; desktop callback, local handling and scheme filtering remain intact.');
