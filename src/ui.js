// The status page served at http://<nas>:<HTTP_PORT>/
export const UI_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Photo frame</title>
<style>
  :root { --bg:#f6f5f2; --card:#fff; --ink:#1d1f22; --muted:#6b6f76; --line:#e3e1dc; --accent:#2f5d50; --on-accent:#fff; --warn:#a33a2c; }
  @media (prefers-color-scheme: dark) { :root { --bg:#16181b; --card:#1f2226; --ink:#e9e7e2; --muted:#9aa0a6; --line:#2e3238; --accent:#7fb8a4; --on-accent:#0f1c18; --warn:#e07a6a; } }
  * { box-sizing: border-box; }
  body { margin:0; font:15px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background:var(--bg); color:var(--ink); }
  main { max-width:1100px; margin:0 auto; padding:24px 16px 48px; display:grid; gap:20px; grid-template-columns:minmax(0,1fr) minmax(0,1fr); }
  header { grid-column:1/-1; display:flex; align-items:baseline; gap:12px; flex-wrap:wrap; }
  h1 { font-size:22px; margin:0; font-weight:650; }
  .chip { font-size:13px; padding:2px 10px; border-radius:99px; border:1px solid var(--line); color:var(--muted); }
  .chip.busy { color:var(--accent); border-color:var(--accent); }
  .frame { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:14px; }
  .frame img { width:100%; height:auto; display:block; border-radius:4px; background:#ccc; }
  .tabs { display:flex; gap:6px; margin-bottom:10px; flex-wrap:wrap; }
  .tabs button, .actions button { font:inherit; border:1px solid var(--line); background:var(--card); color:var(--ink); border-radius:8px; padding:6px 12px; cursor:pointer; }
  .tabs button.on { border-color:var(--accent); color:var(--accent); }
  .actions { display:flex; gap:8px; flex-wrap:wrap; }
  .actions button.primary { background:var(--accent); border-color:var(--accent); color:var(--on-accent); font-weight:600; }
  .actions button:disabled { opacity:.5; cursor:default; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:16px; display:grid; gap:14px; align-content:start; align-self:start; }
  dl { margin:0; display:grid; grid-template-columns:auto 1fr; gap:6px 14px; }
  dt { color:var(--muted); } dd { margin:0; overflow-wrap:anywhere; }
  .err { color:var(--warn); }
  .muted { color:var(--muted); font-size:13px; }
  #sources { display:grid; gap:8px; grid-template-columns:1fr 1fr; }
  #sources img { width:100%; border-radius:4px; }
  .slots { display:grid; gap:10px; grid-template-columns:repeat(auto-fill, minmax(76px, 1fr)); }
  .slots figure { margin:0; }
  .slots img { width:100%; display:block; border-radius:4px; background:#ccc; }
  .slots figure.now img { outline:3px solid var(--accent); outline-offset:2px; }
  .slots figcaption { font-size:12px; color:var(--muted); margin-top:5px; }
  .slots figure.now figcaption { color:var(--accent); font-weight:600; }
  a { color:var(--accent); }
  @media (max-width:760px) { main { grid-template-columns:1fr; } }
</style>
</head>
<body>
<main>
  <header><h1>Photo frame</h1><span id="state" class="chip">…</span></header>
  <section class="frame">
    <div class="tabs">
      <button data-view="preview" class="on">Preview</button>
      <button data-view="sources">Original photos</button>
      <button data-view="playlist" hidden>Playlist</button>
      <button data-view="test">Test pattern</button>
    </div>
    <div id="view"></div>
    <p class="muted" id="viewnote"></p>
  </section>
  <section class="card">
    <div class="actions">
      <button class="primary" data-act="next">Next photo now</button>
      <button data-act="resend">Send again</button>
      <button data-act="test-pattern">Show test pattern</button>
      <button data-act="refresh-album">Re-read album</button>
      <button data-act="display-info" title="Wakes the display and reads its battery and Network Standby">Check display</button>
      <button data-act="playlist-test" title="Sends numbered cards as a playlist and watches how the display plays them (about 1.5 h)">Playlist test</button>
    </div>
    <dl id="info"></dl>
    <div id="error" class="err"></div>
    <div><strong>Recent</strong><dl id="history" style="margin-top:8px"></dl></div>
  </section>
</main>
<script>
let view = 'preview', last = null;
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c]));
const fmt = (t) => t ? new Date(t).toLocaleString([], { dateStyle:'medium', timeStyle:'short' }) : '–';
const day = (t) => t ? new Date(t).toLocaleDateString([], { dateStyle:'long' }) : 'unknown date';
function renderView(s) {
  const v = Date.now();
  let html = '', note = '';
  if (view === 'preview') {
    if (s.current) { html = '<a href="/img/current/preview.png?' + v + '" target="_blank"><img src="/img/current/preview.jpg?' + s.current.renderedAt + '" alt="preview"></a>';
      note = s.dither === 'device'
        ? 'The photo as sent. The display dithers it itself, so on the panel the colours look softer. Click for full size.'
        : 'Simulated with the measured ink colours as your eye sees them, from a distance. Click for the full-size dither.'; }
    else html = '<p class="muted">Nothing rendered yet. Press “Next photo now”.</p>';
  } else if (view === 'sources') {
    if (s.current) html = '<div id="sources">' + s.current.items.map((it, i) => '<img src="/img/current/source-' + (i+1) + '.jpg?' + s.current.renderedAt + '" alt="">').join('') + '</div>';
  } else if (view === 'playlist') {
    const pl = s.playlist;
    if (!pl) html = '<p class="muted">Off. With UPDATE_MODE=playlist the NAS sends the photos for the coming days at once, and the display changes them itself.</p>';
    else if (!pl.slots.length) html = '<p class="muted">Preparing the photos…</p>';
    else {
      html = '<div class="slots">' + pl.slots.map((x) => '<figure class="' + (x.now ? 'now' : '') + '"><a href="/img/playlist/' + x.dir + '/preview.png" target="_blank">'
        + '<img loading="lazy" src="/img/playlist/' + x.dir + '/thumb.jpg" data-fallback="/img/playlist/' + x.dir + '/preview.jpg" onerror="this.onerror=null;this.src=this.dataset.fallback" alt=""></a><figcaption>' + esc(x.label) + (x.now ? ' · now' : '')
        + (x.sent ? '' : ' · not sent yet') + '</figcaption></figure>').join('') + '</div>';
      note = 'One photo per change, from the one for now. The display changes to the next one by itself; the outlined one should be on the frame now. Click for full size.';
    }
  } else {
    html = s.testPattern ? '<img src="/img/testpattern/preview.png?' + s.testPattern.at + '" alt="test pattern">' : '<p class="muted">Press “Show test pattern” to send one.</p>';
    note = 'Use it once to check orientation (TOP at the top), colours and whether the display re-processes the image.';
  }
  $('#view').innerHTML = html; $('#viewnote').textContent = note;
}
function sleepHtml(s) {
  const z = s.sleep;
  const hm = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (!z) return '–';
  if (z.mode === 'off') return 'sleeps by its own settings (SLEEP_MODE=off)';
  if (z.asleep) {
    const how = z.self ? ' (went to sleep by itself)' : z.confirmedAfter != null ? ' (confirmed)' : '';
    const wake = s.playlist ? ', changes the photo by itself' : z.mode === 'deep' ? ', wakes itself at its screen protection time' : ', the next update wakes it';
    return esc((z.mode === 'deep' ? 'in deep sleep' : 'asleep') + (z.sleptAt ? ' since ' + fmt(z.sleptAt) : '') + how + wake);
  }
  if (z.error) return '<span class="err">' + esc(z.error) + '</span>';
  if (z.pending && z.sleepAt) return esc('awake, goes to sleep at ' + hm(z.sleepAt));
  return 'awake';
}
function watchHtml(c) {
  if (!c) return '–';
  let h = esc('every ' + c.everyMin + ' min');
  if (c.last) h += ' · last ' + esc(fmt(c.last.at)) + ': ' + (c.last.awake ? '<span class="err">awake</span>' : 'asleep');
  const ev = c.wakeEvents || [];
  if (ev.length) {
    h += '<br><span class="err">Found awake:</span> ' + ev.slice(0, 5).map((e) => esc(fmt(e.at)
      + (e.battery != null ? ' (' + e.battery + '%' + (e.charging ? ', charging' : '') + ')' : '')
      + (e.sent ? (last && last.playlist ? ', sent the playlist' : ', sent the waiting photo') : e.putBack ? '' : e.afterChange ? ', after a change' : ', not put back to sleep'))).join('; ');
  }
  return h;
}
function checkText(c) {
  if (!c) return '–';
  return esc(fmt(c.at) + ' · Network Standby ' + c.networkStandby + ' · ' + c.name + ', firmware ' + c.software
    + (c.clock ? ' · clock ' + c.clock : '') + (c.onTimer ? ' · timer 1: ' + c.onTimer : '')
    + (c.sleepAfter ? ' · Sleep After ' + c.sleepAfter : '') + (c.applySleep ? ' · sleep after content update ' + c.applySleep : '')
    + (c.lowPowerWifi ? ' · low-power Wi-Fi module ' + c.lowPowerWifi : '') + (c.restored ? ' · ' + c.restored : ''));
}
function playlistHtml(pl) {
  let h = pl.batch
    ? esc(pl.batch.photos + ' photos sent ' + fmt(pl.batch.sentAt) + ', until ' + fmt(pl.batch.endsAt) + ' (' + pl.daysLeft + ' to come; a fresh one when fewer than ' + pl.topUpDays + ' are left)')
      + (pl.batch.ranOut ? ' · <span class="err">used up: the display repeats it until it gets a fresh one</span>' : '')
    : '<span class="err">not on the display yet</span>';
  if (pl.due) h += '<br><span class="muted">' + esc('Fresh playlist due (' + pl.due + '). The NAS sends it when it finds the display awake'
    + (last && last.check ? ' (it looks every ' + last.check.everyMin + ' min)' : '') + ', or press “Send playlist” after pressing the display’s power button.') + '</span>';
  return h;
}
function slotName(pl, key) {
  const x = pl.slots.find((y) => y.key === key);
  return x ? x.label : key;
}
function changesHtml(pl) {
  const c = pl.changes && pl.changes[0];
  if (!c) return '–';
  const hm = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (c.online) return esc(fmt(c.at) + ': the display came online ' + Math.round((c.online - c.at) / 1000) + ' s after the change');
  if (c.until > Date.now()) return esc(fmt(c.at) + ': looking for the display until ' + hm(c.until) + '…');
  return esc(fmt(c.at) + ': the display did not come online (looked until ' + hm(c.until) + ')');
}
function seenHtml(pl) {
  const seen = (pl.seen || []).slice(0, 3);
  if (!seen.length) return '–';
  return seen.map((e) => esc(fmt(e.at) + ' (' + e.how + '): ') + (e.seen
    ? esc((e.sure ? '' : 'probably ') + slotName(pl, e.seen) + '’s photo') + (e.seen === e.expected ? ', as expected' : e.ok ? ', the one before (the change comes a little late)' : ' <span class="err">' + esc('(expected ' + slotName(pl, e.expected) + '’s)') + '</span>')
    : '<span class="muted">' + esc(e.note || '?') + '</span>')).join('<br>');
}
function testHtml(t) {
  if (!t) return '–';
  const hm = (x) => new Date(x).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const seen = (t.observations || []).slice(-6).map((o) => esc(hm(o.at) + ' ' + (o.card ? 'card ' + o.card : o.error ? '?' : 'no card'))
    + (o.file ? ' (<a href="/img/playlist-test/' + encodeURIComponent(o.file) + '" target="_blank">view</a>)' : '')).join(', ');
  if (!t.done) {
    return esc(t.t0 ? 'running: cards on the display since ' + hm(t.t0) + ', watching until ' + hm(t.endsAt) : 'starting…')
      + (seen ? '<br>' + seen : '') + ' <button id="stoptest" type="button">Stop test</button>';
  }
  if (t.error) return '<span class="err">' + esc(fmt(t.startedAt) + ': ' + t.error) + '</span>';
  const sw = t.result && t.result.transitions && t.result.transitions.length
    ? '<br>Switches: ' + t.result.transitions.map((x) => esc(x.from + '→' + x.to + ' between ' + hm(x.after) + ' and ' + hm(x.by))).join('; ') : '';
  return esc(fmt(t.startedAt) + ': ' + (t.result ? t.result.verdict : 'no result')) + sw + (seen ? '<br><span class="muted">Last thumbnails: ' + seen + '</span>' : '');
}
function render(s) {
  last = s;
  $('#state').textContent = s.busy ? s.busy.what + '…' : 'idle';
  $('#state').className = 'chip' + (s.busy ? ' busy' : '');
  document.querySelectorAll('.actions button').forEach((b) => b.disabled = !!s.busy);
  $('[data-act="next"]').textContent = s.playlist ? 'New photo for today' : 'Next photo now';
  $('[data-act="next"]').title = s.playlist ? 'Replaces the photo for now and sends the playlist again' : '';
  $('[data-act="resend"]').textContent = s.playlist ? 'Send playlist' : 'Send again';
  $('[data-act="resend"]').title = s.playlist ? 'Sends the photos for the coming days now (the display must be awake: press its power button first)' : '';
  $('[data-view="playlist"]').hidden = !s.playlist;
  const c = s.current;
  const pl = s.playlist;
  const tpShowing = s.testPattern && s.testPattern.sent && (!c || !c.pushedAt || s.testPattern.at > c.pushedAt);
  let onFrame = tpShowing ? 'the test pattern (until the next ' + (pl ? 'playlist' : 'update') + ')'
    : c ? c.items.map((it) => day(it.takenAt)).join(' + ') + (c.dryRun ? ' <span class="muted">(dry run: EMDX_HOST not set)</span>' : c.pushed ? '' : ' <span class="err">(not on the display yet)</span>') : '–';
  if (pl && c && c.since && !tpShowing && c.pushed) onFrame += esc(' · since ' + fmt(c.since) + (c.byDisplay ? ', changed by the display (expected)' : ''));
  const rows = [
    ['On the frame', onFrame],
    ['Layout', c ? esc(c.kind) : '–'],
    ...(pl ? [
      ['Playlist', playlistHtml(pl)],
      ['Next change', fmt(pl.nextChange)],
      ['After a change', changesHtml(pl)],
      ['Seen on the display', seenHtml(pl)],
    ] : [
      ['Sent', c && c.pushedAt ? fmt(c.pushedAt) : '–'],
      ['Next update', fmt(s.nextRun)],
    ]),
    ['Battery', s.battery ? esc(s.battery.batteryPercent + '%' + (s.battery.pluggedIn ? ' (charging)' : '')) : '–'],
    ['Display', sleepHtml(s)],
    ['Sleep checks', watchHtml(s.check)],
    ['Display check', checkText(s.displayCheck)],
    ['This round', s.cycle ? esc(s.cycle.shown + ' of ' + s.cycle.total + ' photos ' + (pl ? 'shown or planned' : 'shown') + ' (round ' + s.cycle.n + ')') : '–'],
    ['Album', s.library ? esc(s.library.titles.join(', ') + ' · ' + s.library.count + ' photos · read ' ) + fmt(s.library.fetchedAt) : '–'],
  ];
  if (s.playlistTest) rows.push(['Playlist test', testHtml(s.playlistTest)]);
  if (s.thumbnail && s.thumbnail.file) rows.push(['Screen', '<a href="/img/thumbnails/' + s.thumbnail.file + '?' + s.thumbnail.at + '" target="_blank">thumbnail the display sent ' + esc(fmt(s.thumbnail.at)) + '</a>']);
  $('#info').innerHTML = rows.map(([k, v]) => '<dt>' + k + '</dt><dd>' + v + '</dd>').join('');
  const stop = $('#stoptest');
  if (stop) stop.onclick = async () => { stop.disabled = true; await fetch('/api/stop-test', { method: 'POST' }); setTimeout(refresh1, 600); };
  const dup = s.lastError && s.sleep && s.sleep.error === s.lastError.message; // already shown under Display
  $('#error').textContent = s.lastError && !dup ? 'Last problem (' + fmt(s.lastError.at) + '): ' + s.lastError.message : '';
  $('#history').innerHTML = (s.history || []).slice(0, 8).map((h) => '<dt>' + fmt(h.at) + '</dt><dd>' + (h.ok ? esc(h.kind) + (h.dates && h.dates.length ? ' · ' + h.dates.map(day).join(' + ') : '') + (h.battery != null ? ' · battery ' + h.battery + '%' : '') + (h.waited ? ' · waited ' + h.waited + ' s for the display' : '') : '<span class="err">' + esc(h.error) + '</span>') + '</dd>').join('');
  renderView(s);
}
async function refresh() {
  try { const r = await fetch('/api/status'); render(await r.json()); } catch (e) { $('#state').textContent = 'offline'; }
  setTimeout(refresh, last && last.busy ? 2500 : 15000);
}
document.querySelectorAll('.tabs button').forEach((b) => b.onclick = () => {
  view = b.dataset.view; document.querySelectorAll('.tabs button').forEach((x) => x.classList.toggle('on', x === b)); if (last) renderView(last);
});
async function refresh1() { const r = await fetch('/api/status'); render(await r.json()); }
document.querySelectorAll('.actions button').forEach((b) => b.onclick = async () => {
  if (b.dataset.act === 'playlist-test' && !confirm('Playlist test: the display shows four numbered cards as a playlist for about 1.5 hours, '
    + 'while the NAS asks it every 2 minutes which one is up. Best with the display on USB-C power. '
    + 'Your photo comes back afterwards. Start?')) return;
  b.disabled = true;
  const r = await fetch('/api/' + b.dataset.act, { method:'POST' });
  if (!r.ok) { const j = await r.json().catch(() => ({})); alert(j.error || 'Failed'); }
  if (b.dataset.act === 'test-pattern') { view = 'test'; document.querySelectorAll('.tabs button').forEach((x) => x.classList.toggle('on', x.dataset.view === 'test')); }
  setTimeout(async () => { const r2 = await fetch('/api/status'); render(await r2.json()); }, 600);
});
refresh();
</script>
</body>
</html>`;
