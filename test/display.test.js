import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatClock, formatTimer } from '../src/display.js';

test('the MDC clock and timer answers are shown in 24-hour time', () => {
  // 16 Oct 2026, 1:05 PM
  assert.equal(formatClock([16, 1, 5, 10, 0x07, 0xea, 0x00]), '2026-10-16 13:05');
  // 12 AM is midnight, 12 PM noon
  assert.equal(formatClock([1, 12, 0, 1, 0x07, 0xea, 0x01]), '2026-01-01 00:00');
  assert.equal(formatClock([1, 12, 30, 1, 0x07, 0xea, 0x00]), '2026-01-01 12:30');
  assert.equal(formatClock([1, 0xff, 0xff, 1, 0x07, 0xea, 0x01]), 'not set');
  assert.match(formatClock([0x00]), /^unexpected answer \[00\]$/);
  // Timer 1 (13-byte form): on at 5:55 AM every day, no off time.
  assert.equal(
    formatTimer([5, 55, 1, 1, 0xff, 0xff, 1, 0, 1, 0, 10, 0x62, 0]),
    'on at 05:55 every day, no off time [05 37 01 01 ff ff 01 00 01 00 0a 62 00]',
  );
  // Not set at all.
  assert.match(formatTimer([0xff, 0xff, 1, 0, 0xff, 0xff, 1, 0, 0, 0, 0, 0, 0]), /^no on time, no off time \[/);
  assert.match(formatTimer([1, 2, 3]), /^unexpected answer/);
});
