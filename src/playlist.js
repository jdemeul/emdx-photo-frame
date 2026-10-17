// Timing for UPDATE_MODE=playlist: one push carries the photos for the coming days as the
// display's own playlist, and the display changes the photo by itself at every SCHEDULE time.
//
// Measured on an EM32DX (17 Oct 2026, playlist test): a pushed playlist starts at its first
// item straight away, and each item stays up for its own `duration` (ms), counted from the
// push, not from midnight or 1970. So "change at SCHEDULE" means: item 1 = the photo for now,
// until the next change; then one item per change, as long as the gap to the change after it
// (23 or 25 hours across a daylight-saving switch). After the last item the display starts
// over at item 1, which would come back with item 1's short first duration and push every
// later change off schedule. A tail item (item 1's photo again) fills the gap, so a repeat
// runs from one change time to the next too, should the NAS not reach the display in time.
import { Cron } from 'croner';

// The change times of a cron pattern (croner counts in whole seconds).
export function changeClock(pattern, timezone) {
  const cron = new Cron(pattern, { timezone, paused: true });
  return {
    // The first change after t.
    next: (t) => cron.nextRuns(1, new Date(t))[0]?.getTime() ?? null,
    // The last change at or before t. (croner can answer with a time after t when t falls just
    // after a change that daylight saving moved, e.g. 02:30 on the spring-forward night; the
    // fallback counts forward from two days back instead.)
    prev(t) {
      const past = (runs) => runs.map((d) => d.getTime()).filter((x) => x <= t);
      let cands = past(cron.previousRuns(3, new Date(t + 1000)));
      if (!cands.length) cands = past(cron.nextRuns(200, new Date(t - 2 * 86400000)));
      return cands.length ? Math.max(...cands) : null;
    },
    // The first n changes after t.
    upcoming: (n, t) => cron.nextRuns(n, new Date(t)).map((d) => d.getTime()),
  };
}

const formats = new Map();
function format(locale, timezone, opts) {
  const id = `${locale}|${timezone}|${JSON.stringify(opts)}`;
  if (!formats.has(id)) formats.set(id, new Intl.DateTimeFormat(locale, { timeZone: timezone, hour12: false, ...opts }));
  return formats.get(id);
}

// A change time as 'YYYY-MM-DD HH:MM' in the frame's time zone (':SS' added when not on the
// minute): names the photo for that slot.
export function slotKey(t, timezone) {
  const sec = new Date(t).getUTCSeconds();
  const base = format('sv-SE', timezone, { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(t));
  return sec ? `${base}:${String(sec).padStart(2, '0')}` : base;
}

// 'Sat 18 Oct' (and the time, when `withTime`), for the log and the page.
export function dayLabel(t, timezone, withTime = false) {
  const opts = { weekday: 'short', day: 'numeric', month: 'short', ...(withTime ? { hour: '2-digit', minute: '2-digit' } : {}) };
  return format('en-GB', timezone, opts).format(new Date(t)).replace(',', '');
}

// What to send at `now`. `slots`: [{ key, at, ... }], one per change (a slot runs from its
// change `at` to the next change), sorted. Uses the run of consecutive slots from the one
// showing now. If the next change is less than `minFirstMs` away, the list starts with the
// next slot's photo instead (a little early) rather than show now's photo for a few minutes.
// Returns null without a slot for now; otherwise
//   { items: [{ ...slot, from, to, durationMs }], tail: { ...items[0], durationMs } | null,
//     endsAt, builtAt: now }
export function buildBatch({ now, slots, clock, minFirstMs = 10 * 60000, minTailMs = 5 * 60000 }) {
  const i = slots.findIndex((s) => s.at <= now && clock.next(s.at) > now);
  if (i < 0) return null;
  const run = [slots[i]];
  for (let j = i + 1; j < slots.length && slots[j].at === clock.next(run.at(-1).at); j++) run.push(slots[j]);
  const start = run.length > 1 && clock.next(run[0].at) - now < minFirstMs ? 1 : 0;
  const items = run.slice(start).map((s, k) => {
    const from = k === 0 ? now : s.at;
    const to = clock.next(s.at);
    return { ...s, from, to, durationMs: to - from };
  });
  const endsAt = items.at(-1).to;
  // Repeating, item 1 runs for its first duration again: start it that long before a change.
  const first = items[0].durationMs;
  const change = clock.next(endsAt + first - 1); // the first change at or after endsAt + first
  const tailMs = change - endsAt - first;
  const tail = tailMs >= minTailMs ? { ...items[0], from: endsAt, to: endsAt + tailMs, durationMs: tailMs } : null;
  return { items, tail, endsAt, builtAt: now };
}

// Where the display is in a batch at time t, counted from batch.builtAt, repeating after the
// last item (and the tail). Returns { index (in items; the tail repeats item 1's photo, index
// -1), item, loop, since, until }.
export function positionAt(batch, t) {
  const seq = [...batch.items, ...(batch.tail ? [{ ...batch.tail, tail: true }] : [])];
  const cycle = seq.reduce((a, s) => a + s.durationMs, 0);
  let x = Math.max(0, t - batch.builtAt);
  const loop = cycle > 0 ? Math.floor(x / cycle) : 0;
  x -= loop * cycle;
  let index = 0;
  while (index < seq.length - 1 && x >= seq[index].durationMs) x -= seq[index++].durationMs;
  const item = seq[index];
  return { index: item.tail ? -1 : index, item, loop, since: t - x, until: t - x + item.durationMs };
}
