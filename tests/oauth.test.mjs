import test from 'node:test';
import assert from 'node:assert/strict';
import worker, {adfText, extractCriteria, parseTicket} from '../dist/server/index.js';
const env = {APP_ORIGIN: 'https://flowforge.example', JIRA_CLIENT_ID: 'test-client', JIRA_CLIENT_SECRET: 'test-secret', SESSION_SECRET: 'a'.repeat(48)};
const request = (path, init) => new Request(env.APP_ORIGIN + path, init);
function cookieHeader(response) { return response.headers.getSetCookie().map(item => item.split(';')[0]).join('; '); }
async function connect() {
  const response = await worker.fetch(request('/api/auth/jira/login'), env);
  const redirect = new URL(response.headers.get('Location'));
  const callback = await worker.fetch(request('/api/auth/jira/callback?code=code&state=' + redirect.searchParams.get('state'), {headers: {cookie: cookieHeader(response)}}), env);
  return {response, callback, cookies: cookieHeader(callback)};
}
test('read-only OAuth and live Jira API flow', async t => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  const rich = text => ({type: 'doc', content: [{type: 'paragraph', content: [{type: 'text', text}]}]});
  const site = {id: 'cloud-1', name: 'QA', url: 'https://qa.atlassian.net', scopes: ['read:jira-work', 'read:jira-user']};
  globalThis.fetch = async (url, init = {}) => {
    calls.push({url: String(url), method: init.method || 'GET', body: init.body});
    if (String(url) === 'https://auth.atlassian.com/oauth/token') return Response.json({access_token: 'test-access', refresh_token: 'test-refresh', expires_in: 3600});
    if (String(url).endsWith('accessible-resources')) return Response.json([site]);
    if (String(url).endsWith('/me')) return Response.json({name: 'Tester', account_id: 'user-1'});
    if (String(url).includes('/comment?')) {
      const start = new URL(url).searchParams.get('startAt');
      return Response.json({total: 2, comments: [{id: start === '0' ? '1' : '2', author: {displayName: 'QA'}, body: rich('Given guest\nWhen tap Watch\nThen Watch shown')} ]});
    }
    if (String(url).includes('/issue/VAL-404?')) return Response.json({errorMessages: ['Not found']}, {status: 404});
    if (String(url).includes('/issue/VAL-1928?')) return Response.json({key: 'VAL-1928', names: {customfield_100: 'Acceptance Criteria'}, fields: {summary: 'Actual ticket', description: rich('Original description'), customfield_100: rich('Actual AC'), status: {name: 'Done'}, issuetype: {name: 'Story'}, attachment: []}});
    throw new Error('Unexpected outbound URL: ' + url);
  };
  try {
    await t.test('missing configuration is visible without revealing credentials', async () => {
      const response = await worker.fetch(request('/api/auth/jira/status'), {});
      const data = await response.json(); assert.equal(data.configured, false); assert.ok(data.missing.includes('JIRA_CLIENT_SECRET'));
    });
    let session;
    await t.test('authorization is bound to encrypted HttpOnly state and read-only scopes', async () => {
      session = await connect();
      const url = new URL(session.response.headers.get('Location'));
      assert.deepEqual(url.searchParams.get('scope').split(' '), ['read:jira-work', 'read:jira-user', 'read:me', 'read:account', 'offline_access']);
      assert.equal(url.searchParams.get('redirect_uri'), env.APP_ORIGIN + '/api/auth/jira/callback');
      assert.match(session.response.headers.get('set-cookie'), /HttpOnly; Secure; SameSite=Lax/);
      assert.equal(session.callback.status, 303);
      const stored = session.callback.headers.getSetCookie();
      assert.equal(stored.length, 4);
      assert.ok(stored.every(value => !value.includes('test-access') && !value.includes('test-refresh')));
    });
    await t.test('callback rejects wrong state without attempting token exchange', async () => {
      const before = calls.length;
      const response = await worker.fetch(request('/api/auth/jira/callback?code=code&state=wrong', {headers: {cookie: cookieHeader(session.response)}}), env);
      assert.match(response.headers.get('location'), /jira_error=invalid_state/);
      assert.equal(calls.length, before);
    });
    await t.test('session status reads the authorized user and workspace', async () => {
      const response = await worker.fetch(request('/api/auth/jira/status', {headers: {cookie: session.cookies}}), env);
      const data = await response.json(); assert.equal(data.connected, true); assert.equal(data.profile.name, 'Tester'); assert.equal(data.sites[0].id, 'cloud-1');
    });
    await t.test('issue URL loads original AC and every comment page', async () => {
      const response = await worker.fetch(request('/api/jira/ticket?ticket=' + encodeURIComponent('https://qa.atlassian.net/browse/VAL-1928'), {headers: {cookie: session.cookies}}), env);
      const data = await response.json(); assert.equal(response.status, 200); assert.equal(data.summary, 'Actual ticket'); assert.equal(data.acceptanceCriteria[0].text, 'Actual AC'); assert.equal(data.comments.length, 2);
      assert.ok(calls.filter(call => call.url.includes('/rest/api/')).every(call => call.method === 'GET'));
    });
    await t.test('URLs cannot access a site that was not authorized', async () => {
      const before = calls.filter(call => call.url.includes('/issue/')).length;
      const response = await worker.fetch(request('/api/jira/ticket?ticket=' + encodeURIComponent('https://other.atlassian.net/browse/VAL-1928'), {headers: {cookie: session.cookies}}), env);
      assert.equal(response.status, 403); assert.equal(calls.filter(call => call.url.includes('/issue/')).length, before);
    });
    await t.test('anonymous and tampered sessions cannot read Jira', async () => {
      const a = await worker.fetch(request('/api/jira/ticket?ticket=VAL-1928'), env);
      const b = await worker.fetch(request('/api/jira/ticket?ticket=VAL-1928', {headers: {cookie: 'ff_access=bad.value'}}), env);
      assert.equal(a.status, 401); assert.equal(b.status, 401);
    });
    await t.test('logout rejects cross-origin requests and clears all cookies', async () => {
      const bad = await worker.fetch(request('/api/auth/jira/logout', {method: 'POST', headers: {origin: 'https://evil.example'}}), env);
      assert.equal(bad.status, 403);
      const good = await worker.fetch(request('/api/auth/jira/logout', {method: 'POST', headers: {origin: env.APP_ORIGIN}}), env);
      assert.equal(good.status, 200); assert.equal(good.headers.getSetCookie().length, 4);
      assert.ok(good.headers.getSetCookie().every(value => value.includes('Max-Age=0')));
    });
    await t.test('expired access uses rotating refresh and emits both replacement cookies', async () => {
      const realNow = Date.now;
      Date.now = () => realNow() + 3700 * 1000;
      try {
        const response = await worker.fetch(request('/api/auth/jira/status', {headers: {cookie: session.cookies}}), env);
        assert.equal(response.status, 200);
        assert.equal(response.headers.getSetCookie().length, 2);
        assert.ok(calls.some(call => call.body && JSON.parse(call.body).grant_type === 'refresh_token'));
      } finally { Date.now = realNow; }
    });
    await t.test('refreshed cookies survive Jira errors so the browser keeps the rotated tokens', async () => {
      const realNow = Date.now;
      Date.now = () => realNow() + 3700 * 1000;
      try {
        const response = await worker.fetch(request('/api/jira/ticket?ticket=VAL-404&cloudId=cloud-1', {headers: {cookie: session.cookies}}), env);
        assert.equal(response.status, 404);
        const replacements = response.headers.getSetCookie();
        assert.equal(replacements.length, 2);
        assert.ok(replacements.some(cookie => cookie.startsWith('ff_access=')));
        assert.ok(replacements.some(cookie => cookie.startsWith('ff_refresh=')));
        assert.ok(replacements.every(cookie => !cookie.includes('Max-Age=0')));
      } finally { Date.now = realNow; }
    });
    await t.test('late refresh cannot restore a session after logout cleared its login binding', async () => {
      const realNow = Date.now;
      Date.now = () => realNow() + 3700 * 1000;
      const savedFetch = globalThis.fetch;
      let release;
      let reached;
      const waiting = new Promise(resolve => { reached = resolve; });
      globalThis.fetch = async (url, init) => {
        if (String(url).endsWith('/me')) { reached(); await new Promise(resolve => { release = resolve; }); }
        return savedFetch(url, init);
      };
      try {
        const inFlight = worker.fetch(request('/api/auth/jira/status', {headers: {cookie: session.cookies}}), env);
        await waiting;
        const logout = await worker.fetch(request('/api/auth/jira/logout', {method: 'POST', headers: {origin: env.APP_ORIGIN, cookie: session.cookies}}), env);
        assert.ok(logout.headers.getSetCookie().some(cookie => cookie.startsWith('ff_session=;')));
        release();
        const late = await inFlight;
        assert.equal(late.status, 200);
        assert.ok(late.headers.getSetCookie().every(cookie => !cookie.startsWith('ff_session=')));
        const resurrect = await worker.fetch(request('/api/auth/jira/status', {headers: {cookie: cookieHeader(late)}}), env);
        assert.equal(resurrect.status, 401);
        assert.equal((await resurrect.json()).error, 'not_connected');
      } finally { release?.(); Date.now = realNow; globalThis.fetch = savedFetch; }
    });
  } finally { globalThis.fetch = originalFetch; }
});
test('ADF tables retain cell boundaries and paragraph breaks', () => {
  const text = value => ({type: 'paragraph', content: [{type: 'text', text: value}]});
  const table = {type: 'table', content: [{type: 'tableRow', content: [{type: 'tableCell', content: [text('one'), text('two')]}, {type: 'tableCell', content: [text('right')]}]}]};
  assert.equal(adfText(table), '| one<br>two | right |\n');
  assert.deepEqual(extractCriteria({customfield_1: {type: 'doc', content: [text('AC value')]}}, {customfield_1: 'AC'}), [{id: 'customfield_1', name: 'AC', text: 'AC value'}]);
});
test('ticket normalization rejects untrusted endpoints and accepts issue-board links', () => {
  assert.equal(parseTicket('val-1928').key, 'VAL-1928');
  assert.equal(parseTicket('https://qa.atlassian.net/jira/software/c/projects/VAL/boards/1?selectedIssue=VAL-1928').key, 'VAL-1928');
  for (const url of ['https://evil.example/browse/VAL-1', 'http://qa.atlassian.net/browse/VAL-1', 'https://qa.atlassian.net.evil.example/browse/VAL-1', 'https://qa.atlassian.net/browse/VAL-1/extra']) assert.throws(() => parseTicket(url));
});
