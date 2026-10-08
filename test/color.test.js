import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPaletteModel, makeGamutMapper, makeDecomposer, linearToOklab, SRGB8_TO_LINEAR } from '../src/color.js';
import { DEFAULT_MEASURED_PALETTE, DEVICE_PALETTE, INK_NAMES } from '../src/config.js';
import { dither } from '../src/dither.js';

const model = buildPaletteModel(DEFAULT_MEASURED_PALETTE, DEVICE_PALETTE);

test('ink hull is a closed solid around the grey axis', () => {
  assert.equal(model.faces.length, 8);
  const mid = [0, 1, 2].map((c) => (model.B[c] + model.W[c]) / 2);
  for (const f of model.faces) assert.ok(f.d - (f.n[0] * mid[0] + f.n[1] * mid[1] + f.n[2] * mid[2]) > 0);
});

test('gamut mapping lands inside the hull and decomposition reconstructs it exactly', () => {
  const gm = makeGamutMapper(model);
  const dec = makeDecomposer(model);
  const t = [0, 0, 0];
  const w = new Float64Array(6);
  let seed = 1;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 20000; i++) {
    gm(rnd(), rnd(), rnd(), t);
    for (const f of model.faces) assert.ok(f.n[0] * t[0] + f.n[1] * t[1] + f.n[2] * t[2] <= f.d + 1e-9);
    dec(t[0], t[1], t[2], w);
    const rec = [0, 0, 0];
    let sum = 0;
    for (let k = 0; k < 6; k++) {
      assert.ok(w[k] >= 0);
      sum += w[k];
      for (let c = 0; c < 3; c++) rec[c] += w[k] * model.inks[k].lin[c];
    }
    assert.ok(Math.abs(sum - 1) < 1e-9);
    assert.ok(Math.hypot(rec[0] - t[0], rec[1] - t[1], rec[2] - t[2]) < 1e-9);
  }
});

test('neutral greys use only black and white', () => {
  const gm = makeGamutMapper(model);
  const dec = makeDecomposer(model);
  const t = [0, 0, 0];
  const w = new Float64Array(6);
  for (const g of [0.1, 0.3, 0.5, 0.8]) {
    gm(g, g, g, t);
    dec(t[0], t[1], t[2], w);
    for (let k = 0; k < 6; k++) {
      if (INK_NAMES[k] !== 'black' && INK_NAMES[k] !== 'white') assert.ok(w[k] < 1e-9, `${INK_NAMES[k]} used for grey`);
    }
  }
});

for (const method of ['bluenoise', 'diffusion']) {
  test(`${method}: flat patches average to the intended colour`, () => {
    const gm = makeGamutMapper(model);
    for (const c of [[128, 128, 128], [200, 60, 50], [60, 120, 200], [230, 200, 150], [250, 240, 90]]) {
      const W = 96, H = 96;
      const buf = Buffer.alloc(W * H * 3);
      for (let i = 0; i < W * H; i++) buf.set(c, i * 3);
      const idx = dither(buf, W, H, model, { method });
      const mean = [0, 0, 0];
      for (let i = 0; i < idx.length; i++) for (let k = 0; k < 3; k++) mean[k] += model.inks[idx[i]].lin[k] / idx.length;
      const t = gm(SRGB8_TO_LINEAR[c[0]], SRGB8_TO_LINEAR[c[1]], SRGB8_TO_LINEAR[c[2]], [0, 0, 0]);
      const a = linearToOklab(...mean), b = linearToOklab(...t);
      const dE = Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
      assert.ok(dE < 0.01, `colour ${c}: ΔE_ok ${dE.toFixed(4)}`);
    }
  });
}
