import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { formatSleepAfter, networkState, lookForDisplay } from '../src/display.js';

test('the display\'s Sleep After setting is shown as the Samsung app names it', () => {
  assert.equal(formatSleepAfter([0x07]), '10 min');
  assert.equal(formatSleepAfter([0x00]), 'off');
  assert.equal(formatSleepAfter([0xf0, 0x01, 0x2c]), 'custom (300)');
  assert.equal(formatSleepAfter([0x42]), 'code 66');
  assert.equal(formatSleepAfter([]), 'unknown');
});

test('a display that doesn\'t answer is off the network when nothing answers its address, and still on it when the attempt times out or is refused', async () => {
  const err = (code, extra = {}) => Object.assign(new Error(code), { code, ...extra });
  assert.equal(networkState(err('EHOSTUNREACH')), 'off');
  assert.equal(networkState(new Error('Probe timed out after 6s')), null);
  assert.equal(networkState(Object.assign(new Error('Probe timed out after 6s'), { timedOut: true })), 'on');
  assert.equal(networkState(err('ECONNREFUSED')), 'on');
  assert.equal(networkState(new Error('Closed')), null);
  // A closed port: the address answers with a refusal, so it is on the network.
  const srv = net.createServer();
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const { port } = srv.address();
  await new Promise((r) => srv.close(r));
  assert.deepEqual(await lookForDisplay({ display: { host: '127.0.0.1', port, pin: '000000' } }), { awake: false, battery: null, network: 'on' });
});
