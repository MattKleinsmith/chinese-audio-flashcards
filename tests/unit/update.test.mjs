import { test } from 'node:test';
import assert from 'node:assert/strict';
import { versionChanged, safeToAutoReload } from '../../site/js/update.js';

test('versionChanged', () => {
  assert.equal(versionChanged('"a"', '"b"'), true);
  assert.equal(versionChanged('"a"', '"a"'), false);
  assert.equal(versionChanged('', '"a"'), false, 'unknown previous never triggers');
  assert.equal(versionChanged('"a"', ''), false, 'missing header never triggers');
});

test('safeToAutoReload', () => {
  assert.equal(safeToAutoReload('#/'), true);
  assert.equal(safeToAutoReload(''), true);
  assert.equal(safeToAutoReload('#/settings'), true);
  assert.equal(safeToAutoReload('#/study/sentences'), false);
});
