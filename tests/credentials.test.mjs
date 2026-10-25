import test from 'node:test';
import assert from 'node:assert/strict';
import { redact, scan } from '../src/index.mjs';
import { credentialCases, plainCases } from './fixtures/credentials.mjs';

const policy = { sensitiveNames: ['dataset_key'] };
test('credential catalog masks exact values and preserves all surrounding text', () => {
  for (const item of credentialCases) {
    const result = redact(item.input, policy);
    assert.equal(result.text, item.masked, item.name);
    assert.equal(result.count, item.count, item.name);
    assert.equal(redact(result.text, policy).count, 0, item.name);
    let cursor = 0, expected = '';
    for (const finding of result.findings) {
      assert.ok(finding.start >= cursor && finding.end > finding.start && finding.end <= item.input.length, item.name);
      expected += item.input.slice(cursor, finding.start) + 'xxxxxxxxxx';
      cursor = finding.end;
      assert.deepEqual(Object.keys(finding).sort(), ['end', 'start', 'type']);
    }
    assert.equal(expected + item.input.slice(cursor), item.masked, item.name);
  }
  for (const input of plainCases) assert.equal(redact(input, policy).text, input, input);
});

test('10,000 seeded rushed-label combinations mask completely and remain idempotent', () => {
  let seed = 0xC0FFEE;
  const pick = values => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return values[seed % values.length]; };
  const fields = ['key', 'api_key', 'api_token', 'secret_key', 'client_secret', 'access_token', 'auth_token',
    'refresh_token', 'password', 'passwd', 'pwd', 'token', 'private_key', 'aws_secret_access_key', 'aws_access_key_id', 'client_id'];
  for (let i = 0; i < 10_000; i++) {
    const field = pick(fields), join = pick(['', '_', '-', ' ', '\t', '\u00a0', '_- ']);
    const label = field.split('_').join(join).split('').map(letter => pick([true, false]) ? letter.toUpperCase() : letter).join('');
    const separator = pick([': ', ' = ', ' is ', '：', '＝', ':    ', '=']);
    const [open, close] = pick([['', ''], ['"', '"'], ["'", "'"], ['“', '”'], ['‘', '’'], ['`', '`']]);
    const value = `synthetic-fuzz-${i}-123`;
    const input = `Keep 🧪 ${label}${separator}${open}${value}${close}\nKeep this sentence.`;
    const expected = input.replace(value, 'xxxxxxxxxx');
    const result = redact(input);
    assert.equal(result.text, expected, `case ${i}: ${label}`);
    assert.equal(result.count, 1, `case ${i}`);
    assert.equal(scan(result.text).length, 0, `case ${i}`);
  }
});
