import test from 'node:test';
import assert from 'node:assert/strict';
import { redact, scan, normalizePolicy, MAX_CHARACTERS, MAX_CUSTOM_FIELDS, MASK, ScanError } from '../src/index.mjs';
import { credentialCases, plainCases } from './fixtures/credentials.mjs';

test('retired standalone provider rules remain inactive', () => {
  const policy = { sensitiveNames: ['dataset_key'] };
  for (const { input } of credentialCases.filter(item => item.input.startsWith('Inspect '))) {
    assert.deepEqual(scan(input, policy), [], input);
    assert.deepEqual(redact(input, policy), { text: input, count: 0, findings: [] }, input);
  }
});

test('retired distant and custom-field detection stays inactive', () => {
  const value = 'hju867fggfgxxjgswrxl';
  const inputs = [...plainCases, `api key\n\n${value}`, `client secret is below.\n${value}`,
    `${value}\n${value}`, 'key={day}\nkey={event.id}',
    `dataset_key: ${value}`, `Authorization: Bearer\n${value}`,
    '-----BEGIN OPENSSH PRIVATE KEY-----\nSYNTHETIC-KEY'];
  for (const mode of ['redact', 'block']) for (const input of inputs) {
    assert.deepEqual(redact(input, { mode, sensitiveNames: ['dataset_key'] }), { text: input, count: 0, findings: [] });
  }
});

test('later keyword, grouped-credential and custom-field additions are also inactive', () => {
  const first = 'Q7mV8z2R9tA4nP6xL3cD', second = 'B9wK4s8H2yF7vN5rT6aZ';
  const sensitiveNames = Array.from({ length: MAX_CUSTOM_FIELDS }, (_, i) => `dataset_${i}`);
  const inputs = [
    'api_key\n\n311331313113',
    `My API key and client secret are at the bottom.\nSome explanation.\n${first}\n${second}`,
    `${first}\nSome explanation.\n${second}\nThe API keys are above.`,
    'client id and client secret are\nFdenirddvj\nGhllgdfjkg',
    `api_key\n${first}\n${first}\n${second}`,
    sensitiveNames.map((name, i) => `${name}=${first}${i}`).join('\n'),
    sensitiveNames.join(', ') + ` are below.\n${first}\n${second}`,
  ];
  for (const field of ['key', 'api_key', 'api_token', 'client_secret', 'access_token', 'client_id']) {
    for (const join of ['', ' ', '_', '-', '\t', '_- ']) {
      const label = field.split('_').join(join).toUpperCase();
      for (const separator of [' is ', '：', '＝', '\n\n']) inputs.push(`${label}${separator}${first}`);
    }
  }
  for (const mode of ['redact', 'block']) for (const protectClientIds of [true, false]) {
    const policy = { mode, protectClientIds, sensitiveNames };
    for (const input of inputs) {
      assert.deepEqual(scan(input, policy), [], input);
      assert.deepEqual(redact(input, policy), { text: input, count: 0, findings: [] }, input);
    }
  }
});

test('policy settings, custom field limits and masking interface remain available', () => {
  const sensitiveNames = Array.from({ length: MAX_CUSTOM_FIELDS }, (_, i) => `dataset_${i}`);
  const policy = { mode: 'block', protectClientIds: false, sensitiveNames };
  assert.deepEqual(normalizePolicy(policy), policy);
  assert.equal(MAX_CUSTOM_FIELDS, 50);
  assert.equal(MASK, 'xxxxxxxxxx');
  assert.throws(() => normalizePolicy({ sensitiveNames: [...sensitiveNames, 'overflow'] }), ScanError);
  for (const invalid of [null, { mode: 'allow' }, { protectClientIds: 'false' }, { sensitiveNames: ['(a+)+$'] }]) {
    assert.throws(() => normalizePolicy(invalid), ScanError);
  }
});

test('input validation and the explicit prompt-sized limit are preserved', () => {
  for (const input of [null, {}, 'a'.repeat(MAX_CHARACTERS + 1)]) assert.throws(() => scan(input), ScanError);
  const prompt = 'api_key\n' + 'ordinary text '.repeat(10000);
  assert.deepEqual(redact(prompt, undefined, prompt.length), { text: prompt, count: 0, findings: [] });
  for (const limit of [-1, Infinity, NaN, '2000000', prompt.length - 1]) assert.throws(() => scan(prompt, undefined, limit), ScanError);
});
