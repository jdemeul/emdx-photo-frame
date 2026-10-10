import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextRunAt, wakeTimeFor } from '../src/schedule.js';

const cfg = (schedule, wakeLeadMin = 2, timezone = 'Europe/Brussels') => ({ schedule, timezone, sleep: { wakeLeadMin } });

test('the display wakes WAKE_LEAD_MIN before the next update, in local time', () => {
  const from = new Date('2026-10-10T12:00:00Z'); // 14:00 in Brussels
  assert.equal(nextRunAt(cfg('0 6 * * *'), from).toISOString(), '2026-10-11T04:00:00.000Z');
  const w = wakeTimeFor(cfg('0 6 * * *'), from);
  assert.deepEqual([w.hour, w.minute, w.label], [5, 58, '05:58']);
  assert.equal(wakeTimeFor(cfg('30 7 * * *', 10), from).label, '07:20');
});

test('wake-up times wrap around midnight and follow the time zone', () => {
  const from = new Date('2026-10-10T12:00:00Z');
  assert.equal(wakeTimeFor(cfg('1 0 * * *'), from).label, '23:59');
  assert.equal(wakeTimeFor(cfg('0 6 * * *', 2, 'UTC'), from).label, '05:58');
});

test('the wake-up time stays put across the switch to winter time', () => {
  // Clocks go back on Sunday 25 October 2026 in Brussels.
  const from = new Date('2026-10-24T12:00:00Z');
  assert.equal(nextRunAt(cfg('0 6 * * *'), from).toISOString(), '2026-10-25T05:00:00.000Z');
  assert.equal(wakeTimeFor(cfg('0 6 * * *'), from).label, '05:58');
});

test('several updates a day: the timer is set for the next one', () => {
  assert.equal(wakeTimeFor(cfg('0 6,18 * * *'), new Date('2026-10-10T08:00:00Z')).label, '17:58');
  assert.equal(wakeTimeFor(cfg('0 6,18 * * *'), new Date('2026-10-10T17:00:00Z')).label, '05:58');
});
