import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import * as parser from '../web/parser.js';
import * as media from '../web/media.js';

class Element {
  constructor(value = '') { this.value = value; this.textContent = ''; this.listeners = {}; this.children = []; this.classList = {add() {}, remove() {}}; }
  addEventListener(event, listener) { this.listeners[event] = listener; }
  setAttribute(name, value) { this[name] = value; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  emit(event) { return this.listeners[event]?.(); }
}
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return {promise, resolve};
}
const ticket = {key: 'VAL-1', summary: 'Loaded ticket', url: 'https://qa.atlassian.net/browse/VAL-1', fetchedAt: '2026-10-22T00:00:00Z', site: {id: 'cloud-1'}, acceptanceCriteria: [], comments: [], description: 'Given guest\nWhen Tap Watch\nThen Watch page is displayed'};
async function browser(options = {}) {
  const nodes = new Map();
  const get = id => { if (!nodes.has(id)) nodes.set(id, new Element()); return nodes.get(id); };
  get('workspace').value = 'cloud-1'; get('ticket').value = 'VAL-1';
  const pending = [];
  const copied = [];
  const richCopied = [];
  const context = vm.createContext({
    ...parser, ...media, URLSearchParams, AbortController, Date, console, Blob,
    ClipboardItem: options.rich ? class { constructor(payload) { this.payload = payload; } } : undefined,
    Option: class extends Element { constructor(name, value) { super(value); this.textContent = name; } },
    document: {getElementById: get, createElement: () => new Element(), createTextNode: text => ({textContent: text})},
    location: {search: '', pathname: '/'}, history: {replaceState() {}}, navigator: {clipboard: {
      write: async items => { if (options.blockRich) throw new Error('Denied'); richCopied.push(...items); },
      writeText: async text => { if (options.blockText) throw new Error('Denied'); copied.push(text); },
    }}, setTimeout() {},
    fetch: async path => {
      if (path.endsWith('/status')) return Response.json({configured: true, connected: true, sites: [{id: 'cloud-1', name: 'QA'}]});
      const request = deferred(); pending.push(request); return request.promise;
    },
  });
  const source = (await readFile(new URL('../web/app.js', import.meta.url), 'utf8')).replace(/^import[^\n]+\n/gm, '');
  new vm.Script(source).runInContext(context);
  await new Promise(setImmediate);
  return {get, pending, copied, richCopied};
}
test('editing criteria during a load keeps manual GWT when the old response arrives', async () => {
  const page = await browser();
  const loading = page.get('load').emit('click');
  const manual = 'Scenario: Manual\nGiven guest\nWhen Tap Shopping\nThen Shopping page is displayed';
  page.get('criteria').value = manual;
  page.get('criteria').emit('input');
  page.pending[0].resolve(Response.json(ticket));
  await loading;
  assert.equal(page.get('criteria').value, manual);
  assert.equal(page.get('sourceState').textContent, 'EDITED');
  assert.equal(page.get('load').disabled, false);
  assert.equal(page.get('scenarios').children.length, 1);
});
test('an obsolete load cannot reset the newest load button or overwrite its result', async () => {
  const page = await browser();
  const first = page.get('load').emit('click');
  page.get('ticket').value = 'VAL-2'; page.get('ticket').emit('input');
  const second = page.get('load').emit('click');
  page.pending[0].resolve(Response.json(ticket)); await first;
  assert.equal(page.get('load').disabled, true);
  page.pending[1].resolve(Response.json({...ticket, key: 'VAL-2'})); await second;
  assert.equal(page.get('load').disabled, false);
  assert.equal(page.get('sourceState').textContent, 'LIVE JIRA');
  assert.match(page.get('ticketMeta').children[0].textContent, /^VAL-2/);
});
function findNode(root, predicate) {
  if (predicate(root)) return root;
  for (const child of root.children || []) { const found = findNode(child, predicate); if (found) return found; }
}
async function draftPage() {
  const page = await browser();
  const loading = page.get('load').emit('click');
  page.pending[0].resolve(Response.json({...ticket, description: '', acceptanceCriteria: [{id: 'customfield_1', name: 'AC', text: 'Watch must open'}]}));
  await loading;
  return page;
}
test('editing a draft while reloading cancels the stale result and preserves the draft', async () => {
  const page = await draftPage();
  const loading = page.get('load').emit('click');
  const card = page.get('scenarios').children[0];
  const given = findNode(card, node => node['aria-label'] === 'Given for Draft 1');
  given.value = 'manual guest setup'; given.emit('input');
  page.pending[1].resolve(Response.json(ticket)); await loading;
  assert.equal(page.get('scenarios').children[0], card);
  assert.equal(given.value, 'manual guest setup');
  assert.equal(page.get('sourceState').textContent, 'EDITED');
});
test('confirming a draft during reload prevents a stale response from replacing it', async () => {
  const page = await draftPage();
  const card = page.get('scenarios').children[0];
  for (const [label, value] of [['Given', 'guest'], ['When', 'Tap Watch']]) {
    const input = findNode(card, node => node['aria-label'] === label + ' for Draft 1');
    input.value = value; input.emit('input');
  }
  const loading = page.get('load').emit('click');
  findNode(card, node => node.textContent === 'Confirm this GWT draft').emit('click');
  const confirmed = page.get('scenarios').children[0];
  assert.ok(findNode(confirmed, node => node.textContent?.includes('user-confirmed interpretation')));
  page.pending[1].resolve(Response.json(ticket)); await loading;
  assert.equal(page.get('scenarios').children[0], confirmed);
});
test('Copy Jira format copies all visible cases as a rich table without generating scripts', async () => {
  const page = await browser({rich: true});
  assert.equal(page.get('copyGwt').disabled, true);
  page.get('criteria').value = 'Scenario: หนึ่ง\nGiven guest\nWhen Tap Watch\nThen Watch page is displayed\nScenario: สอง\nGiven guest\nWhen Tap Today\nThen Today page is displayed';
  page.get('criteria').emit('input');
  assert.equal(page.get('copyGwt').disabled, false);
  await page.get('copyGwt').emit('click');
  const payload = page.richCopied[0].payload;
  const html = await payload['text/html'].text();
  assert.equal((html.match(/<td>/g) || []).length, 8);
  assert.ok(html.includes('หนึ่ง') && html.includes('สอง'));
  assert.match(await payload['text/plain'].text(), /^\|\| Scenario/);
  assert.equal(page.copied.length, 0);
});
test('per-case copy includes only that case and keeps edited draft values marked as draft', async () => {
  const page = await draftPage();
  const card = page.get('scenarios').children[0];
  const input = findNode(card, node => node['aria-label'] === 'Given for Draft 1');
  input.value = 'ผู้ใช้ทดสอบ'; input.emit('input');
  await findNode(card, node => node['aria-label']?.startsWith('Copy Jira format for case 1:')).emit('click');
  assert.match(page.copied[0], /ผู้ใช้ทดสอบ/);
  assert.match(page.copied[0], /DRAFT/);
});
test('rich clipboard rejection falls back to wiki markup and total denial offers manual copy', async () => {
  for (const blockText of [false, true]) {
    const page = await browser({rich: true, blockRich: true, blockText});
    page.get('criteria').value = 'Given guest\nWhen Tap Watch\nThen Watch page is displayed'; page.get('criteria').emit('input');
    await page.get('copyGwt').emit('click');
    if (blockText) {
      assert.equal(page.get('jiraCopyFallback').hidden, false);
      assert.match(page.get('jiraCopyFallback').value, /^\|\| Scenario/);
      assert.match(page.get('error').textContent, /Clipboard/);
      assert.equal(page.copied.length, 0);
    } else { assert.match(page.copied[0], /^\|\| Scenario/); assert.equal(page.get('jiraCopyFallback').hidden, true); }
  }
});
