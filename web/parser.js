const clean = value => String(value || '').replace(/<br\s*\/?>/gi, '\n').replace(/\*\*/g, '').trim();
function cells(line) {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map(value => clean(value.replace(/\\\|/g, '|')));
}
export function parseGwt(text, source = 'Pasted criteria') {
  const raw = String(text || '').replace(/\\n/g, '\n');
  const lines = raw.split(/\r?\n/);
  const result = [];
  let columns = null;
  let table = 0;
  for (const line of lines) {
    if (!line.trim().startsWith('|')) { if (line.trim()) columns = null; continue; }
    const row = cells(line);
    const indexes = ['given', 'when', 'then'].map(word => row.findIndex(cell => new RegExp('^' + word + '\\b', 'i').test(cell)));
    if (indexes.every(index => index >= 0)) { columns = indexes; table++; continue; }
    if (!columns || row.every(cell => /^[-:\s]*$/.test(cell))) continue;
    const [given, when, then] = columns.map(index => row[index] || '');
    if (given || when || then) result.push({name: `Scenario ${result.length + 1}`, given, when, then, source: `${source} · table ${table}, row ${result.length + 1}`, draft: false});
  }
  if (result.length) return result;
  let current = null;
  let section = null;
  let background = '';
  let inBackground = false;
  function finish() {
    if (current && (current.given || current.when || current.then)) result.push({...current, source, draft: false});
    current = null; section = null;
  }
  for (const rawLine of lines) {
    const line = clean(rawLine);
    if (/^Background\s*:/i.test(line)) { finish(); inBackground = true; continue; }
    const title = line.match(/^(?:Scenario(?: Outline)?|Example|กรณีทดสอบ)\s*:\s*(.*)/i);
    if (title) { finish(); inBackground = false; current = {name: title[1] || `Scenario ${result.length + 1}`, given: background, when: '', then: ''}; continue; }
    const step = line.match(/^(Given|When|Then|And|But)\b\s*:?\s*(.*)/i);
    if (step) {
      const keyword = step[1].toLowerCase();
      if (inBackground) { background += (background ? '\n' : '') + step[2]; continue; }
      if (!current) current = {name: `Scenario ${result.length + 1}`, given: background, when: '', then: ''};
      if (['given', 'when', 'then'].includes(keyword)) section = keyword;
      if (!section) continue;
      current[section] += (current[section] ? '\n' : '') + step[2];
    } else if (current && section && line && !/^(Feature|Examples)\s*:/i.test(line)) {
      current[section] += '\n' + line;
    }
  }
  finish();
  return result;
}
export function ticketSources(ticket) {
  return [
    ...(ticket.acceptanceCriteria || []).map(field => ({name: `${field.name} (${field.id})`, text: field.text, kind: 'ac'})),
    {name: 'Description', text: ticket.description || '', kind: 'description'},
    ...(ticket.comments || []).map(comment => ({name: `Comment ${comment.id} · ${comment.author}`, text: comment.text, kind: 'comment'})),
  ].filter(source => source.text.trim());
}
export function ticketScenarios(ticket) {
  return ticketSources(ticket).flatMap(source => parseGwt(source.text, source.name));
}
export function draftCriteria(text, source = 'Acceptance criteria') {
  // These are visibly unconfirmed drafts, never claimed to be AI-generated or Jira GWT.
  const criteria = text.split(/\r?\n/).map(line => clean(line).replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '')).filter(Boolean);
  return criteria.map((criterion, index) => ({name: `Draft ${index + 1}`, given: '', when: '', then: criterion, source, draft: true}));
}
const quote = value => JSON.stringify(String(value));
export function generateScript(ticketKey, scenarios) {
  const supportedTabs = ['today', 'watch', 'privilege', 'shopping', 'home'];
  const cases = scenarios.map((flow, index) => {
    const tab = supportedTabs.find(tab => new RegExp('\\b' + tab + '\\b', 'i').test(flow.when + ' ' + flow.then));
    const scroll = /scroll|back to top|กลับ.*บน/i.test(flow.when + ' ' + flow.then);
    // Screen APIs have no verified top-position assertion; do not substitute a swipe as proof.
    const target = tab || '';
    const simpleNavigation = tab && new RegExp('^(?:(?:the )?user )?(?:tap|taps|select|selects|open|opens) (?:the )?' + target + '(?: tab| page| screen)?[.!]?$', 'i').test(flow.when.trim()) &&
      new RegExp('^(?:the )?' + target + '(?: tab| page| screen)? (?:is )?(?:displayed|visible|shown)[.!]?$', 'i').test(flow.then.trim());
    const given = flow.given.trim();
    const guest = !given || /^(?:(?:the )?user is (?:a )?)?(?:guest|non[- ]?login(?: user)?|not logged in)[.!]?$/i.test(given);
    const login = /^(?:(?:the )?user is )?(?:logged in(?: user)?|login user)[.!]?$/i.test(given);
    const runnable = simpleNavigation && !flow.draft && (guest || login);
    const reason = flow.draft ? 'Confirm Given and When for this AC draft.' : scroll ? 'Requires a verified scroll-position assertion and actual tab re-tap mapping.' : !runnable ? 'Requires mapping all preconditions, actions and assertions to verified repository APIs.' : '';
    const lines = [
      `test(${quote(`${ticketKey || 'MANUAL'} — ${flow.name || `Scenario ${index + 1}`}`)}, async ({ startApp, openMain, mainScreen }) => {`,
      '  test.setTimeout(240_000);',
      ...(!runnable ? [`  test.skip(true, ${quote(reason)});`] : []),
      ...['source', 'given', 'when', 'then'].flatMap(key => String(flow[key] || '').split('\n').map(line => '  // ' + key + ': ' + line.replace(/[\u2028\u2029]/g, ' '))),
      '  await startApp.execute();', login ? "  await openMain.execute('basic');" : '  await openMain.execute();',
      ...(tab ? [`  await mainScreen.bottomNavigation.selectTab('${tab}');`, `  await mainScreen.bottomNavigation.expectTabContent('${tab}');`] : []),
      ...(scroll && tab ? [`  await mainScreen.bottomNavigation.scrollDown('${tab}');`, '  // Map the original re-tap action and top-position assertion before enabling.'] : []),
      '});',
    ];
    return {code: lines.join('\n'), runnable, reason};
  });
  return {
    code: `// Flowforge · source ticket ${String(ticketKey || 'MANUAL').replace(/[\r\n\u2028\u2029]/g, ' ')}\n// Knowledge: trueid-app-v3-e2e @ 44148640d94945734b76ed70a47251b1bb06d7d4\n// core/fixtures/screenplays.ts, common/component/BottomNavigation.ts, RootTab.ts\n// Unmapped scenarios are skipped explicitly; review before running.\nimport { test } from '../../../../core/fixtures/screenplays';\n\n` + cases.map(item => item.code).join('\n\n'),
    runnable: cases.filter(item => item.runnable).length,
    pending: cases.filter(item => !item.runnable).length,
  };
}
