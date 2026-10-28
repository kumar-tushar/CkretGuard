import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { scan, redact, MASK } from '../src/index.mjs';

const reference = JSON.parse(await readFile(new URL('./fixtures/gitleaks-generic.json', import.meta.url), 'utf8'));
const value = 'N7q2V9m4R8s6T3x5K1p0L2z7H4c9D6b8';

test('generic-api-key matches the pinned upstream reference corpus', () => {
  assert.deepEqual(SecretShieldRules.rules.map(rule => rule.id), ['generic-api-key']);
  assert.match(SecretShieldRules.source, /5f6ec56cfa6f8c67648d863582c7ae2f206d5c1c/);
  for (const fixture of reference.cases) {
    const findings = scan(fixture.input);
    assert.deepEqual(findings.map(item => fixture.input.slice(item.start, item.end)), fixture.secrets, fixture.name);
    let cursor = 0, expected = '';
    for (const item of findings) {
      assert.deepEqual(Object.keys(item).sort(), ['end', 'start', 'type']);
      assert.equal(item.type, 'generic-api-key');
      assert.ok(item.start >= cursor && item.end > item.start && item.end <= fixture.input.length, fixture.name);
      expected += fixture.input.slice(cursor, item.start) + MASK;
      cursor = item.end;
    }
    expected += fixture.input.slice(cursor);
    const result = redact(fixture.input);
    assert.equal(result.count, fixture.secrets.length, fixture.name);
    assert.equal(result.text, expected, fixture.name);
    assert.equal(scan(result.text).length, 0, fixture.name);
  }
});

test('strict entropy boundary and character limits are rule-specific', () => {
  assert.equal(scan('api_key=aabbccdd01234567').length, 0, 'entropy of exactly 3.5 is excluded');
  assert.equal(scan('api_key=aabbccd012345678').length, 1, 'entropy above 3.5 is accepted');
  assert.equal(scan('api_key=A1b2C3d4E5f').length, 0);
  assert.equal(scan('api_key=A1b2C3d4E5f6').length, 1);
  const withUnderscore = (value.slice(0, 4) + '_' + value.repeat(7)).slice(0, 151);
  assert.equal(scan('api_key=' + withUnderscore.slice(0, 150)).length, 1);
  assert.equal(scan('api_key=' + withUnderscore).length, 0);
  assert.equal(scan('api_key=' + value.repeat(7)).length, 1, 'the base64/alphanumeric branch is not capped at 150');
});

test('only captured occurrences are masked and offsets remain UTF-16 editor offsets', () => {
  const text = `🔐 हिन्दी ${value}\napi_key="${value}"\n${value}\npassword: ${value}`;
  const first = text.indexOf(value, text.indexOf('api_key'));
  const last = text.lastIndexOf(value);
  assert.deepEqual(scan(text), [
    { start: first, end: first + value.length, type: 'generic-api-key' },
    { start: last, end: last + value.length, type: 'generic-api-key' },
  ]);
  assert.equal(redact(text).text, `🔐 हिन्दी ${value}\napi_key="${MASK}"\n${value}\npassword: ${MASK}`);
  assert.ok(!JSON.stringify(scan(text)).includes(value), 'findings do not duplicate secret values');
});

test('saved custom fields and client-ID settings do not restore retired matching', () => {
  for (const mode of ['redact', 'block']) for (const protectClientIds of [false, true]) {
    const policy = { mode, protectClientIds, sensitiveNames: ['dataset_name'] };
    for (const input of [`dataset_name=${value}`, `client_id=${value}`, `api key\n\n${value}`, value]) {
      assert.deepEqual(scan(input, policy), [], input);
    }
    assert.equal(scan('client_secret=' + value, policy).length, 1);
  }
});

test('complete large browser drafts and repeated scans stay deterministic', { timeout: 10000 }, () => {
  const text = 'Explain this ordinary paragraph.\n'.repeat(10000) + 'api_key=' + value;
  for (let i = 0; i < 5; i++) {
    assert.equal(redact(text, undefined, text.length).text, text.slice(0, -value.length) + MASK);
    assert.deepEqual(scan('Ordinary text.'), []);
    assert.equal(scan('api_key=' + value).length, 1);
  }
  const repeated = Array(500).fill('api_key=' + value).join('\n');
  assert.equal(scan(repeated).length, 500);
  assert.equal(redact(repeated).text, Array(500).fill('api_key=' + MASK).join('\n'));
});

test('missing or invalid bundled rules fail closed with a safe error', async () => {
  const source = await readFile(new URL('../src/core.js', import.meta.url), 'utf8');
  const copy = () => JSON.parse(JSON.stringify(SecretShieldRules));
  const invalid = [undefined, { rules: [] }];
  for (const change of [
    rules => { rules.rules[0].regex = '('; },
    rules => { rules.rules[0].secretGroup = 2; },
    rules => { rules.rules[0].entropy = -1; },
    rules => { rules.rules.push(rules.rules[0]); },
    rules => { rules.rules[0].allowlists[0].regexTarget = 'unknown'; },
    rules => { rules.rules[0].allowlists[0].condition = 'unknown'; },
    rules => { rules.rules[0].allowlists[0].stopwords = 'invalid'; },
  ]) { const rules = copy(); change(rules); invalid.push(rules); }
  for (const rules of invalid) {
    const context = vm.createContext({ SecretShieldRules: rules });
    vm.runInContext(source, context);
    assert.throws(() => context.SecretShieldCore.scan('api_key=' + value), { message: 'This text could not be scanned. Keep it local and shorten it before retrying.' });
  }
});

test('built extension includes the rule snapshot and upstream license', async () => {
  const { spawnSync } = await import('node:child_process');
  assert.equal(spawnSync(process.execPath, ['scripts/build.mjs']).status, 0);
  for (const file of ['gitleaks-rules.js', 'core.js']) {
    assert.equal(await readFile(new URL('../dist/' + file, import.meta.url), 'utf8'), await readFile(new URL('../src/' + file, import.meta.url), 'utf8'));
  }
  assert.match(await readFile(new URL('../dist/licenses/GITLEAKS.txt', import.meta.url), 'utf8'), /Copyright \(c\) 2019 Zachary Rice/);
});
