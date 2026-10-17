// What the playlist test learns: which card the display showed when, compared with the
// ways it might time a playlist. The Samsung app sends a playlist as one schedule entry
// (from 1970-01-01, 00:00:00) with the images in order, each with a duration in ms; how the
// display counts those durations isn't in the app, so the test checks:
//   push      from when it received the playlist, each card for its own duration
//   midnight  from local midnight, every day afresh, each card for its own duration
//   epoch     from 1970-01-01 00:00 local time, without restarting, own durations
// and each of those with every card shown for the first card's duration ("-equal").

export const MODELS = [
  { id: 'push', text: 'counted from when it received the playlist, each card for its own duration' },
  { id: 'midnight', text: 'counted from local midnight, each card for its own duration' },
  { id: 'epoch', text: 'counted from 1970-01-01 00:00 local time (no daily restart), each card for its own duration' },
  { id: 'push-equal', text: 'counted from when it received the playlist, but every card for the first card\'s duration' },
  { id: 'midnight-equal', text: 'counted from local midnight, every card for the first card\'s duration' },
  { id: 'epoch-equal', text: 'counted from 1970-01-01 00:00 local time, every card for the first card\'s duration' },
];

// Milliseconds east of UTC for `tz` at time t.
function tzOffsetMs(t, tz) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(t)).map((p) => [p.type, p.value]));
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return asUtc - Math.floor(t / 1000) * 1000;
}

// Which card (1-based) the model predicts at time t, and how far t is from the nearest
// switch (ms), so observations right at a switch aren't held against it.
export function predict(modelId, t, { t0, durations, tz }) {
  const [anchor, variant] = modelId.split('-');
  const ds = variant === 'equal' ? durations.map(() => durations[0]) : durations;
  const cycle = ds.reduce((a, b) => a + b, 0);
  let x;
  if (anchor === 'push') x = t - t0;
  else {
    const wall = t + tzOffsetMs(t, tz); // local wall-clock ms since 1970-01-01 00:00
    x = anchor === 'midnight' ? wall % 86400000 : wall;
  }
  x = ((x % cycle) + cycle) % cycle;
  for (let i = 0; i < ds.length; i++) {
    if (x < ds[i]) {
      const prev = i === 0 ? ds.length : i;
      return { card: i + 1, prevCard: prev, nextCard: i + 2 > ds.length ? 1 : i + 2, sinceSwitch: x, toSwitch: ds[i] - x };
    }
    x -= ds[i];
  }
  return { card: 1, prevCard: ds.length, nextCard: 2, sinceSwitch: 0, toSwitch: ds[0] };
}

// observations: [{ at, card }] (card null when the thumbnail didn't show a card).
// Returns { verdict, model, scores, transitions, known }.
export function analyzePlaylistTest({ t0, durations, observations, tz, toleranceMs = 100000 }) {
  const known = observations.filter((o) => o.card);
  const transitions = [];
  for (let i = 1; i < known.length; i++) {
    if (known[i].card !== known[i - 1].card) {
      transitions.push({ from: known[i - 1].card, to: known[i].card, after: known[i - 1].at, by: known[i].at });
    }
  }
  if (known.length < 3) {
    const answered = observations.filter((o) => !o.error).length;
    return {
      verdict: answered
        ? 'Too few thumbnails showed a test card to tell how the display times the playlist. Check the saved thumbnails, or watch the panel instead.'
        : 'No thumbnails came back. The display may not support them on this firmware: watch the panel instead.',
      model: null, scores: [], transitions, known: known.length,
    };
  }
  const scores = MODELS.map((m) => {
    let hits = 0;
    for (const o of known) {
      const p = predict(m.id, o.at, { t0, durations, tz });
      if (p.card === o.card
        || (p.sinceSwitch < toleranceMs && p.prevCard === o.card)
        || (p.toSwitch < toleranceMs && p.nextCard === o.card)) hits++;
    }
    return { model: m.id, hits, score: hits / known.length };
  });
  const best = scores.reduce((a, b) => (b.score > a.score ? b : a)); // first wins a tie: the order is the preference
  const seen = [...new Set(known.map((o) => o.card))];
  const lastAt = known[known.length - 1].at;
  let verdict;
  if (seen.length === 1) {
    verdict = lastAt - t0 > durations[0] + toleranceMs
      ? `The display stayed on card ${seen[0]} the whole time: it did not move on through the playlist by itself.`
      : `Only card ${seen[0]} was seen; the test ended before the first switch was due.`;
    return { verdict, model: null, scores, transitions, known: known.length };
  }
  const tied = scores.filter((s) => s.score === best.score).map((s) => s.model);
  if (best.score >= 0.9) {
    verdict = `The display moved on by itself, ${MODELS.find((m) => m.id === best.model).text}`
      + ` (${best.hits} of ${known.length} thumbnails fit${tied.length > 1 ? `; ${tied.slice(1).join(', ')} fit as well` : ''}).`;
  } else {
    verdict = `The display moved on by itself (${transitions.length} switches seen), but none of the simple timings fits well`
      + ` (best: ${best.model}, ${best.hits} of ${known.length}). See the observations.`;
  }
  return { verdict, model: best.score >= 0.9 ? best.model : null, scores, transitions, known: known.length };
}
