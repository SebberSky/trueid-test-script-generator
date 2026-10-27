import {collectMedia, mediaInventory, inlineMime} from './media.js';
import {parseGwt, generateScript, formatJiraGwt} from './parser.js';
// Atlassian tokens are encrypted with a server-only key in HttpOnly session cookies.
const SCOPES = ['read:jira-work', 'read:jira-user', 'read:me', 'read:account', 'offline_access'];
const CALLBACK = '/api/auth/jira/callback';
const encoder = new TextEncoder();
class AppError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
const json = (data, status = 200, extra = new Headers()) => {
  const headers = new Headers(extra);
  headers.set('Content-Type', 'application/json; charset=utf-8');
  headers.set('Cache-Control', 'no-store');
  return new Response(JSON.stringify(data), {status, headers});
};
const b64 = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64 = value => Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
const random = () => b64(crypto.getRandomValues(new Uint8Array(32)));
const cookies = request => Object.fromEntries((request.headers.get('cookie') || '').split(';').map(v => v.trim().split(/=(.*)/s)).filter(v => v.length > 1));
const origin = env => {
  if (!env.APP_ORIGIN) throw new AppError(503, 'configuration_required', 'APP_ORIGIN is not configured.');
  return new URL(env.APP_ORIGIN).origin;
};
const missing = env => ['APP_ORIGIN', 'JIRA_CLIENT_ID', 'JIRA_CLIENT_SECRET', 'SESSION_SECRET'].filter(key => !env[key]);
function configured(env) {
  if (missing(env).length) throw new AppError(503, 'configuration_required', 'Jira login requires production configuration: ' + missing(env).join(', '));
  if (env.SESSION_SECRET.length < 32) throw new AppError(503, 'configuration_required', 'SESSION_SECRET must contain at least 32 characters.');
}
async function keyFor(env) {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(env.SESSION_SECRET));
  return crypto.subtle.importKey('raw', digest, 'AES-GCM', false, ['encrypt', 'decrypt']);
}
async function seal(value, env, purpose) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({name: 'AES-GCM', iv, additionalData: encoder.encode(purpose + ':' + origin(env))}, await keyFor(env), encoder.encode(JSON.stringify(value)));
  return b64(iv) + '.' + b64(new Uint8Array(ciphertext));
}
async function unseal(value, env, purpose) {
  try {
    const [iv, data] = (value || '').split('.');
    const plain = await crypto.subtle.decrypt({name: 'AES-GCM', iv: unb64(iv), additionalData: encoder.encode(purpose + ':' + origin(env))}, await keyFor(env), unb64(data));
    const result = JSON.parse(new TextDecoder().decode(plain));
    return result.until > Date.now() ? result : null;
  } catch { return null; }
}
function cookie(name, value, age, env) {
  // Local HTTP is allowed only for explicit local preview origins.
  const secure = new URL(origin(env)).protocol === 'https:' ? '; Secure' : '';
  return `${name}=${value}; HttpOnly${secure}; SameSite=Lax; Path=/; Max-Age=${age}`;
}
function setCookie(headers, name, value, age, env) {
  if (value.length > 3700) throw new AppError(502, 'token_too_large', 'Atlassian returned a token too large for this session.');
  headers.append('Set-Cookie', cookie(name, value, age, env));
}
function redirect(path, env, headers = new Headers()) {
  headers.set('Location', new URL(path, origin(env)).href);
  headers.set('Cache-Control', 'no-store');
  return new Response(null, {status: 303, headers});
}
async function upstream(url, token) {
  let response;
  try { response = await fetch(url, {headers: {Authorization: `Bearer ${token}`, Accept: 'application/json'}, signal: AbortSignal.timeout(20000), redirect: 'manual'}); }
  catch (error) {
    // Only log the endpoint and exception; never headers, cookies or token bodies.
    const endpoint = new URL(url);
    console.error(JSON.stringify({event: 'jira_transport_failed', host: endpoint.hostname, path: endpoint.pathname, type: error?.name, message: String(error?.message || '').slice(0, 250)}));
    throw new AppError(502, 'jira_unavailable', 'Cannot reach Atlassian. Try again.');
  }
  if (response.status >= 300 && response.status < 400) throw new AppError(502, 'jira_redirect', 'Atlassian returned an unexpected redirect. The access token was not forwarded.');
  if (!response.ok) {
    const message = {401: 'Jira session expired. Reconnect Jira.', 403: 'Your Jira account cannot read this resource.', 404: 'Ticket not found or your account does not have permission to view it.', 429: 'Jira rate limit reached. Try again shortly.'}[response.status] || 'Jira request failed.';
    throw new AppError(response.status >= 500 ? 502 : response.status, 'jira_' + response.status, message);
  }
  return response.json();
}
async function exchange(env, body) {
  let response;
  try {
    response = await fetch('https://auth.atlassian.com/oauth/token', {
      method: 'POST', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({client_id: env.JIRA_CLIENT_ID, client_secret: env.JIRA_CLIENT_SECRET, ...body}), signal: AbortSignal.timeout(20000),
    });
  } catch { throw new AppError(502, 'oauth_unavailable', 'Cannot reach Atlassian login. Try again.'); }
  if (!response.ok) throw new AppError(401, 'oauth_exchange_failed', 'Jira authorization failed. Check OAuth credentials and reconnect.');
  const result = await response.json();
  if (!result.access_token || !result.expires_in) throw new AppError(502, 'invalid_oauth_response', 'Atlassian returned an invalid token response.');
  return result;
}
async function tokenCookies(tokens, sessionId, env, headers, establish = false) {
  const duration = tokens.refresh_token ? 30 * 86400 : Math.min(Number(tokens.expires_in), 86400);
  const until = Date.now() + duration * 1000;
  if (establish) setCookie(headers, 'ff_session', sessionId, duration, env);
  const access = await seal({token: tokens.access_token, expires: Date.now() + Number(tokens.expires_in) * 1000, sessionId, until}, env, 'access');
  setCookie(headers, 'ff_access', access, duration, env);
  if (tokens.refresh_token) setCookie(headers, 'ff_refresh', await seal({token: tokens.refresh_token, sessionId, until}, env, 'refresh'), duration, env);
  else setCookie(headers, 'ff_refresh', '', 0, env);
}
const pendingRefreshes = new Map();
async function accessToken(request, env, headers) {
  configured(env);
  const bearer = request.headers.get('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (bearer) {
    const session = await unseal(bearer, env, 'mcp_access');
    if (!session?.token) throw new AppError(401, 'invalid_token', 'MCP authorization token is invalid or expired.');
    return session.token;
  }
  const jar = cookies(request);
  const access = await unseal(jar.ff_access, env, 'access');
  if (!access || jar.ff_session !== access.sessionId) throw new AppError(401, 'not_connected', 'Log in with Jira to load a ticket.');
  if (access.expires > Date.now() + 60000) return access.token;
  const refresh = await unseal(jar.ff_refresh, env, 'refresh');
  if (!refresh || refresh.sessionId !== access.sessionId) throw new AppError(401, 'session_expired', 'Jira session expired. Reconnect Jira.');
  let promise = pendingRefreshes.get(access.sessionId);
  if (!promise) {
    promise = exchange(env, {grant_type: 'refresh_token', refresh_token: refresh.token});
    pendingRefreshes.set(access.sessionId, promise);
  }
  try {
    const tokens = await promise;
    if (!tokens.refresh_token) throw new AppError(401, 'refresh_failed', 'Reconnect Jira to renew your session.');
    await tokenCookies(tokens, access.sessionId, env, headers);
    return tokens.access_token;
  } finally { pendingRefreshes.delete(access.sessionId); }
}

