import {parseGwt, ticketScenarios, draftCriteria, generateScript} from './parser.js';
import {renderMedia} from './media.js';
const $ = id => document.getElementById(id);
let auth = {connected: false, sites: []};
let loaded = null;
let scenarios = [];
let loading = null;
let version = 0;
const toast = message => { $('toast').textContent = message; $('toast').classList.add('show'); setTimeout(() => $('toast').classList.remove('show'), 2500); };
function error(message = '') { $('error').textContent = message; }
function clearOutput() { $('code').textContent = 'Generate a script from the current scenarios.'; $('generationStatus').textContent = ''; $('scriptWarnings').replaceChildren(); $('scriptWarnings').hidden = true; }
function cancelLoad() {
  loading?.abort(); loading = null; version++;
  $('load').disabled = false; $('load').textContent = 'Load ticket';
}
function showWarnings(warnings) {
  const container = $('scriptWarnings');
  container.replaceChildren(); container.hidden = !warnings.length;
  if (!warnings.length) return;
  const heading = document.createElement('strong');
  heading.textContent = '⚠ WARNING: สคริปต์ยังทำงานตามเคสไม่ได้ครบ';
  const note = document.createElement('p');
  note.textContent = 'สร้างและ Copy สคริปต์ได้ทุกเคส แต่ต้องเติมสิ่งที่ขาดด้านล่างก่อนรัน เคสที่ยังไม่ครบจะ throw INCOMPLETE SCRIPT แทนการ skip หรือผ่านโดยไม่ตรวจผลจริง';
  container.append(heading, note);
  for (const warning of warnings) {
    const entry = document.createElement('details'); entry.open = warning.index === 1;
    const title = document.createElement('summary'); title.textContent = `เคส ${warning.index}: ${warning.name} — ขาด ${warning.issues.length} รายการ`;
    const list = document.createElement('ul');
    for (const issue of warning.issues) {
      const item = document.createElement('li');
      const missing = document.createElement('div'); missing.textContent = 'ขาด: ' + issue.missing;
      const action = document.createElement('div'); action.textContent = 'ต้องเพิ่ม: ' + issue.action;
      item.append(missing, action); list.append(item);
    }
    entry.append(title, list); container.append(entry);
  }
}
async function api(path, options = {}) {
  const response = await fetch(path, {credentials: 'same-origin', cache: 'no-store', ...options});
  const data = await response.json();
  if (!response.ok) { const problem = new Error(data.message || 'Request failed'); problem.status = response.status; throw problem; }
  return data;
}
function showAuth() {
  $('login').hidden = !!auth.connected;
  $('logout').hidden = !auth.connected;
  $('login').setAttribute('aria-disabled', auth.configured === false ? 'true' : 'false');
  $('connection').textContent = auth.connected ? `Connected · ${auth.profile?.name || 'Jira'} · read-only` : auth.configured ? 'Jira disconnected' : 'Jira configuration required';
  $('authHint').textContent = auth.connected ? 'Issues, custom AC fields and all comments are read using your Jira account.' : auth.configured === false ? 'Setup required: ' + (auth.missing || []).join(', ') : 'Login to load a Jira ticket. You can also paste criteria below.';
  $('workspace').hidden = !auth.connected || !auth.sites?.length;
  const previous = $('workspace').value;
  $('workspace').replaceChildren(...(auth.sites || []).map(site => new Option(site.name, site.id)));
  if (auth.sites?.some(site => site.id === previous)) $('workspace').value = previous;
}
async function refreshAuth() {
  try { auth = await api('/api/auth/jira/status'); }
  catch (problem) { auth = {configured: true, connected: false}; error(problem.message); }
  showAuth();
}
function render() {
  $('parseState').textContent = `${scenarios.length} CASES`;
  $('scenarios').replaceChildren();
  scenarios.forEach((flow, index) => {
    const card = document.createElement('article'); card.className = 'case';
    const title = document.createElement('h3'); title.textContent = `${index + 1}. ${flow.name}${flow.draft ? ' · DRAFT — review required' : ''}`; card.append(title);
    const grid = document.createElement('div'); grid.className = 'scenario';
    for (const [kind, label, cls] of [['given', 'Given', 'g'], ['when', 'When', 'w'], ['then', 'Then', 't']]) {
      const step = document.createElement('div'); step.className = 'step ' + cls;
      const heading = document.createElement('h4'); heading.textContent = label; step.append(heading);
      if (flow.draft) {
        const input = document.createElement('textarea'); input.value = flow[kind]; input.setAttribute('aria-label', `${label} for ${flow.name}`);
        input.addEventListener('input', () => { cancelLoad(); flow[kind] = input.value; $('sourceState').textContent = 'EDITED'; clearOutput(); }); step.append(input);
      } else { const content = document.createElement('p'); content.textContent = flow[kind] || 'Not specified in source'; step.append(content); }
      grid.append(step);
    }
    card.append(grid);
    const source = document.createElement('div'); source.className = 'case-source'; source.textContent = 'Source: ' + flow.source; card.append(source);
    if (flow.draft) {
      const confirm = document.createElement('button'); confirm.className = 'btn'; confirm.textContent = 'Confirm this GWT draft';
      confirm.addEventListener('click', () => {
        cancelLoad();
        if (!flow.given.trim() || !flow.when.trim() || !flow.then.trim()) { error('Fill Given, When and Then before confirming this draft.'); return; }
        flow.draft = false; flow.source += ' · user-confirmed interpretation'; clearOutput(); render(); error();
      }); card.append(confirm);
    }
    $('scenarios').append(card);
  });
}
function invalidateTicket() {
  cancelLoad(); loaded = null; scenarios = []; clearOutput(); render();
  $('sourceState').textContent = 'NOT LOADED'; $('ticketMeta').replaceChildren();
  $('criteria').value = ''; $('criteriaSource').textContent = 'Ticket changed. Load again to read the current source.';
  $('description').textContent = ''; $('comments').replaceChildren();
  $('descriptionDetails').hidden = true; $('commentsDetails').hidden = true;
  renderMedia(null, $('media'));
}
$('ticket').addEventListener('input', invalidateTicket);
$('workspace').addEventListener('change', invalidateTicket);
$('criteria').addEventListener('input', () => {
  cancelLoad();
  scenarios = parseGwt($('criteria').value, 'Edited / pasted criteria');
  $('criteriaSource').textContent = 'Locally edited criteria; original description and comments remain below.';
  $('sourceState').textContent = 'EDITED'; clearOutput(); render();
});
$('load').addEventListener('click', async () => {
  error();
  if (!auth.connected) { error('Login with Jira before loading a ticket.'); return; }
  const input = $('ticket').value.trim();
  if (!input) { error('Enter a Jira key or URL.'); return; }
  loading?.abort(); loading = new AbortController();
  const ownVersion = ++version;
  $('load').disabled = true; $('load').textContent = 'Loading…';
  try {
    const params = new URLSearchParams({ticket: input});
    if (!/^https:\/\//i.test(input) && $('workspace').value) params.set('cloudId', $('workspace').value);
    const ticket = await api('/api/jira/ticket?' + params, {signal: loading.signal});
    if (ownVersion !== version) return;
    loaded = ticket;
    const link = document.createElement('a'); link.href = ticket.url; link.textContent = `${ticket.key} · ${ticket.summary}`; link.target = '_blank'; link.rel = 'noopener noreferrer';
    $('ticketMeta').replaceChildren(link, document.createTextNode(`\n${ticket.status} · synced ${new Date(ticket.fetchedAt).toLocaleString()}`));
    $('workspace').value = ticket.site.id;
    const ac = ticket.acceptanceCriteria || [];
    $('criteria').value = ac.length ? ac.map(field => field.text).join('\n\n') : ticket.description;
    $('criteriaSource').textContent = ac.length ? 'Jira custom field: ' + ac.map(field => `${field.name} (${field.id})`).join(', ') : 'No dedicated AC field found. Showing original Jira description.';
    $('description').textContent = ticket.description || '(No description)'; $('descriptionDetails').hidden = false;
    $('commentsSummary').textContent = `Jira comments (${ticket.comments.length})`;
    $('comments').replaceChildren(...ticket.comments.map(comment => {
      const element = document.createElement('div'); element.className = 'comment'; element.textContent = `${comment.author} · ${comment.id}\n${comment.text}`; return element;
    })); $('commentsDetails').hidden = false;
    renderMedia(ticket, $('media'));
    scenarios = ticketScenarios(ticket);
    if (!scenarios.length) {
      scenarios = draftCriteria($('criteria').value, ac.length ? 'Original Jira AC · draft interpretation' : 'Original description · draft interpretation');
    }
    $('sourceState').textContent = 'LIVE JIRA'; clearOutput(); render();
    toast(`Loaded ${ticket.key} · ${scenarios.length} cases`);
  } catch (problem) {
    if (problem.name === 'AbortError' || ownVersion !== version) return;
    loaded = null; scenarios = []; clearOutput(); render();
    $('criteria').value = ''; $('criteriaSource').textContent = 'Ticket was not loaded.';
    $('ticketMeta').replaceChildren(); $('comments').replaceChildren();
    $('descriptionDetails').hidden = true; $('commentsDetails').hidden = true;
    renderMedia(null, $('media'));
    $('sourceState').textContent = 'LOAD FAILED'; error(problem.message);
    if (problem.status === 401) { auth.connected = false; showAuth(); }
  } finally {
    if (ownVersion === version) { loading = null; $('load').disabled = false; $('load').textContent = 'Load ticket'; }
  }
});
$('logout').addEventListener('click', async () => {
  try { await api('/api/auth/jira/logout', {method: 'POST'}); invalidateTicket(); auth = {configured: true, connected: false, sites: []}; showAuth(); }
  catch (problem) { error(problem.message); }
});
$('generate').addEventListener('click', () => {
  error();
  if (!scenarios.length) { scenarios = parseGwt($('criteria').value); if (!scenarios.length) scenarios = draftCriteria($('criteria').value); render(); }
  if (!scenarios.length) { error('Load a ticket or enter acceptance criteria first.'); return; }
  const output = generateScript(loaded?.key || 'MANUAL', scenarios);
  $('code').textContent = output.code;
  $('generationStatus').textContent = `${scenarios.length} scripts generated · ${output.runnable} mapped · ${output.pending} incomplete. Device execution has not been performed.`;
  showWarnings(output.warnings);
  toast(output.pending ? 'สร้างสคริปต์ครบแล้ว — อ่าน WARNING และ TODO ก่อนรัน' : 'Script generated. Review before running.');
});
$('copy').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText($('code').textContent); toast('Script copied'); }
  catch { error('Clipboard access was denied. Select the script and copy it manually.'); }
});
const params = new URLSearchParams(location.search);
if (params.has('jira_error')) {
  const messages = {access_denied: 'Jira authorization was cancelled.', invalid_state: 'The login session expired or could not be verified. Try Login with Jira again.', missing_code: 'Atlassian did not return an authorization code.', oauth_exchange_failed: 'Jira OAuth token exchange failed. Check the client credentials and callback URL.'};
  error(messages[params.get('jira_error')] || 'Jira login failed. Try again.');
}
if (params.has('jira') || params.has('jira_error')) { params.delete('jira'); params.delete('jira_error'); history.replaceState(null, '', location.pathname + (params.size ? '?' + params : '')); }
render(); refreshAuth();
