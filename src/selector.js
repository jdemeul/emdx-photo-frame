// Which photo(s) next: a shuffle bag (every photo once per cycle) plus the
// layout decision (single, a pair of "odd-shaped" photos, or fit-with-margin).
import { cropLoss, pairCellAspect } from './render.js';

export function shuffle(arr, rand = Math.random) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

const aspectOf = (it) => it.width / it.height;

export function isExcluded(state, id, now = Date.now()) {
  const e = state.excluded?.[id];
  if (!e) return false;
  return e.until == null || e.until > now;
}

// Bring the bag in line with the album: drop removed photos, slot new ones in at
// random positions, and start a new shuffled cycle once everything was shown. A new cycle
// doesn't open with what was just on the wall, nor with `avoid` (e.g. photos already planned
// for the coming days).
export function syncBag(state, ids, rand = Math.random, now = Date.now(), avoid = []) {
  const usable = ids.filter((id) => !isExcluded(state, id, now));
  const idSet = new Set(usable);
  state.bag = (state.bag || []).filter((id) => idSet.has(id));
  state.shownThisCycle = (state.shownThisCycle || []).filter((id) => idSet.has(id));
  const inBag = new Set(state.bag);
  const shown = new Set(state.shownThisCycle);
  for (const id of usable) {
    if (inBag.has(id) || shown.has(id)) continue;
    state.bag.splice(Math.floor(rand() * (state.bag.length + 1)), 0, id);
  }
  if (state.bag.length === 0 && usable.length) {
    const recent = new Set([...(state.history || []).filter((h) => h.ok).slice(0, 2).flatMap((h) => h.ids || []), ...avoid]);
    const fresh = shuffle(usable.slice(), rand);
    // Don't open the new cycle with what was just on the wall.
    fresh.sort((a, b) => (recent.has(a) ? 1 : 0) - (recent.has(b) ? 1 : 0));
    state.bag = fresh;
    state.shownThisCycle = [];
    state.cycle = (state.cycle || 0) + 1;
  }
  if (!state.cycle && usable.length) state.cycle = 1;
  return state;
}

export function planNext(cfg, state, itemsById, rand = Math.random) {
  const { width, height } = cfg.panel;
  const frameAspect = width / height;
  const cellAspect = pairCellAspect(width, height, cfg.layout.gap);
  const thr = cfg.layout.oddThreshold;
  const lossFull = (it) => cropLoss(aspectOf(it), frameAspect);
  const isOdd = (it) => lossFull(it) > thr;
  const pairHelps = (it) => cropLoss(aspectOf(it), cellAspect) < lossFull(it);

  const firstId = state.bag.find((id) => itemsById.has(id) && !isExcluded(state, id));
  if (!firstId) return null;
  const first = itemsById.get(firstId);
  if (!isOdd(first)) return { kind: 'cover', items: [first] };

  if (cfg.layout.odd === 'pair' && pairHelps(first)) {
    const findPartner = (ids) => {
      let best = null, bestScore = Infinity;
      for (const id of ids) {
        if (id === first.id || isExcluded(state, id)) continue;
        const it = itemsById.get(id);
        if (!it || !isOdd(it) || !pairHelps(it)) continue;
        // Prefer a photo taken around the same time (same day out, same party...).
        const score = first.takenAt != null && it.takenAt != null
          ? Math.abs(first.takenAt - it.takenAt)
          : 1e15 + rand();
        if (score < bestScore) { bestScore = score; best = it; }
      }
      return best;
    };
    // Unseen photos first; otherwise borrow one that was already shown this cycle.
    const partner = findPartner(state.bag) || findPartner([...itemsById.keys()]);
    if (partner) return { kind: 'pair', items: [first, partner] };
  }
  return { kind: cfg.layout.odd === 'crop' ? 'cover' : 'fit', items: [first] };
}

export function markShown(state, ids) {
  const set = new Set(ids);
  state.bag = (state.bag || []).filter((id) => !set.has(id));
  const shown = new Set(state.shownThisCycle || []);
  state.shownThisCycle = [...(state.shownThisCycle || []), ...ids.filter((id) => !shown.has(id))];
}
