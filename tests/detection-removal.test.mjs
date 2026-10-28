import test from 'node:test';
import assert from 'node:assert/strict';
import { redact, scan, normalizePolicy, MAX_CHARACTERS, MAX_CUSTOM_FIELDS, MASK, ScanError } from '../src/index.mjs';
import { credentialCases, plainCases } from './fixtures/credentials.mjs';

test('retired detection rules produce no findings or replacements for the credential catalog', () => {
  const policy = { sensitiveNames: ['dataset_key'] };
  for (const { input } of credentialCases) {
    assert.deepEqual(scan(input, policy), [], input);
    assert.deepEqual(redact(input, policy), { text: input, count: 0, findings: [] }, input);
  }
});

test('distant candidates, code expressions and repeated values remain unchanged without a detector', () => {
  const value = 'hju867fggfgxxjgswrxl';
  const inputs = [...plainCases, `api key\n\n${value}`, `client secret is below.\n${value}`,
    `api_key=${value}\n${value}`, 'key={day}\nkey={event.id}',
    `dataset_key: ${value}`, `Authorization: Bearer\n${value}`,
    '-----BEGIN OPENSSH PRIVATE KEY-----\nSYNTHETIC-KEY'];
  for (const mode of ['redact', 'block']) for (const input of inputs) {
    assert.deepEqual(redact(input, { mode, sensitiveNames: ['dataset_key'] }), { text: input, count: 0, findings: [] });
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
  const prompt = 'api_key=synthetic-large-123\n' + 'ordinary text '.repeat(10000);
  assert.deepEqual(redact(prompt, undefined, prompt.length), { text: prompt, count: 0, findings: [] });
  for (const limit of [-1, Infinity, NaN, '2000000', prompt.length - 1]) assert.throws(() => scan(prompt, undefined, limit), ScanError);
});