async function mcpAuthorize(request, env, headers) {
  configured(env);
  const url = new URL(request.url);
  if (url.pathname === '/mcp' && request.method === 'POST' && request.headers.get('Mcp-Method') === 'server/discover') return mcpResult(null, {supportedVersions: ['2026-07-28'], capabilities: {tools: {}}});
  const redirectUri = url.searchParams.get('redirect_uri');
  const clientId = url.searchParams.get('client_id');
  const state = url.searchParams.get('state');
  const challenge = url.searchParams.get('code_challenge');
  if (!clientId || !redirectUri || !state || !challenge || url.searchParams.get('code_challenge_method') !== 'S256') throw new AppError(400, 'invalid_request', 'MCP OAuth requires client_id, redirect_uri, state and S256 PKCE.');
  const callback = origin(env) + '/api/auth/mcp/callback';
  const signed = await seal({clientId, redirectUri, state, challenge, until: Date.now() + 600000}, env, 'mcp_oauth');
  setCookie(headers, 'ff_mcp_oauth', signed, 600, env);
  const authorize = new URL('https://auth.atlassian.com/authorize');
  authorize.search = new URLSearchParams({audience: 'api.atlassian.com', client_id: env.JIRA_CLIENT_ID, scope: SCOPES.join(' '), redirect_uri: callback, state: signed, response_type: 'code', prompt: 'consent'});
  headers.set('Location', authorize.href); headers.set('Cache-Control', 'no-store');
  return new Response(null, {status: 302, headers});
}
async function mcpCallback(request, env, headers) {
  configured(env);
  const url = new URL(request.url);
  const pending = await unseal(url.searchParams.get('state'), env, 'mcp_oauth');
  if (!pending) throw new AppError(400, 'invalid_state', 'MCP OAuth state expired or invalid.');
  const code = await seal({tokens: await exchange(env, {grant_type: 'authorization_code', code: url.searchParams.get('code'), redirect_uri: origin(env) + '/api/auth/mcp/callback'}), challenge: pending.challenge, clientId: pending.clientId, redirectUri: pending.redirectUri, until: Date.now() + 600000}, env, 'mcp_code');
  const target = new URL(pending.redirectUri); target.searchParams.set('code', code); target.searchParams.set('state', pending.state);
  headers.set('Location', target.href); headers.set('Cache-Control', 'no-store');
  return new Response(null, {status: 302, headers});
}
async function mcpToken(request, env) {
  configured(env);
  const body = await request.formData();
  const record = await unseal(body.get('code'), env, 'mcp_code');
  if (!record || record.clientId !== body.get('client_id') || record.redirectUri !== body.get('redirect_uri')) throw new AppError(400, 'invalid_grant', 'Authorization code is invalid.');
  const verifier = String(body.get('code_verifier') || '');
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(verifier));
  if (b64(new Uint8Array(digest)) !== record.challenge) throw new AppError(400, 'invalid_grant', 'PKCE verification failed.');
  const access = await seal({token: record.tokens.access_token, until: Date.now() + Math.min(Number(record.tokens.expires_in), 3600) * 1000}, env, 'mcp_access');
  return json({access_token: access, token_type: 'Bearer', expires_in: Math.min(Number(record.tokens.expires_in), 3600), scope: 'jira:read'});
}
function verifyOrigin(request, env) {
  if (request.headers.get('origin') !== origin(env)) throw new AppError(403, 'invalid_origin', 'Request origin is not allowed.');
}

