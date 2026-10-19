import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatSleepAfter } from '../src/display.js';

test('the display\'s Sleep After setting is shown as the Samsung app names it', () => {
  assert.equal(formatSleepAfter([0x07]), '10 min');
  assert.equal(formatSleepAfter([0x00]), 'off');
  assert.equal(formatSleepAfter([0xf0, 0x01, 0x2c]), 'custom (300)');
  assert.equal(formatSleepAfter([0x42]), 'code 66');
  assert.equal(formatSleepAfter([]), 'unknown');
});
