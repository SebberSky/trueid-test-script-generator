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
test('custom AC, description and comment cases retain their exact source', () => {
  const cases = ticketScenarios({acceptanceCriteria: [{id: 'customfield_1', name: 'AC', text: 'Given a\nWhen b\nThen c'}], description: '', comments: [{id: '2', author: 'QA', text: '| Given | When | Then |\n| x | y | z |'}]});
  assert.equal(cases.length, 2);
  assert.match(cases[0].source, /customfield_1/);
  assert.match(cases[1].source, /Comment 2/);
});
test('raw AC drafts are marked unconfirmed and unsupported scripts never pretend to pass', () => {
  const drafts = draftCriteria('1. Back to top on Today\n2. Community should open');
  assert.equal(drafts.length, 2);
  assert.ok(drafts.every(item => item.draft));
  const output = generateScript('VAL-1928', drafts);
  assert.equal(output.pending, 2);
  assert.equal(output.runnable, 0);
  assert.match(output.code, /test.skip\(true/);
  assert.doesNotMatch(output.code, /scrollToTop\(/);
});
test('plain navigation uses repository Screenplay fixtures and the requested tab', () => {
  const output = generateScript('VAL-1', [{name: 'Watch', given: '', when: 'Tap Watch', then: 'Watch page is displayed', source: 'Jira', draft: false}]);
  assert.equal(output.runnable, 1);
  assert.match(output.code, /selectTab\('watch'\)/);
  assert.match(output.code, /expectTabContent\('watch'\)/);
});
test('known guest and login preconditions map to OpenMain while mismatched assertions stay skipped', () => {
  const flow = {name: 'Watch', given: 'guest', when: 'Tap Watch', then: 'Watch page is displayed', source: 'Jira', draft: false};
  assert.equal(generateScript('VAL-1', [flow]).runnable, 1);
  const login = generateScript('VAL-1', [{...flow, given: 'logged in user'}]);
  assert.equal(login.runnable, 1);
  assert.match(login.code, /openMain.execute\('basic'\)/);
  assert.equal(generateScript('VAL-1', [{...flow, then: 'Shopping page is displayed'}]).pending, 1);
  assert.equal(generateScript('VAL-1', [{...flow, given: 'premium user with expired subscription'}]).pending, 1);
});
