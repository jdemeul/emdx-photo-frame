import { test } from 'node:test';
import assert from 'node:assert/strict';
import { syncBag, planNext, markShown } from '../src/selector.js';
import { pairCells } from '../src/render.js';

const portraitCfg = {
  panel: { width: 1440, height: 2560 },
  layout: { odd: 'pair', oddThreshold: 0.35, gap: 20, margin: 48 },
};

function lib(n, { w = 4000, h = 3000 } = {}) {
  return Array.from({ length: n }, (_, i) => ({ id: `id${i}`, width: w, height: h, takenAt: i * 1000 }));
}

test('every photo is shown once per cycle, then a new cycle starts', () => {
  const state = { history: [] };
  const ids = ['a', 'b', 'c', 'd', 'e'];
  const seen = [];
  for (let i = 0; i < 5; i++) {
    syncBag(state, ids);
    const id = state.bag[0];
    seen.push(id);
    markShown(state, [id]);
  }
  assert.deepEqual([...seen].sort(), ids);
  assert.equal(state.cycle, 1);
  syncBag(state, ids);
  assert.equal(state.cycle, 2);
  assert.equal(state.bag.length, 5);
});

test('a new cycle opens with photos that are not already planned', () => {
  const ids = Array.from({ length: 10 }, (_, i) => `p${i}`);
  for (let run = 0; run < 20; run++) {
    const state = { history: [] };
    syncBag(state, ids);
    for (const id of [...state.bag]) markShown(state, [id]); // the whole round planned
    const planned = state.shownThisCycle.slice(-4); // the last four still to come
    syncBag(state, ids, Math.random, Date.now(), planned);
    assert.equal(state.cycle, 2);
    assert.deepEqual([...state.bag.slice(-4)].sort(), [...planned].sort());
  }
});

test('new photos join the current cycle; deleted ones disappear', () => {
  const state = { history: [] };
  syncBag(state, ['a', 'b', 'c']);
  markShown(state, [state.bag[0]]);
  syncBag(state, ['a', 'b', 'c', 'd']);
  assert.ok(state.bag.includes('d'));
  assert.equal(state.bag.length + state.shownThisCycle.length, 4);
  syncBag(state, ['a', 'd']);
  assert.ok(!state.bag.includes('b') && !state.bag.includes('c'));
});

test('excluded items (videos) never enter the bag', () => {
  const state = { history: [], excluded: { b: { reason: 'video', until: null } } };
  syncBag(state, ['a', 'b', 'c']);
  assert.ok(!state.bag.includes('b'));
});

test('portrait frame: portrait photos fill the frame alone', () => {
  const items = lib(3, { w: 3000, h: 4000 });
  const state = { history: [] };
  syncBag(state, items.map((i) => i.id));
  const plan = planNext(portraitCfg, state, new Map(items.map((i) => [i.id, i])));
  assert.equal(plan.kind, 'cover');
});

test('portrait frame: landscape photos are paired, preferring ones taken close in time', () => {
  const items = [
    { id: 'L1', width: 4000, height: 3000, takenAt: 1_000_000 },
    { id: 'L2', width: 4000, height: 3000, takenAt: 9_000_000_000 },
    { id: 'L3', width: 4000, height: 3000, takenAt: 1_050_000 },
    { id: 'P1', width: 3000, height: 4000, takenAt: 1_010_000 },
  ];
  const state = { bag: ['L1', 'L2', 'P1', 'L3'], shownThisCycle: [], history: [] };
  const plan = planNext(portraitCfg, state, new Map(items.map((i) => [i.id, i])));
  assert.equal(plan.kind, 'pair');
  assert.deepEqual(plan.items.map((i) => i.id), ['L1', 'L3']);
});

test('a lone landscape photo falls back to fit (white margin)', () => {
  const items = [{ id: 'L1', width: 4000, height: 3000, takenAt: 1 }, { id: 'P1', width: 3000, height: 4000, takenAt: 2 }];
  const state = { bag: ['L1', 'P1'], shownThisCycle: [], history: [] };
  const plan = planNext(portraitCfg, state, new Map(items.map((i) => [i.id, i])));
  assert.equal(plan.kind, 'fit');
});

test('pair cells tile the frame with a gutter', () => {
  const [a, b] = pairCells(1440, 2560, 20, [4 / 3, 16 / 9]);
  assert.equal(a.w, 1440);
  assert.equal(a.h + 20 + b.h, 2560);
  assert.ok(a.h > b.h, 'the 4:3 photo gets the taller cell');
  const [c, d] = pairCells(2560, 1440, 20, [3 / 4, 3 / 4]);
  assert.equal(c.w + 20 + d.w, 2560);
});
