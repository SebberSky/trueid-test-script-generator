import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../dist/server/index.js';

const env = {APP_ORIGIN: 'https://flowforge.example', JIRA_CLIENT_ID: 'test-client', JIRA_CLIENT_SECRET: 'test-secret', SESSION_SECRET: 'a'.repeat(48)};
const request = (path, init) => new Request(env.APP_ORIGIN + path, init);
const cookie = response => response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
const base64url = bytes => Buffer.from(bytes).toString('base64url');

test('MCP discovery, PKCE Jira login, token exchange and tools', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async url => {
    assert.equal(String(url), 'https://auth.atlassian.com/oauth/token');
    return Response.json({access_token: 'jira-access-for-user', refresh_token: 'jira-refresh-for-user', expires_in: 3600});
  };
  try {
    const metadata = await worker.fetch(request('/.well-known/oauth-authorization-server'), env);
    assert.equal(metadata.status, 200);
    assert.equal((await metadata.json()).authorization_endpoint, env.APP_ORIGIN + '/oauth/authorize');

    const verifier = 'verifier-' + 'x'.repeat(40);
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
    const challenge = base64url(digest);
    const authorize = await worker.fetch(request('/oauth/authorize?' + new URLSearchParams({client_id: 'client-1', redirect_uri: 'https://client.example/callback', response_type: 'code', state: 'client-state', code_challenge: challenge, code_challenge_method: 'S256'})), env);
    assert.equal(authorize.status, 302);
    assert.match(authorize.headers.get('location'), /auth\.atlassian\.com\/authorize/);
    const jiraState = new URL(authorize.headers.get('location')).searchParams.get('state');

    const callback = await worker.fetch(request('/api/auth/mcp/callback?code=jira-code&state=' + encodeURIComponent(jiraState), {headers: {cookie: cookie(authorize)}}), env);
    assert.equal(callback.status, 302);
    const callbackUrl = new URL(callback.headers.get('location'));
    assert.equal(callbackUrl.searchParams.get('state'), 'client-state');

    const token = await worker.fetch(request('/oauth/token', {method: 'POST', body: new URLSearchParams({grant_type: 'authorization_code', client_id: 'client-1', redirect_uri: 'https://client.example/callback', code: callbackUrl.searchParams.get('code'), code_verifier: verifier})}), env);
    assert.equal(token.status, 200);
    const tokenData = await token.json();
    assert.equal(tokenData.token_type, 'Bearer');

    const initialized = await worker.fetch(request('/mcp', {method: 'POST', headers: {'content-type': 'application/json', authorization: `Bearer ${tokenData.access_token}`}, body: JSON.stringify({jsonrpc: '2.0', id: 1, method: 'initialize', params: {}})}), env);
    assert.equal(initialized.status, 200);
    assert.equal((await initialized.json()).result.serverInfo.name, 'flowforge');
    const listed = await worker.fetch(request('/mcp', {method: 'POST', headers: {'content-type': 'application/json', authorization: `Bearer ${tokenData.access_token}`}, body: JSON.stringify({jsonrpc: '2.0', id: 2, method: 'tools/list', params: {}})}), env);
    const names = (await listed.json()).result.tools.map(tool => tool.name);
    assert.deepEqual(names, ['connect_jira', 'load_jira_ticket', 'parse_gwt', 'generate_test_script', 'format_jira_gwt']);
  } finally { globalThis.fetch = originalFetch; }
});

test('MCP rejects invalid PKCE and malformed bearer tokens', async () => {
  const authorize = await worker.fetch(request('/oauth/authorize?' + new URLSearchParams({client_id: 'client-1', redirect_uri: 'https://client.example/callback', response_type: 'code', state: 'state', code_challenge: 'bad', code_challenge_method: 'plain'})), env);
  assert.equal(authorize.status, 400);
  const response = await worker.fetch(request('/mcp', {method: 'POST', headers: {authorization: 'Bearer invalid'}, body: '{}'}), env);
  assert.equal(response.status, 401);
});
