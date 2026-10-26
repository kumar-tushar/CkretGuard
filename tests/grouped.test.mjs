import test from 'node:test';
import assert from 'node:assert/strict';
import { redact, scan, ScanError } from '../src/index.mjs';

const MASK = 'xxxxxxxxxx', first = 'Q7mV8z2R9tA4nP6xL3cD', second = 'B9wK4s8H2yF7vN5rT6aZ';
test('authentication prose and generic key instructions are not credentials', () => {
  for (const input of ['Explain the basic authentication flow.', 'Explain bearer authentication.',
    'The key is to retry with exponential backoff.', 'The secret is to keep trying.',
    'Basic authentication is an HTTP scheme.', 'Bearer authentication uses an access token.',
    'Our key is to test carefully.', 'The key is that retries need a delay.',
    'The API key is below.', 'The client secret is at the bottom.', 'The API key is available here.']) {
    assert.equal(redact(input).text, input, input); assert.equal(scan(input).length, 0, input);
  }
});
test('explicit and standalone authentication credentials retain detection', () => {
  for (const input of ['Authorization: Bearer abcdef', 'Authorization: Basic dXNlcjpwYXNz',
    'Bearer synthetic-token-123', 'Basic dXNlcjpwYXNz', 'Use Bearer synthetic-token-123 for this request.',
    'key is tgdd444', 'key: to', 'key = to', 'key is "to"', 'client secret is tgdd444']) assert.ok(redact(input).count > 0, input);
  assert.throws(() => redact('Authorization: Bearer\napi_key=synthetic-other-123'), ScanError);
});
test('keyword mentions activate a whole-prompt check independently of direct assignments', () => {
  for (const input of [`My API key and client secret are at the bottom.\nPlease explain the connection.\n${first}\n${second}`,
    `${first}\nSome explanation in the middle.\n${second}\nThese are the API keys.`,
    `client secret\n${first}\n\nSome text.\n${second}`, `api_key: short-value\nThe other value is far below.\n${first}`]) {
    const output = redact(input);
    assert.equal(output.text, input.replace(first, MASK).replace(second, MASK).replace('short-value', MASK));
    assert.equal(redact(output.text).count, 0);
    assert.equal(output.findings.some(finding => finding.type === 'context-secret'), true);
  }
  for (const input of [first, `No credential names here.\n${first}\n${second}`, `api-tokenizer\n${first}`,
    `myClientId\n${first}`, `clientidentity\n${first}`]) assert.equal(redact(input).count, 0, input);
});
test('keyword spelling variants, plurals, generic fields and custom literals follow the existing field policy', () => {
  for (const field of ['api_key', 'api_token', 'client_secret', 'access_token', 'auth_token', 'refresh_token',
    'password', 'passwd', 'pwd', 'private_key', 'secret_key', 'aws_access_key_id', 'aws_secret_access_key', 'authorization', 'client_id']) {
    for (const join of ['', ' ', '_', '-', '\t', '_- ']) {
      const keyword = field.split('_').join(join).toUpperCase();
      assert.equal(redact(`${keyword} is mentioned here.\n\n${first}`).text, `${keyword} is mentioned here.\n\n${MASK}`, keyword);
    }
  }
  for (const keyword of ['API keys', 'apiTokens', 'client secrets', 'access_tokens', 'keys', 'secret', 'token']) {
    assert.equal(redact(`${keyword}\n${first}`).text, `${keyword}\n${MASK}`, keyword);
  }
  const custom = `project_code is mentioned in this prompt.\n\n${first}`;
  assert.equal(redact(custom).count, 0);
  assert.equal(redact(custom, { sensitiveNames: ['project_code'] }).text, custom.replace(first, MASK));
  for (const alias of ['projectCode', 'project-code', 'project code', 'project_codes']) {
    assert.equal(redact(`${alias}\n${first}`, { sensitiveNames: ['project_code'] }).count, 0, alias);
  }
});
test('client-ID opt-out and clearly identified non-secret values do not trigger the context check', () => {
  assert.equal(redact(`client id\n${first}`, { protectClientIds: false }).count, 0);
  const input = `Client secret will be shown below.\nclient_id: ${first}\n\n${second}`;
  assert.equal(redact(input, { protectClientIds: false }).text, input.replace(second, MASK));
  for (const newline of ['\n', '\r\n']) {
    const input = `API key is below.${newline}client_id:${newline}${first}${newline}${second}`;
    assert.equal(redact(input, { protectClientIds: false }).text, input.replace(second, MASK));
  }
  for (const field of ['request_id', 'traceId', 'correlation id', 'transaction-id', 'checksum', 'sha256', 'commit hash', 'uuid']) {
    const input = `Explain how an API key works.\n${field}: ${first}`;
    assert.equal(redact(input).text, input, field);
  }
  assert.equal(redact(`request_id\n${first}`, { sensitiveNames: ['request_id'] }).text, `request_id\n${MASK}`);
  assert.equal(redact(`API key is below.\nsession_id: ${first}`).text, `API key is below.\nsession_id: ${MASK}`);
  const overridden = ['request_id', 'trace_id', 'correlation_id', 'transaction_id', 'commit_hash',
    'checksum', 'sha256', 'sha512', 'md5', 'hash', 'uuid'];
  assert.equal(redact(`API key is below.\n${first}`, { sensitiveNames: overridden }).text, `API key is below.\n${MASK}`);
});
test('unknown credentials use several signals and ordinary identifiers, paths, placeholders and prose stay intact', () => {
  const suspicious = [first, second, 'a4j8c2p6v9b3z7q1', '2a1c5f0397b84e6d8317c96fe0640deca911e4fa1f08e52b90d7b3a421c860fd',
    'mVqLrXbWpNtCzHsDfJkY', 'M7vNpQ2+Ls9Xr5/Ba8Ty=='];
  for (const value of suspicious) {
    assert.equal(redact(`API key at the bottom.\n${value}`).text, `API key at the bottom.\n${MASK}`, value);
  }
  for (const value of ['authentication', 'configuration', 'getCustomerAccessToken', 'CUSTOMER_AUTHENTICATION_ACCESS_TOKEN',
    'request1234567890', 'synthetic-public-id-123', 'this_is_a_readable_identifier_123', 'ip_address_example_123', '2026-10-25', '12345678901234567890', 'xxxxxxxxxx', 'x'.repeat(50),
    '${SERVICE_KEY}', '$SERVICE_KEY', '<API_KEY>', '[REDACTED]', 'https://example.invalid/' + first, '/src/' + first + '/file.js',
    'someone@example.invalid', 'long-readable-password-123', 'a'.repeat(1024)]) {
    const input = `Explain API keys.\n${value}`;
    assert.equal(redact(input).text, input, value);
  }
});
test('positional grouping is removed: short prose is not inferred from a list, and incomplete lists review actual candidates', () => {
  for (const input of ['client id and client secret are\nFdenirddvj\nGhllgdfjkg',
    'api_key and password are\nordinary\nwords', 'client id and client secret are\nrequired for authentication.']) assert.equal(redact(input).text, input);
  const input = `client id and client secret are\n${first}`;
  assert.equal(redact(input).text, input.replace(first, MASK));
  assert.equal(redact(`API key and secret key are\n${first}\nSome explanation.\n${second}`).count, 2);
});
test('context detection preserves exact ranges, punctuation, duplicates, explicit formats, and idempotence', () => {
  for (const input of [`API keys:\r\n- **${first}**\r\n- \x60${second}\x60`, `API key at the bottom: "${first}".`,
    `API key\nother_field=${first}\nRepeat ${first}.`, `API key\n${first}=${second}`]) {
    const result = redact(input);
    for (const finding of result.findings) assert.ok(input.slice(finding.start, finding.end).length > 0);
    assert.equal(result.text.includes(first), false, input);
    assert.equal(result.text.includes(second), false, input);
    assert.equal(redact(result.text).count, 0, input);
    assert.equal(JSON.stringify(result.findings).includes(first), false);
  }
  const labeled = `api_key=${first}\n${second}`;
  assert.equal(redact(labeled).count, 2);
  for (const field of ['api key', 'client secret']) for (const separator of [': ', ' = ', ' is ']) {
    assert.equal(redact(`${field}${separator}tgdd444`).text, `${field}${separator}${MASK}`);
  }
});
test('all 50 custom fields can trigger the shared context pass without ordered-value parsing', () => {
  const names = Array.from({ length: 50 }, (_, i) => `dataset_${i}`);
  const values = names.map((_, i) => `${first}${i}rT6aZ`);
  const original = names.join(', ') + ' are spread through this draft.\n' + values.join('\nSome explanation.\n');
  const result = redact(original, { sensitiveNames: names });
  assert.equal(result.count, 50);
  assert.equal(result.text, names.join(', ') + ' are spread through this draft.\n' + values.map(() => MASK).join('\nSome explanation.\n'));
});
test('distant matching scans the complete browser-sized draft and generic mentions require stronger evidence', () => {
  const short = 'Q7vM2nX9pL4t';
  assert.equal(redact(`API key at the bottom.\n${short}`).text, `API key at the bottom.\n${MASK}`);
  assert.equal(redact(`The key appears below.\n${short}`).text, `The key appears below.\n${short}`);
  const original = first + '\n' + 'Ordinary explanation. '.repeat(6000) + `\nAPI keys are at the top and bottom.\n${second}`;
  assert.throws(() => scan(original), ScanError);
  assert.equal(redact(original, undefined, original.length).text, original.replace(first, MASK).replace(second, MASK));
});
