import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import * as parser from '../web/parser.js';

class Element {
  constructor(value = '') { this.value = value; this.textContent = ''; this.listeners = {}; this.children = []; this.classList = {add() {}, remove() {}}; }
  addEventListener(event, listener) { this.listeners[event] = listener; }
  setAttribute() {}
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
async function browser() {
  const nodes = new Map();
  const get = id => { if (!nodes.has(id)) nodes.set(id, new Element()); return nodes.get(id); };
  get('workspace').value = 'cloud-1'; get('ticket').value = 'VAL-1';
  const pending = [];
  const context = vm.createContext({
    ...parser, URLSearchParams, AbortController, Date, console,
    Option: class extends Element { constructor(name, value) { super(value); this.textContent = name; } },
    document: {getElementById: get, createElement: () => new Element(), createTextNode: text => ({textContent: text})},
    location: {search: '', pathname: '/'}, history: {replaceState() {}}, navigator: {clipboard: {writeText: async () => {}}}, setTimeout() {},
    fetch: async path => {
      if (path.endsWith('/status')) return Response.json({configured: true, connected: true, sites: [{id: 'cloud-1', name: 'QA'}]});
      const request = deferred(); pending.push(request); return request.promise;
    },
  });
  const source = (await readFile(new URL('../web/app.js', import.meta.url), 'utf8')).replace(/^import[^\n]+\n/, '');
  new vm.Script(source).runInContext(context);
  await new Promise(setImmediate);
  return {get, pending};
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