const MCP_TOOLS = [
  {name: 'load_jira_ticket', description: 'Load a Jira ticket using the connected user Jira account.', inputSchema: {type: 'object', properties: {ticket: {type: 'string'}, cloudId: {type: 'string'}}, required: ['ticket']}},
  {name: 'parse_gwt', description: 'Parse Gherkin/GWT text into test scenarios.', inputSchema: {type: 'object', properties: {text: {type: 'string'}, source: {type: 'string'}}, required: ['text']}},
  {name: 'generate_test_script', description: 'Generate a Mobilewright test script from scenarios.', inputSchema: {type: 'object', properties: {ticketKey: {type: 'string'}, scenarios: {type: 'array'}}, required: ['scenarios']}},
  {name: 'format_jira_gwt', description: 'Format scenarios as Jira wiki text and HTML.', inputSchema: {type: 'object', properties: {scenarios: {type: 'array'}}, required: ['scenarios']}},
];
function mcpResult(id, result) { return json({jsonrpc: '2.0', id, result}); }
function mcpError(id, code, message) { return json({jsonrpc: '2.0', id, error: {code, message}}); }
async function mcp(request, env, headers) {
  if (request.method !== 'POST') return json({error: 'method_not_allowed', message: 'MCP uses POST.'}, 405, headers);
  await accessToken(request, env, headers);
  let body;
  try { body = await request.json(); } catch { return mcpError(null, -32700, 'Invalid JSON.'); }
  if (body.method === 'initialize') return mcpResult(body.id, {protocolVersion: '2025-06-18', capabilities: {tools: {}}, serverInfo: {name: 'flowforge', version: '1.0.0'}});
  if (body.method === 'notifications/initialized') return new Response(null, {status: 202, headers});
  if (body.method === 'tools/list') return mcpResult(body.id, {tools: MCP_TOOLS});
  if (body.method !== 'tools/call') return mcpError(body.id, -32601, 'Method not found.');
  const name = body.params?.name;
  const args = body.params?.arguments || {};
  try {
    if (name === 'parse_gwt') return mcpResult(body.id, {content: [{type: 'text', text: JSON.stringify(parseGwt(args.text, args.source || 'MCP input'))}], structuredContent: {scenarios: parseGwt(args.text, args.source || 'MCP input')}});
    if (name === 'generate_test_script') return mcpResult(body.id, {content: [{type: 'text', text: generateScript(args.ticketKey || 'MCP', args.scenarios || []).code}], structuredContent: generateScript(args.ticketKey || 'MCP', args.scenarios || [])});
    if (name === 'format_jira_gwt') return mcpResult(body.id, {content: [{type: 'text', text: JSON.stringify(formatJiraGwt(args.scenarios || []))}], structuredContent: formatJiraGwt(args.scenarios || [])});
    if (name === 'load_jira_ticket') {
      const url = new URL(request.url); url.pathname = '/api/jira/ticket'; url.search = new URLSearchParams({ticket: args.ticket, ...(args.cloudId ? {cloudId: args.cloudId} : {})}).toString();
      const ticket = await jiraTicket(new Request(url, {headers: request.headers}), env, headers);
      return mcpResult(body.id, {content: [{type: 'text', text: JSON.stringify(ticket)}], structuredContent: ticket});
    }
    return mcpError(body.id, -32602, 'Unknown tool.');
  } catch (error) { return mcpError(body.id, error.status === 401 ? -32001 : -32000, error.message || 'Tool failed.'); }
}
function parseTicket(input) {
  const raw = String(input || '').trim();
  if (/^[A-Z][A-Z0-9_]*-\d+$/i.test(raw)) return {key: raw.toUpperCase(), hostname: null};
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || !url.hostname.endsWith('.atlassian.net') || url.username || url.password || url.port) throw new Error();
    const key = url.pathname.match(/^\/browse\/([A-Z][A-Z0-9_]*-\d+)\/?$/i)?.[1] || url.searchParams.get('selectedIssue');
    if (!/^[A-Z][A-Z0-9_]*-\d+$/i.test(key || '')) throw new Error();
    return {key: key.toUpperCase(), hostname: url.hostname};
  } catch { throw new AppError(400, 'invalid_ticket', 'Enter a Jira key (VAL-1928) or an https://…atlassian.net/browse/VAL-1928 URL.'); }
}
function adfText(node) {
  if (node == null) return '';
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map(adfText).join('');
  if (node.type === 'text') return node.text || '';
  if (node.type === 'hardBreak') return '\n';
  if (node.type === 'mention') return node.attrs?.text || '';
  if (node.type === 'inlineCard') return node.attrs?.url || '';
  if (['media', 'mediaInline'].includes(node.type)) return `[Media: ${node.attrs?.alt || node.attrs?.id || node.attrs?.url || 'embedded file'}]`;
  if (node.type === 'emoji') return node.attrs?.text || node.attrs?.shortName || '';
  if (node.type === 'table') return (node.content || []).map(row => '| ' + (row.content || []).map(cell => adfText(cell).trim().replace(/\n/g, '<br>').replace(/\|/g, '\\|')).join(' | ') + ' |').join('\n') + '\n';
  const value = (node.content || []).map(adfText).join('');
  return value + (['paragraph', 'heading', 'listItem', 'codeBlock', 'blockquote'].includes(node.type) ? '\n' : '');
}
function extractCriteria(fields, names) {
  return Object.entries(names || {}).filter(([id, name]) => /acceptance\s*criteria|acceptance\s*conditions|^ac$|เกณฑ์การยอมรับ/i.test(name) && fields[id] != null)
    .map(([id, name]) => ({id, name, text: adfText(fields[id]).trim()})).filter(field => field.text);
}
async function jiraTicket(request, env, headers) {
  const url = new URL(request.url);
  const ticket = parseTicket(url.searchParams.get('ticket'));
  const token = await accessToken(request, env, headers);
  const resources = (await upstream('https://api.atlassian.com/oauth/token/accessible-resources', token)).filter(site => site.scopes?.includes('read:jira-work'));
  const requestedCloud = url.searchParams.get('cloudId');
  const matching = resources.filter(site => (!requestedCloud || site.id === requestedCloud) && (!ticket.hostname || new URL(site.url).hostname === ticket.hostname));
  if (!matching.length) throw new AppError(403, 'site_not_authorized', 'This Jira site has not been authorized. Reconnect Jira and select the correct site.');
  if (matching.length > 1) throw new AppError(400, 'choose_site', 'Select a Jira workspace or paste the full Jira URL.');
  const site = matching[0];
  const base = `https://api.atlassian.com/ex/jira/${encodeURIComponent(site.id)}/rest/api/3`;
  const issue = await upstream(`${base}/issue/${ticket.key}?fields=*all&expand=names`, token);
  const comments = [];
  let start = 0;
  for (let page = 0; page < 100; page++) {
    const batch = await upstream(`${base}/issue/${ticket.key}/comment?startAt=${start}&maxResults=100&orderBy=created`, token);
    comments.push(...(batch.comments || []));
    start += batch.comments?.length || 0;
    if (start >= (batch.total || 0)) break;
    if (!batch.comments?.length || page === 99) throw new AppError(502, 'comments_incomplete', 'Could not retrieve all ticket comments. No partial ticket was loaded.');
  }
  const fields = issue.fields || {};
  const references = [];
  for (const [id, value] of Object.entries(fields)) {
    if (id === 'description' || id.startsWith('customfield_') || (value && typeof value === 'object' && value.type === 'doc')) collectMedia(value, id === 'description' ? 'Description' : (issue.names?.[id] || id), references);
  }
  for (const comment of comments) collectMedia(comment.body, `Comment ${comment.id} · ${comment.author?.displayName || ''}`, references);
  const files = (fields.attachment || []).map(file => ({...file, id: String(file.id)}));
  const needsIds = references.some(ref => ref.kind === 'file' && ref.mediaId && !files.some(file => file.id === ref.mediaId) && files.filter(file => ref.filename && file.filename === ref.filename).length !== 1);
  if (needsIds) {
    for (let offset = 0; offset < files.length; offset += 3) {
      await Promise.all(files.slice(offset, offset + 3).map(async file => {
        try {
          const probe = await fetch(`${base}/attachment/content/${encodeURIComponent(file.id)}?redirect=true`, {headers: {Authorization: `Bearer ${token}`}, redirect: 'manual', signal: AbortSignal.timeout(10000)});
          file.mediaId = probe.headers.get('location')?.match(/\/file\/([0-9a-f-]{36})(?:\/|\?)/i)?.[1];
          await probe.body?.cancel();
        } catch { file.mediaId = null; }
      }));
    }
  }
  const ticketUrl = `${site.url}/browse/${issue.key}`;
  const media = mediaInventory(files, references, issue.key, site.id, ticketUrl);
  return {
    key: issue.key, summary: fields.summary || '', url: `${site.url}/browse/${issue.key}`,
    site: {id: site.id, name: site.name, url: site.url},
    description: adfText(fields.description).trim(), acceptanceCriteria: extractCriteria(fields, issue.names),
    comments: comments.map(comment => ({id: comment.id, author: comment.author?.displayName || '', updated: comment.updated, text: adfText(comment.body).trim()})),
    attachments: media.attachments, media,
    status: fields.status?.name || '', issueType: fields.issuetype?.name || '', updated: fields.updated,
    fetchedAt: new Date().toISOString(),
  };
}
async function attachmentContent(request, env, headers) {
  const url = new URL(request.url);
  const ticket = parseTicket(url.searchParams.get('ticket'));
  const attachmentId = url.searchParams.get('attachmentId') || '';
  const cloudId = url.searchParams.get('cloudId') || '';
  if (!/^\d+$/.test(attachmentId) || !cloudId) throw new AppError(400, 'invalid_attachment', 'A Jira cloud site, issue and attachment ID are required.');
  const range = request.headers.get('range');
  if (range && (!/^bytes=(?:\d+-\d*|-\d+)$/.test(range))) throw new AppError(416, 'invalid_range', 'Only one byte range is supported.');
  const token = await accessToken(request, env, headers);
  const sites = await upstream('https://api.atlassian.com/oauth/token/accessible-resources', token);
  const site = sites.find(site => site.id === cloudId && site.scopes?.includes('read:jira-work') && (!ticket.hostname || new URL(site.url).hostname === ticket.hostname));
  if (!site) throw new AppError(403, 'site_not_authorized', 'This Jira site has not been authorized.');
  const base = `https://api.atlassian.com/ex/jira/${encodeURIComponent(site.id)}/rest/api/3`;
  const issue = await upstream(`${base}/issue/${ticket.key}?fields=attachment`, token);
  const file = (issue.fields?.attachment || []).find(file => String(file.id) === attachmentId);
  if (!file) throw new AppError(404, 'attachment_not_found', 'This attachment is not present on the authorized issue.');
  const outgoing = {Authorization: `Bearer ${token}`, Accept: '*/*', 'Accept-Encoding': 'identity', ...(range ? {Range: range} : {})};
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
  let response;
  try { response = await fetch(`${base}/attachment/content/${attachmentId}?redirect=false`, {headers: outgoing, redirect: 'manual', signal: controller.signal}); }
  catch { throw new AppError(502, 'attachment_unavailable', 'Cannot load the attachment. Try again or open the original in Jira.'); }
  finally { clearTimeout(timeout); }
  if (![200, 206, 416].includes(response.status)) {
    await response.body?.cancel();
    throw new AppError([401, 403, 404, 429].includes(response.status) ? response.status : 502, 'attachment_unavailable', 'Jira could not return this file. Open the original in Jira or try again.');
  }
  const previewMime = inlineMime(file.mimeType);
  const download = url.searchParams.get('download') === '1' || !previewMime;
  headers.set('Content-Type', previewMime || 'application/octet-stream');
  const fallback = String(file.filename || 'attachment').replace(/[^a-zA-Z0-9._-]/g, '_');
  const encodedName = encodeURIComponent(String(file.filename || 'attachment')).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  headers.set('Content-Disposition', `${download ? 'attachment' : 'inline'}; filename="${fallback}"; filename*=UTF-8''${encodedName}`);
  headers.set('Cache-Control', 'private, no-store');
  headers.set('Cross-Origin-Resource-Policy', 'same-origin');
  headers.set('Content-Security-Policy', "sandbox; default-src 'none'");
  for (const name of ['content-length', 'content-range', 'accept-ranges']) if (response.headers.has(name)) headers.set(name, response.headers.get(name));
  return new Response(response.body, {status: response.status, headers});
}
async function handle(request, env, headers) {
  const url = new URL(request.url);
  if (url.pathname === '/.well-known/oauth-authorization-server' && request.method === 'GET') return json({issuer: origin(env), authorization_endpoint: origin(env) + '/oauth/authorize', token_endpoint: origin(env) + '/oauth/token', response_types_supported: ['code'], grant_types_supported: ['authorization_code'], code_challenge_methods_supported: ['S256'], scopes_supported: ['jira:read']}, 200, headers);
  if (url.pathname === '/oauth/authorize' && request.method === 'GET') return mcpAuthorize(request, env, headers);
  if (url.pathname === '/oauth/token' && request.method === 'POST') return mcpToken(request, env);
  if (url.pathname === '/api/auth/mcp/callback' && request.method === 'GET') return mcpCallback(request, env, headers);
  if (url.pathname === '/.well-known/oauth-protected-resource/mcp' && request.method === 'GET') return json({resource: origin(env) + '/mcp', authorization_servers: [origin(env)], bearer_methods_supported: ['header'], scopes_supported: ['jira:read']}, 200, headers);
  if (url.pathname === '/mcp') return mcp(request, env, headers);
  if (request.method === 'GET' && url.pathname === '/mcp-docs') return new Response(MCP_DOCS, {headers: {'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store'}});
  if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) return new Response(PAGE, {headers: {'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store'}});
  if (request.method === 'GET' && ASSETS[url.pathname]) return new Response(ASSETS[url.pathname], {headers: {'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-cache'}});
  if (url.pathname === '/api/auth/jira/status' && request.method === 'GET') {
    if (missing(env).length) return json({configured: false, connected: false, missing: missing(env)});
    const access = await unseal(cookies(request).ff_access, env, 'access');
    if (!access) return json({configured: true, connected: false});
    const token = await accessToken(request, env, headers);
    const [profile, sites] = await Promise.all([
      upstream('https://api.atlassian.com/me', token), upstream('https://api.atlassian.com/oauth/token/accessible-resources', token),
    ]);
    return json({configured: true, connected: true, profile: {name: profile.name || profile.nickname || '', accountId: profile.account_id}, sites: sites.filter(site => site.scopes?.includes('read:jira-work')).map(site => ({id: site.id, name: site.name, url: site.url}))}, 200, headers);
  }
  if (url.pathname === '/api/auth/jira/login' && request.method === 'GET') {
    configured(env);
    const state = random();
    setCookie(headers, 'ff_oauth', await seal({state, until: Date.now() + 600000}, env, 'oauth'), 600, env);
    const authorize = new URL('https://auth.atlassian.com/authorize');
    authorize.search = new URLSearchParams({audience: 'api.atlassian.com', client_id: env.JIRA_CLIENT_ID, scope: SCOPES.join(' '), redirect_uri: origin(env) + CALLBACK, state, response_type: 'code', prompt: 'consent'});
    headers.set('Location', authorize.href);
    headers.set('Cache-Control', 'no-store');
    return new Response(null, {status: 302, headers});
  }
  if (url.pathname === CALLBACK && request.method === 'GET') {
    configured(env);
    const pending = await unseal(cookies(request).ff_oauth, env, 'oauth');
    setCookie(headers, 'ff_oauth', '', 0, env);
    if (!pending || !url.searchParams.get('state') || pending.state !== url.searchParams.get('state')) return redirect('/?jira_error=invalid_state', env, headers);
    if (url.searchParams.has('error')) return redirect('/?jira_error=access_denied', env, headers);
    const code = url.searchParams.get('code');
    if (!code) return redirect('/?jira_error=missing_code', env, headers);
    try {
      const tokens = await exchange(env, {grant_type: 'authorization_code', code, redirect_uri: origin(env) + CALLBACK});
      await tokenCookies(tokens, random(), env, headers, true);
      return redirect('/?jira=connected', env, headers);
    } catch (error) {
      if (!(error instanceof AppError)) throw error;
      return redirect('/?jira_error=' + error.code, env, headers);
    }
  }
  if (url.pathname === '/api/auth/jira/logout' && request.method === 'POST') {
    verifyOrigin(request, env);
    for (const name of ['ff_access', 'ff_refresh', 'ff_oauth', 'ff_session']) setCookie(headers, name, '', 0, env);
    return json({connected: false}, 200, headers);
  }
  if (url.pathname === '/api/jira/ticket' && request.method === 'GET') {
    return json(await jiraTicket(request, env, headers), 200, headers);
  }
  if (url.pathname === '/api/jira/attachment' && request.method === 'GET') return attachmentContent(request, env, headers);
  return json({error: 'not_found', message: 'Not found'}, 404);
}
export {adfText, extractCriteria, parseTicket};
export default {
  async fetch(request, env) {
    const headers = new Headers();
    let response;
    try { response = await handle(request, env, headers); }
    catch (error) {
      response = json({error: error instanceof AppError ? error.code : 'internal_error', message: error instanceof AppError ? error.message : 'An unexpected error occurred.'}, error instanceof AppError ? error.status : 500, headers);
      if (response.status === 401 && env.APP_ORIGIN) for (const name of ['ff_access', 'ff_refresh']) response.headers.append('Set-Cookie', cookie(name, '', 0, env));
    }
    response.headers.set('X-Content-Type-Options', 'nosniff');
    response.headers.set('Referrer-Policy', 'no-referrer');
    if (!response.headers.has('Content-Security-Policy')) response.headers.set('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; media-src 'self'; frame-src 'self'; object-src 'none'; connect-src 'self'; base-uri 'none'; form-action 'self'");
    return response;
  },
};
