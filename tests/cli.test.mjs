import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

test('stdin filter only emits masked text', () => {
  const run=spawnSync(process.execPath,['scripts/redact.mjs'],{input:'api_key=synthetic-1234',encoding:'utf8'});
  assert.equal(run.status,0);assert.equal(run.stdout,'api_key=xxxxx');assert.equal(run.stderr,'');
});
test('stdin filter emits nothing to stdout when input cannot be scanned', () => {
  const run=spawnSync(process.execPath,['scripts/redact.mjs'],{input:'a'.repeat(100001),encoding:'utf8'});
  assert.equal(run.status,2);assert.equal(run.stdout,'');assert.ok(!run.stderr.includes('aaaa'));
});
