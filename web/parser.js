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
  let tableRow = 0;
  let current = null;
  let section = null;
  let background = '';
  let inBackground = false;
  function finish() {
    if (current && (current.given || current.when || current.then)) result.push({...current, source, draft: false});
    current = null; section = null;
  }
  for (const rawLine of lines) {
    if (rawLine.trim().startsWith('|')) {
      finish();
      const row = cells(rawLine);
      const indexes = ['given', 'when', 'then'].map(word => row.findIndex(cell => new RegExp('^' + word + '\\b', 'i').test(cell)));
      if (indexes.every(index => index >= 0)) { columns = indexes; table++; tableRow = 0; continue; }
      if (!columns || row.every(cell => /^[-:\s]*$/.test(cell))) continue;
      const [given, when, then] = columns.map(index => row[index] || '');
      if (given || when || then) {
        tableRow++;
        result.push({name: `Scenario ${result.length + 1}`, given, when, then, source: `${source} · table ${table}, row ${tableRow}`, draft: false});
      }
      continue;
    }
    if (rawLine.trim()) columns = null;
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
  return ticketSources(ticket).flatMap(source => {
    const parsed = parseGwt(source.text, source.name);
    return parsed.length || source.kind !== 'ac' ? parsed : draftCriteria(source.text, source.name + ' · draft interpretation');
  });
}
export function draftCriteria(text, source = 'Acceptance criteria') {
  const criteria = text.split(/\r?\n/).map(line => clean(line).replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '')).filter(Boolean);
  return criteria.map((criterion, index) => ({name: `Draft ${index + 1}`, given: '', when: '', then: criterion, source, draft: true}));
}
const quote = value => JSON.stringify(String(value));
export function generateScript(ticketKey, scenarios) {
  const supportedTabs = ['today', 'watch', 'privilege', 'shopping', 'home'];
  const cases = scenarios.map((flow, index) => {
    const tab = supportedTabs.find(tab => new RegExp('\\b' + tab + '\\b', 'i').test(flow.when + ' ' + flow.then));
    const scroll = /scroll|back to top|กลับ.*บน/i.test(flow.when + ' ' + flow.then);
    const target = tab || '';
    const simpleNavigation = tab && new RegExp('^(?:(?:the )?user )?(?:tap|taps|select|selects|open|opens) (?:the )?' + target + '(?: tab| page| screen)?[.!]?$', 'i').test(flow.when.trim()) &&
      new RegExp('^(?:the )?' + target + '(?: tab| page| screen)? (?:is )?(?:displayed|visible|shown)[.!]?$', 'i').test(flow.then.trim());
    const given = flow.given.trim();
    const guest = !given || /^(?:(?:the )?user is (?:a )?)?(?:guest|non[- ]?login(?: user)?|not logged in)[.!]?$/i.test(given);
    const login = /^(?:(?:the )?user is )?(?:logged in(?: user)?|login user)[.!]?$/i.test(given);
    const runnable = simpleNavigation && !flow.draft && (guest || login);
    const issues = [];
    if (flow.draft) issues.push({missing: 'GWT ยังเป็น draft ที่ไม่ได้ยืนยัน', action: 'เติม Given / When / Then แล้วตรวจและยืนยันแต่ละเคส'});
    if (/community/i.test(flow.when + ' ' + flow.then)) issues.push({missing: 'ยังไม่มี Community ใน RootTab ของ repo ที่ตรวจ', action: 'เพิ่มหรือยืนยัน Screen / locator และเส้นทางเปิด Community ก่อนนำมาใช้ในเคสนี้'});
    else if (!tab) issues.push({missing: 'ยังระบุ Screen / tab ที่ตรงกับเคสไม่ได้', action: 'เพิ่ม mapping ไปยัง Screen / locator ที่ตรวจสอบได้ใน repo'});
    if (/login\s+user\s*\/\s*non\s*login/i.test(given)) issues.push({missing: 'Given รวม Login และ Non-login แต่สคริปต์ยังไม่ได้แยกสองสถานะ', action: 'แยกเคส Login / Non-login และกำหนด setup กับข้อมูลทดสอบของแต่ละสถานะ'});
    else if (!guest && !login) issues.push({missing: 'ยังไม่มี setup ที่ครอบคลุม Given ตามต้นฉบับ', action: 'เพิ่ม Screenplay / fixture และข้อมูลทดสอบสำหรับเงื่อนไข Given นี้'});
    if (scroll) {
      issues.push({missing: 'ยังไม่มี action สำหรับกดแท็บเดิมซ้ำจริง', action: 'เพิ่ม action กด tabButton โดยตรง; selectTab() จะ return เมื่ออยู่แท็บเดิมแล้ว'});
      issues.push({missing: 'ยังไม่มี assertion ว่าหน้ากลับถึงบนสุดจริง', action: 'เพิ่ม top landmark หรือ scroll-offset assertion ของแต่ละหน้า และตรวจว่าก่อนกดอยู่ด้านล่าง; ห้ามใช้ swipe กลับขึ้นเป็นผลทดสอบ'});
    } else if (!simpleNavigation) issues.push({missing: 'When / Then ยัง map เป็น actions และ assertions ได้ไม่ครบ', action: 'เพิ่ม actions ตามลำดับและ assertions ของผลลัพธ์ทั้งหมด โดยใช้ API ที่มีจริงใน repo'});
    const reason = issues.map(issue => `${issue.missing} — ต้องเพิ่ม: ${issue.action}`).join(' | ');
    const lines = [
      `test(${quote(`${ticketKey || 'MANUAL'} — ${index + 1}. ${flow.name || 'Scenario'}`)}, async ({ startApp, openMain, mainScreen }) => {`,
      '  test.setTimeout(240_000);',
      ...(!runnable ? [
        '  // WARNING: สคริปต์นี้ยังทำงานตามเคสไม่ได้ ต้องทำ TODO ต่อไปนี้ให้ครบ',
        ...issues.map(issue => '  // TODO: ' + issue.missing + ' — ต้องเพิ่ม: ' + issue.action),
        `  throw new Error(${quote('INCOMPLETE SCRIPT: ' + reason)}); // Remove after completing every TODO above.`,
      ] : []),
      ...['source', 'given', 'when', 'then'].flatMap(key => String(flow[key] || '').split('\n').map(line => '  // ' + key + ': ' + line.replace(/[\u2028\u2029]/g, ' '))),
      '  await startApp.execute();', login ? "  await openMain.execute('basic');" : '  await openMain.execute();',
      ...(tab ? [`  await mainScreen.bottomNavigation.selectTab('${tab}');`, `  await mainScreen.bottomNavigation.expectTabContent('${tab}');`] : []),
      ...(scroll && tab ? [`  await mainScreen.bottomNavigation.scrollDown('${tab}');`, '  // Map the original re-tap action and top-position assertion before enabling.'] : []),
      '});',
    ];
    return {code: lines.join('\n'), runnable, reason, name: flow.name || `Scenario ${index + 1}`, index: index + 1, issues};
  });
  return {
    code: `// Flowforge · source ticket ${String(ticketKey || 'MANUAL').replace(/[\r\n\u2028\u2029]/g, ' ')}\n// Knowledge: trueid-app-v3-e2e @ 44148640d94945734b76ed70a47251b1bb06d7d4\n// core/fixtures/screenplays.ts, common/component/BottomNavigation.ts, RootTab.ts\n// ${cases.some(item => !item.runnable) ? 'WARNING: Incomplete script. See per-case TODOs. Incomplete cases throw until completed; no automatic skip.' : 'Repository mappings available. Device execution has not been performed.'}\nimport { test } from '../../../../core/fixtures/screenplays';\n\n` + cases.map(item => item.code).join('\n\n'),
    runnable: cases.filter(item => item.runnable).length,
    pending: cases.filter(item => !item.runnable).length,
    warnings: cases.filter(item => !item.runnable).map(({index, name, issues}) => ({index, name, issues})),
  };
}
