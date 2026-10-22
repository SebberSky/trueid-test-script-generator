import test from 'node:test';
import assert from 'node:assert/strict';
import {parseGwt, ticketScenarios, draftCriteria, generateScript} from '../web/parser.js';
test('ADF-style GWT table preserves all rows, line breaks and escaped pipes', () => {
  const cases = parseGwt('| Given(Test Data) | When(Test Steps) | Then(Expected Results) |\n| User | Open Today<br>Scroll down | Back to top |\n| Guest | Tap Watch | A \\| B |');
  assert.equal(cases.length, 2);
  assert.equal(cases[0].when, 'Open Today\nScroll down');
  assert.equal(cases[1].then, 'A | B');
});
test('And and But attach to the active GWT section across multiple scenarios', () => {
  const cases = parseGwt('Background:\nGiven app is open\nScenario: first\nGiven guest\nWhen taps Watch\nAnd scrolls\nThen visible\nBut empty\nScenario: second\nWhen taps Today\nThen shown');
  assert.equal(cases.length, 2);
  assert.equal(cases[0].given, 'app is open\nguest');
  assert.equal(cases[0].when, 'taps Watch\nscrolls');
  assert.equal(cases[0].then, 'visible\nempty');
  assert.equal(cases[1].given, 'app is open');
});
test('mixed text and table GWT retain every case in source order with local table row numbers', () => {
  const cases = parseGwt('Scenario: before\nGiven first\nWhen first action\nThen first result\n\n| Given | When | Then |\n| middle | middle action | middle result |\n\nScenario: after\nGiven last\nWhen last action\nThen last result\n\n| Given | When | Then |\n| final | final action | final result |', 'Description');
  assert.deepEqual(cases.map(flow => flow.given), ['first', 'middle', 'last', 'final']);
  assert.deepEqual(cases.map(flow => flow.then), ['first result', 'middle result', 'last result', 'final result']);
  assert.equal(cases[3].source, 'Description · table 2, row 1');
});
test('custom AC, description and comment cases retain their exact source', () => {
  const cases = ticketScenarios({acceptanceCriteria: [{id: 'customfield_1', name: 'AC', text: 'Given a\nWhen b\nThen c'}], description: '', comments: [{id: '2', author: 'QA', text: '| Given | When | Then |\n| x | y | z |'}]});
  assert.equal(cases.length, 2);
  assert.match(cases[0].source, /customfield_1/);
  assert.match(cases[1].source, /Comment 2/);
});
test('plain AC remains an unconfirmed draft even when comments contain existing GWT', () => {
  const cases = ticketScenarios({acceptanceCriteria: [{id: 'customfield_1', name: 'AC', text: 'Search must support Thai text'}], comments: [{id: '2', author: 'QA', text: 'Given guest\nWhen Tap Watch\nThen Watch page is displayed'}]});
  assert.equal(cases.length, 2);
  assert.equal(cases[0].draft, true);
  assert.equal(cases[0].then, 'Search must support Thai text');
  assert.equal(cases[1].draft, false);
});
test('same scenario names from different sources produce unique test titles', () => {
  const scenario = {name: 'Scenario 1', given: 'guest', when: 'Tap Watch', then: 'Watch page is displayed', source: 'AC', draft: false};
  const output = generateScript('VAL-1', [scenario, {...scenario, source: 'Comment 2'}]);
  const titles = [...output.code.matchAll(/\ntest\(("[^\n]+?"), async/g)].map(match => JSON.parse(match[1]));
  assert.equal(titles.length, 2);
  assert.equal(new Set(titles).size, 2);
});
test('partially structured custom AC retains prose requirements alongside parsed GWT', () => {
  const cases = ticketScenarios({acceptanceCriteria: [{id: 'customfield_1', name: 'AC', text: 'Search must support Thai text\n\nScenario: Watch\nGiven guest\nWhen Tap Watch\nThen Watch page is displayed'}]});
  assert.equal(cases.length, 2);
  assert.ok(cases.some(flow => flow.draft && flow.then === 'Search must support Thai text'));
  assert.ok(cases.some(flow => !flow.draft && flow.name === 'Watch'));
});
test('raw AC drafts are marked unconfirmed and unsupported scripts never pretend to pass', () => {
  const drafts = draftCriteria('1. Back to top on Today\n2. Community should open');
  assert.equal(drafts.length, 2);
  assert.ok(drafts.every(item => item.draft));
  const output = generateScript('VAL-1928', drafts);
  assert.equal(output.pending, 2);
  assert.equal(output.runnable, 0);
  assert.match(output.code, /throw new Error\("INCOMPLETE SCRIPT:/);
  assert.doesNotMatch(output.code, /test.skip\(/);
  assert.equal(output.warnings.length, 2);
  assert.doesNotMatch(output.code, /scrollToTop\(/);
});
test('back-to-top exports every script with precise missing mappings and follow-up actions', () => {
  const cases = ['Today', 'Watch', 'Privilege', 'Community', 'Shopping'].map(tab => ({name: tab, given: 'User type:\nLogin user/Non login', when: `Open TrueID app\nTap Bottom Navigation menu on ${tab} page\nUser scroll down page\nTap Bottom Navigation menu (previous) again`, then: 'User can Back to top page.', source: 'Description', draft: false}));
  const output = generateScript('VAL-1928', cases);
  assert.equal((output.code.match(/\ntest\(/g) || []).length, 5);
  assert.equal(output.warnings.length, 5);
  assert.equal(output.pending, 5);
  assert.doesNotMatch(output.code, /test.skip\(/);
  assert.equal((output.code.match(/throw new Error\(/g) || []).length, 5);
  assert.ok(output.warnings.every(warning => warning.issues.some(issue => issue.missing.includes('กดแท็บเดิม'))));
  assert.ok(output.warnings.every(warning => warning.issues.some(issue => issue.action.includes('scroll-offset'))));
  assert.ok(output.warnings.every(warning => warning.issues.some(issue => issue.action.includes('แยกเคส Login'))));
  assert.ok(output.warnings[3].issues.some(issue => issue.missing.includes('Community')));
  assert.ok(output.warnings.every(warning => warning.issues.every(issue => issue.missing && issue.action)));
});
test('plain navigation uses repository Screenplay fixtures and the requested tab', () => {
  const output = generateScript('VAL-1', [{name: 'Watch', given: '', when: 'Tap Watch', then: 'Watch page is displayed', source: 'Jira', draft: false}]);
  assert.equal(output.runnable, 1);
  assert.match(output.code, /selectTab\('watch'\)/);
  assert.match(output.code, /expectTabContent\('watch'\)/);
});
test('known guest and login preconditions map to OpenMain while mismatched assertions stay incomplete', () => {
  const flow = {name: 'Watch', given: 'guest', when: 'Tap Watch', then: 'Watch page is displayed', source: 'Jira', draft: false};
  assert.equal(generateScript('VAL-1', [flow]).runnable, 1);
  const login = generateScript('VAL-1', [{...flow, given: 'logged in user'}]);
  assert.equal(login.runnable, 1);
  assert.match(login.code, /openMain.execute\('basic'\)/);
  assert.equal(generateScript('VAL-1', [{...flow, then: 'Shopping page is displayed'}]).pending, 1);
  assert.equal(generateScript('VAL-1', [{...flow, given: 'premium user with expired subscription'}]).pending, 1);
});
