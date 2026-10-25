import test from 'node:test';
import assert from 'node:assert/strict';
import { redact, scan, ScanError } from '../src/index.mjs';

const MASK = 'xxxxxxxxxx';
test('authentication prose and generic key instructions are not credentials', () => {
  for (const input of ['Explain the basic authentication flow.', 'Explain bearer authentication.',
    'The key is to retry with exponential backoff.', 'The secret is to keep trying.',
    'Basic authentication is an HTTP scheme.', 'Bearer authentication uses an access token.',
    'Our key is to test carefully.', 'The key is that retries need a delay.']) {
    assert.equal(redact(input).text, input, input);
    assert.equal(scan(input).length, 0, input);
  }
});
test('explicit and standalone authentication credentials retain detection', () => {
  for (const input of ['Authorization: Bearer abcdef', 'Authorization: Basic dXNlcjpwYXNz',
    'Bearer synthetic-token-123', 'Basic dXNlcjpwYXNz', 'Use Bearer synthetic-token-123 for this request.',
    'key is tgdd444', 'key: to', 'key = to', 'key is "to"', 'client secret is tgdd444']) {
    assert.ok(redact(input).count > 0, input);
  }
  assert.throws(() => redact('Authorization: Bearer\napi_key=synthetic-other-123'), ScanError);
});
test('grouped credential labels map to separate following values without changing prose', () => {
  const cases = [
    ['client id and client secret are\nFdenirddvj\nGhllgdfjkg', `client id and client secret are\n${MASK}\n${MASK}`],
    ['clienT Id, clienT-secret are:\r\n  synthetic-id-123\r\n  synthetic-secret-456', `clienT Id, clienT-secret are:\r\n  ${MASK}\r\n  ${MASK}`],
    ['apiKey & access-token:\n- synthetic-key-123\n- synthetic-token-456', `apiKey & access-token:\n- ${MASK}\n- ${MASK}`],
    ['my client id and client secret are\n\nsynthetic-app-123\n\nsynthetic-secret-456\nExplain this config.', `my client id and client secret are\n\n${MASK}\n\n${MASK}\nExplain this config.`],
    ['api_key, password, and client secret are\n1. synthetic-key-123\n2. "synthetic password phrase"\n3. synthetic-secret-456', `api_key, password, and client secret are\n1. ${MASK}\n2. "${MASK}"\n3. ${MASK}`],
    ['`client id` and `client secret` are\n"synthetic id phrase"\n“synthetic secret phrase”', `\x60client id\x60 and \x60client secret\x60 are\n"${MASK}"\n“${MASK}”`],
    ['secret key and password are\nsynthetic-key-123\nsynthetic-password-456', `secret key and password are\n${MASK}\n${MASK}`],
  ];
  for (const [input, expected] of cases) {
    assert.equal(redact(input).text, expected, input);
    assert.equal(redact(expected).count, 0, input);
  }
});
test('grouped client IDs retain their value position when protection is disabled', () => {
  const input = 'client id and client secret are\nsynthetic-public-id-123\nsynthetic-private-secret-456';
  assert.equal(redact(input, { protectClientIds: false }).text,
    `client id and client secret are\nsynthetic-public-id-123\n${MASK}`);
  const custom = 'dataset_key and password are\nsynthetic-dataset-123\nsynthetic-password-456';
  assert.equal(redact(custom, { sensitiveNames: ['dataset_key'] }).text,
    `dataset_key and password are\n${MASK}\n${MASK}`);
  assert.equal(redact('client id and client_id are\npublic-app\npublic-app', { protectClientIds: false }).count, 0);
  assert.equal(redact(input.replace('are', ':'), { protectClientIds: false }).text,
    `client id and client secret :\nsynthetic-public-id-123\n${MASK}`);
  assert.equal(redact('key and password and api_key are\nsynthetic-custom-123\nsynthetic-api-456',
    { sensitiveNames: ['key and password'] }).text,
    `key and password and api_key are\n${MASK}\n${MASK}`);
});
test('incomplete grouped credentials fail closed after a value instead of partially masking', () => {
  assert.throws(() => redact('client id and client secret are\nsynthetic-only-one-123'), ScanError);
  assert.throws(() => redact('api_key and password are\nsynthetic-first-123\npassword=synthetic-other-456'), ScanError);
});
test('grouped descriptions and ordinary lists remain unchanged', () => {
  for (const input of ['Client ID and client secret are app credentials.',
    'client id and client secret are\nrequired for authentication.',
    'Shopping list:\napples\noranges', 'The key is to\nretry with a delay.']) assert.equal(redact(input).text, input, input);
});

test('grouped fields preserve placeholders, repeated values, and bounded list size', () => {
  const input = 'client id and client secret are\n${APP_ID}\nsynthetic-secret-123\nRepeat synthetic-secret-123.';
  assert.equal(redact(input).text, `client id and client secret are\n\${APP_ID}\n${MASK}\nRepeat ${MASK}.`);
  const names = Array.from({ length: 50 }, (_, i) => `dataset_${i}`);
  const original = names.join(', ') + ' are\n' + names.map((_, i) => `synthetic-group-${i}-123`).join('\n');
  const output = redact(original, { sensitiveNames: names });
  assert.equal(output.count, 50);
  assert.equal(output.text, names.join(', ') + ' are\n' + names.map(() => MASK).join('\n'));
  assert.equal(redact(output.text, { sensitiveNames: names }).count, 0);
  assert.throws(() => redact(Array(51).fill('api_key').join(', ') + ' are\n' + Array(51).fill('synthetic-overflow-123').join('\n')), ScanError);
});

test('all named credential families group across spelling, join, and client-ID policy variants', () => {
  for (const field of ['key', 'api_key', 'api_token', 'secret', 'secret_key', 'access_token', 'auth_token',
    'refresh_token', 'password', 'passwd', 'pwd', 'token', 'private_key', 'aws_secret_access_key', 'aws_access_key_id', 'authorization', 'client_id']) {
    for (const wordJoin of [' ', '_', '-', '', '\t', '_- ']) {
      const label = field.split('_').join(wordJoin).toUpperCase();
      for (const join of [' and ', ', ', ' & ']) for (const protectClientIds of [true, false]) {
        const input = `${label}${join}client secret are:\nsynthetic-group-first-123\nsynthetic-group-second-456`;
        const expected = `${label}${join}client secret are:\n${field === 'client_id' && !protectClientIds ? 'synthetic-group-first-123' : MASK}\n${MASK}`;
        const output = redact(input, { protectClientIds });
        assert.equal(output.text, expected, input);
        assert.equal(redact(output.text, { protectClientIds }).count, 0, input);
      }
    }
  }
});
