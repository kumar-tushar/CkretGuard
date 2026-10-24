import test from 'node:test';
import assert from 'node:assert/strict';
import '../src/core.js';
import '../src/policy.js';

test('managed fields override local settings and expose locks', async () => {
  globalThis.chrome = {storage:{local:{get:async()=>({policy:{mode:'redact',protectClientIds:false,sensitiveNames:['dataset1']}})},
    managed:{get:async()=>({mode:'block',protectClientIds:true,sensitiveNames:['org_dataset']})}}};
  const result = await SecretShieldPolicy.loadPolicy();
  assert.equal(result.policy.mode, 'block');
  assert.equal(result.policy.protectClientIds, true);
  assert.deepEqual(result.policy.sensitiveNames, ['org_dataset']);
  assert.deepEqual(result.locked, ['mode','protectClientIds','sensitiveNames']);
});
test('missing preferences use safe defaults; unreadable and malformed policy rejects', async () => {
  globalThis.chrome = {storage:{local:{get:async()=>({})},managed:{get:async()=>({})}}};
  assert.equal((await SecretShieldPolicy.loadPolicy()).policy.mode, 'redact');
  chrome.storage.managed.get = async () => { throw new Error('policy error'); };
  await assert.rejects(SecretShieldPolicy.loadPolicy());
  chrome.storage.managed.get = async () => ({mode:'disabled'});
  await assert.rejects(SecretShieldPolicy.loadPolicy());
  chrome.storage.managed.get = async () => ({});
  chrome.storage.local.get = async () => ({policy:'malformed'});
  await assert.rejects(SecretShieldPolicy.loadPolicy());
});
