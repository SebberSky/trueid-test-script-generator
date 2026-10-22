import test from 'node:test';
import assert from 'node:assert/strict';
import worker, {adfText} from '../dist/server/index.js';
import {collectMedia, mediaInventory, inlineMime, safeExternalUrl} from '../worker/media.js';
import {mediaKind, renderMedia} from '../web/media.js';
const uuid = '00000000-0000-0000-0000-000000000001';
test('ADF media groups, inline files, links, embeds and wiki attachments retain sources', () => {
  const doc = {type: 'doc', content: [
    {type: 'mediaSingle', content: [{type: 'media', attrs: {id: uuid, type: 'file', alt: 'screen.png'}}]},
    {type: 'mediaGroup', content: [{type: 'mediaInline', attrs: {id: '2', type: 'file'}}]},
    {type: 'embedCard', attrs: {url: 'https://www.youtube.com/watch?v=example'}},
    {type: 'media', attrs: {type: 'external', url: 'https://example.com/video.mp4'}},
    {type: 'text', text: 'reference', marks: [{type: 'link', attrs: {href: 'https://example.com/reference'}}]},
  ]};
  const items = collectMedia(doc, 'Comment 1');
  assert.equal(items.length, 5);
  assert.ok(items.every(item => item.source === 'Comment 1'));
  assert.equal(collectMedia('See !screen.png|width=400!', 'Description')[0].filename, 'screen.png');
  assert.match(adfText(doc), /\[Media: screen.png\]/);
  assert.equal(safeExternalUrl('javascript:alert(1)'), null);
  assert.equal(safeExternalUrl('https://user:password@example.com'), null);
});
test('inventory maps UUIDs, preserves unknown file types and reports ambiguous/unresolved references', () => {
  const files = [{id: '1', filename: 'screen.png', mimeType: 'image/png', mediaId: uuid}, {id: '2', filename: 'report.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'}];
  const media = mediaInventory(files, [{kind: 'file', mediaId: uuid, source: 'Description'}, {kind: 'file', mediaId: 'missing', source: 'Comment 2'}, {kind: 'external', url: 'https://example.com/file', source: 'AC'}, {kind: 'external', url: 'https://example.com/file', source: 'Comment 1'}], 'VAL-1', 'cloud-1', 'https://qa.atlassian.net/browse/VAL-1');
  assert.deepEqual(media.attachments[0].sources, ['Description']);
  assert.equal(media.attachments.length, 2);
  assert.match(media.attachments[1].downloadUrl, /attachmentId=2.*download=1/);
  assert.equal(media.unresolved.length, 1);
  assert.equal(media.external.length, 1);
  assert.equal(media.external[0].sources.length, 2);
  assert.equal(inlineMime('image/svg+xml'), null);
  assert.equal(inlineMime('text/html'), null);
  assert.equal(mediaKind('image/svg+xml'), 'file');
  assert.equal(mediaKind('video/quicktime'), 'video');
});
test('media viewer renders native players, fallback downloads and explicit unresolved warnings', () => {
  const original = globalThis.document;
  class Element {
    constructor(tag) { this.tag = tag; this.children = []; this.textContent = ''; this.handlers = {}; }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = children; }
    setAttribute() {}
    addEventListener(type, callback) { this.handlers[type] = callback; }
  }
  globalThis.document = {createElement: tag => new Element(tag)};
  const root = new Element('section');
  try {
    const attachments = ['image/png', 'video/mp4', 'audio/mpeg', 'application/pdf', 'application/zip'].map((mimeType, index) => ({filename: 'file-' + index, mimeType, size: 100, previewUrl: '/api/jira/attachment?id=' + index, downloadUrl: '/api/jira/attachment?id=' + index + '&download=1', sources: ['Description']}));
    renderMedia({url: 'https://qa.atlassian.net/browse/VAL-1', media: {attachments, external: [], unresolved: [{filename: 'missing media', sources: ['Comment 2'], warning: 'Cannot map file', jiraUrl: 'https://qa.atlassian.net/browse/VAL-1'}]}}, root);
    const all = node => [node, ...node.children.flatMap(all)];
    const nodes = all(root);
    assert.equal(root.hidden, false);
    assert.equal(nodes.filter(node => node.tag === 'img').length, 1);
    assert.equal(nodes.filter(node => node.tag === 'video' && node.controls).length, 1);
    assert.equal(nodes.filter(node => node.tag === 'audio' && node.controls).length, 1);
    assert.equal(nodes.filter(node => node.tag === 'a' && node.textContent === 'Download').length, 5);
    assert.ok(nodes.some(node => node.textContent === 'Cannot map file'));
    nodes.find(node => node.tag === 'video').handlers.error();
    assert.ok(nodes.some(node => node.textContent.includes('codec')));
    renderMedia(null, root); assert.equal(root.hidden, true); assert.equal(root.children.length, 0);
  } finally { globalThis.document = original; }
});
test('Jira attachments are permission-checked and streamed with range support without exposing OAuth tokens', async t => {
  const env = {APP_ORIGIN: 'https://flowforge.example', JIRA_CLIENT_ID: 'client', JIRA_CLIENT_SECRET: 'secret', SESSION_SECRET: 'a'.repeat(48)};
  const request = (path, init) => new Request(env.APP_ORIGIN + path, init);
  const jar = response => response.headers.getSetCookie().map(item => item.split(';')[0]).join('; ');
  const files = [{id: '1', filename: 'หน้าจอ.png', mimeType: 'image/png', size: 8}, {id: '2', filename: 'untrusted.svg', mimeType: 'image/svg+xml', size: 8}, {id: '3', filename: 'notes.html', mimeType: 'text/html', size: 8}];
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({url: String(url), headers: init.headers, method: init.method || 'GET'});
    if (String(url).endsWith('/oauth/token')) return Response.json({access_token: 'private-token', refresh_token: 'private-refresh', expires_in: 3600});
    if (String(url).endsWith('/accessible-resources')) return Response.json([{id: 'cloud-1', url: 'https://qa.atlassian.net', scopes: ['read:jira-work']}]);
    if (String(url).includes('/issue/VAL-1?')) return Response.json({key: 'VAL-1', names: {}, fields: {summary: 'Media ticket', attachment: files, description: {type: 'doc', content: [{type: 'media', attrs: {id: uuid, type: 'file'}}]}}});
    if (String(url).includes('/comment?')) return Response.json({total: 0, comments: []});
    if (String(url).includes('redirect=true')) return new Response(null, {status: 303, headers: {location: `https://api.media.atlassian.com/file/${String(url).includes('/1?') ? uuid : '00000000-0000-0000-0000-000000000002'}/binary?token=private-signed-media-token`}});
    if (String(url).includes('/attachment/content/')) {
      assert.equal(init.redirect, 'manual'); assert.equal(init.headers['Accept-Encoding'], 'identity');
      const ranged = init.headers.Range;
      return new Response(new Uint8Array(ranged ? [2, 3] : [0, 1, 2, 3, 4, 5, 6, 7]), {status: ranged ? 206 : 200, headers: {'Content-Length': ranged ? '2' : '8', 'Accept-Ranges': 'bytes', ...(ranged ? {'Content-Range': 'bytes 2-3/8'} : {})}});
    }
    throw new Error('Unexpected URL');
  };
  try {
    const login = await worker.fetch(request('/api/auth/jira/login'), env);
    const state = new URL(login.headers.get('location')).searchParams.get('state');
    const callback = await worker.fetch(request('/api/auth/jira/callback?code=code&state=' + state, {headers: {cookie: jar(login)}}), env);
    const session = jar(callback);
    const path = '/api/jira/attachment?ticket=VAL-1&cloudId=cloud-1&attachmentId=';
    await t.test('UUID references map to real attachment cards without exposing signed redirect URLs', async () => {
      const response = await worker.fetch(request('/api/jira/ticket?ticket=VAL-1&cloudId=cloud-1', {headers: {cookie: session}}), env);
      const body = await response.text(); const data = JSON.parse(body);
      assert.equal(response.status, 200); assert.equal(data.media.attachments.length, 3);
      assert.deepEqual(data.media.attachments[0].sources, ['Description']);
      assert.equal(data.media.unresolved.length, 0);
      assert.ok(!body.includes('private-token') && !body.includes('private-signed-media-token'));
    });
    await t.test('binary responses stream inline images and preserve byte ranges for seeking', async () => {
      const full = await worker.fetch(request(path + '1', {headers: {cookie: session}}), env);
      assert.equal(full.status, 200); assert.equal(full.headers.get('content-type'), 'image/png');
      assert.match(full.headers.get('content-disposition'), /^inline;.*filename\*=UTF-8/);
      assert.equal(full.headers.get('cache-control'), 'private, no-store');
      assert.equal((await full.arrayBuffer()).byteLength, 8);
      const part = await worker.fetch(request(path + '1', {headers: {cookie: session, Range: 'bytes=2-3'}}), env);
      assert.equal(part.status, 206); assert.equal(part.headers.get('content-range'), 'bytes 2-3/8');
      assert.deepEqual([...new Uint8Array(await part.arrayBuffer())], [2, 3]);
    });
    await t.test('active document formats are downloads with sandbox and cannot execute as page scripts', async () => {
      for (const id of ['2', '3']) {
        const response = await worker.fetch(request(path + id, {headers: {cookie: session}}), env);
        assert.equal(response.headers.get('content-type'), 'application/octet-stream');
        assert.match(response.headers.get('content-disposition'), /^attachment;/);
        assert.match(response.headers.get('content-security-policy'), /sandbox/);
        await response.body.cancel();
      }
    });
    await t.test('downloads use safe filenames and unknown attachment IDs never trigger binary fetches', async () => {
      const response = await worker.fetch(request(path + '1&download=1', {headers: {cookie: session}}), env);
      assert.match(response.headers.get('content-disposition'), /^attachment;/); await response.body.cancel();
      const before = calls.filter(call => call.url.includes('/attachment/content/')).length;
      const denied = await worker.fetch(request(path + '999', {headers: {cookie: session}}), env);
      assert.equal(denied.status, 404); assert.equal(calls.filter(call => call.url.includes('/attachment/content/')).length, before);
      assert.ok(calls.filter(call => call.url.includes('/rest/api/')).every(call => call.method === 'GET'));
    });
    await t.test('anonymous users, unauthorized sites and malformed ranges cannot access binary files', async () => {
      assert.equal((await worker.fetch(request(path + '1'), env)).status, 401);
      assert.equal((await worker.fetch(request(path.replace('cloud-1', 'cloud-2') + '1', {headers: {cookie: session}}), env)).status, 403);
      assert.equal((await worker.fetch(request(path + '1', {headers: {cookie: session, Range: 'bytes=0-2,4-6'}}), env)).status, 416);
      assert.equal((await worker.fetch(request(path + 'https://evil.example', {headers: {cookie: session}}), env)).status, 400);
    });
  } finally { globalThis.fetch = original; }
});
