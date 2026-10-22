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
      <button data-act="display-info" title="Wakes the display (if Wake-on-LAN reaches it) and reads its battery and settings">Check display</button>
      <button data-act="deep-sleep" hidden title="Sends the display into deep sleep the way the Samsung app does (its deep sleep mode setting again, then its Sleep button), then checks that it drops off the Wi-Fi">Deep sleep now</button>
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
const hm = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const day = (t) => t ? new Date(t).toLocaleDateString([], { dateStyle:'long' }) : 'unknown date';
function renderView(s) {
  const v = Date.now();
  let html = '', note = '';
  if (view === 'preview') {
    if (s.current) { html = '<a href="/img/current/preview.png?' + v + '" target="_blank"><img src="/img/current/preview.jpg?' + s.current.renderedAt + '" alt="preview"></a>';
      note = s.dither === 'device'
        ? 'The photo as sent. The display dithers it itself, so on the panel the colours look softer. Click for full size.'
        : 'Simulated with the measured ink colours as your eye sees them, from a distance. Click for the full-size dither.'; }
    else html = '<p class="muted">Nothing rendered yet.</p>';
  } else if (view === 'sources') {
    if (s.current) html = '<div id="sources">' + s.current.items.map((it, i) => '<img src="/img/current/source-' + (i+1) + '.jpg?' + s.current.renderedAt + '" alt="">').join('') + '</div>';
  } else if (view === 'playlist') {
    const pl = s.playlist;
    if (!pl || !pl.slots.length) html = '<p class="muted">Preparing the photos…</p>';
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
function batteryHtml(s) {
  const b = s.battery;
  if (!b) return '–';
  let h = esc(b.batteryPercent + '%' + (b.pluggedIn ? ' (charging)' : '') + ' · ' + fmt(b.at));
  const days = s.batteryDays || [];
  if (days.length > 1) h += '<br><span class="muted">' + esc('Per day: ' + days.map((d) => d.day + ' ' + d.percent + '%' + (d.charging ? ' (charging)' : '')).join(' · ')) + '</span>';
  return h;
}
function sleepHtml(s) {
  const z = s.sleep;
  if (!z) return '–';
  if (z.mode === 'off') return 'sleeps by its own settings (SLEEP_MODE=off)';
  if (z.asleep) {
    const since = z.sleptAt ? ' since ' + fmt(z.sleptAt) : '';
    // Asleep, yet still on the Wi-Fi in deep sleep mode (or off it in standby mode): say so.
    if (z.mode === 'deep' && z.network === 'on') return '<span class="err">' + esc('asleep' + since + ', but still on the Wi-Fi: a light sleep, which costs about 1.5% battery an hour') + '</span>';
    if (z.mode === 'standby' && z.network === 'off') return '<span class="err">' + esc('asleep' + since + ' and off the Wi-Fi: Wake-on-LAN no longer reaches it') + '</span>';
    const how = z.self ? ' (went to sleep by itself)' : z.confirmedAfter != null ? ' (confirmed)' : '';
    const where = z.mode === 'deep' && z.network === 'off' ? ', off the Wi-Fi' : '';
    const next = s.playlist ? ', changes the photo by itself' : z.mode === 'deep' ? '' : ', the next update wakes it';
    return esc((z.mode === 'deep' ? 'in deep sleep' : 'asleep') + since + how + where + next);
  }
  if (z.error) return '<span class="err">' + esc(z.error) + '</span>';
  if (z.pending && z.sleepAt) return esc('awake, goes to sleep at ' + hm(z.sleepAt));
  if (z.own) return 'awake, goes to sleep by itself';
  return 'awake';
}
// The last "Deep sleep now", step by step.
function deepSleepHtml(d) {
  if (!d) return '';
  const head = 'Deep sleep now ' + fmt(d.at) + ': ';
  const asleep = d.asleepAfter != null ? 'asleep after ' + d.asleepAfter + ' s' : '';
  let text;
  let bad = false;
  if (d.step === 'sending') text = 'waking it and sending the command…';
  else if (d.step === 'sent') text = 'sent; waiting for it to stop answering…';
  else if (d.step === 'asleep') text = asleep + '; is it off the Wi-Fi?…';
  else if (d.step === 'off the Wi-Fi') text = asleep + ', off the Wi-Fi after ' + d.offAfter + ' s: deep sleep';
  else if (d.step === 'still on the Wi-Fi') { text = asleep + ', but still on the Wi-Fi at ' + hm(d.checkedAt) + ': a light sleep'; bad = true; }
  else if (d.step === 'asleep (Wi-Fi unknown)') text = asleep + '; whether it left the Wi-Fi is unknown';
  else if (d.step === 'awake again') text = asleep + '; awake again after ' + d.awakeAfter + ' s';
  else if (d.step === 'not reached') text = 'no answer, not even to Wake-on-LAN (in deep sleep already?)';
  else if (d.step === 'still awake') { text = 'it took the command but stayed awake'; bad = true; }
  else { text = d.error || d.step; bad = true; }
  return '<br><span class="' + (bad ? 'err' : 'muted') + '">' + esc(head + text) + '</span>';
}
// Sleep checks, and when the display was found awake (after a press on its button, while
// charging). Waking up after a change is expected in playlist mode: that is under "After a change".
function watchHtml(c) {
  if (!c) return '–';
  let h = esc('every ' + c.everyMin + ' min');
  if (c.last) h += ' · last ' + esc(fmt(c.last.at)) + ': ' + (c.last.awake ? 'awake' : 'asleep');
  const ev = (c.wakeEvents || []).filter((e) => !e.afterChange);
  if (ev.length) {
    h += '<br><span class="muted">Found awake:</span> ' + ev.slice(0, 4).map((e) => esc(fmt(e.at)
      + (e.battery != null ? ' (' + e.battery + '%' + (e.charging ? ', charging' : '') + ')' : '')
      + (e.sent === 'playlist' ? ', sent the playlist' : e.sent ? ', sent the waiting photo' : e.putBack ? ', put back to sleep' : e.leftAlone ? ', left to go back to sleep by itself' : e.error ? ', ' + e.error : ''))).join('; ');
  }
  return h;
}
function checkText(s) {
  const c = s.displayCheck;
  if (!c) return '–';
  return esc(fmt(c.at) + ' · ' + c.name + ', firmware ' + c.software + ' · Network Standby ' + c.networkStandby
    + (c.sleepAfter ? ' · Sleep After ' + c.sleepAfter : '') + (c.applySleep ? ' · sleep after content update ' + c.applySleep : '')
    + (c.lowPowerWifi ? ' · low-power Wi-Fi module ' + c.lowPowerWifi : '') + (s.thumbnails === false ? ' · sends no thumbnails' : ''));
}
function playlistHtml(pl) {
  let h = pl.batch
    ? esc(pl.batch.photos + ' photos sent ' + fmt(pl.batch.sentAt) + ', until ' + fmt(pl.batch.endsAt) + ' (' + pl.daysLeft + ' to come; a fresh one when fewer than ' + pl.topUpDays + ' are left)')
      + (pl.batch.ranOut ? ' · <span class="err">used up: the display repeats it until it gets a fresh one</span>' : '')
    : '<span class="err">not on the display yet</span>';
  if (pl.due) h += '<br><span class="muted">' + esc('Fresh playlist due (' + pl.due + '). It goes out when the display is next online (after its next change, or press its power button).') + '</span>';
  return h;
}
function changesHtml(pl) {
  const rows = (pl.changes || []).slice(0, 3).map((c) => {
    const bat = c.battery != null ? ', battery ' + c.battery + '%' : '';
    if (c.online) return esc(fmt(c.at) + ': online ' + Math.round((c.online - c.at) / 1000) + ' s after the change' + bat);
    if (c.until > Date.now()) return esc(fmt(c.at) + ': looking for the display until ' + hm(c.until) + '…');
    return esc(fmt(c.at) + ': the display did not come online');
  });
  return rows.length ? rows.join('<br>') : '–';
}
function slotName(pl, key) {
  const x = pl.slots.find((y) => y.key === key);
  return x ? x.label : key;
}
function seenHtml(pl) {
  return (pl.seen || []).filter((e) => e.seen).slice(0, 3).map((e) => esc(fmt(e.at) + ' (' + e.how + '): ' + (e.sure ? '' : 'probably ') + slotName(pl, e.seen) + '’s photo')
    + (e.ok ? ', as expected' : ' <span class="err">' + esc('(expected ' + slotName(pl, e.expected) + '’s)') + '</span>')).join('<br>');
}
function render(s) {
  last = s;
  $('#state').textContent = s.busy ? s.busy.what + '…' : 'idle';
  $('#state').className = 'chip' + (s.busy ? ' busy' : '');
  document.querySelectorAll('.actions button').forEach((b) => b.disabled = !!s.busy);
  const pl = s.playlist;
  $('[data-act="next"]').textContent = pl ? 'New photo for today' : 'Next photo now';
  $('[data-act="next"]').title = pl ? 'Replaces the photo for now and sends the playlist again' : '';
  $('[data-act="resend"]').textContent = pl ? 'Send playlist' : 'Send again';
  $('[data-act="resend"]').title = pl ? 'Sends the photos for the coming days now (the display must be awake: press its power button first)' : '';
  $('[data-view="playlist"]').hidden = !pl;
  $('[data-act="deep-sleep"]').hidden = !(s.sleep && s.sleep.mode === 'deep');
  const c = s.current;
  const tpShowing = s.testPattern && s.testPattern.sent && (!c || !c.pushedAt || s.testPattern.at > c.pushedAt);
  let onFrame = tpShowing ? 'the test pattern (until the next ' + (pl ? 'playlist' : 'update') + ')'
    : c ? c.items.map((it) => day(it.takenAt)).join(' + ') + (c.dryRun ? ' <span class="muted">(dry run: EMDX_HOST not set)</span>' : c.pushed ? '' : ' <span class="err">(not on the display yet)</span>') : '–';
  if (pl && c && c.since && !tpShowing && c.pushed) onFrame += esc(' · since ' + fmt(c.since) + (c.byDisplay ? ', changed by the display' : ''));
  const seen = pl ? seenHtml(pl) : '';
  const rows = [
    ['On the frame', onFrame],
    ['Layout', c ? esc(c.kind) : '–'],
    ...(pl ? [
      ['Playlist', playlistHtml(pl)],
      ['Next change', fmt(pl.nextChange)],
      ['After a change', changesHtml(pl)],
      ...(seen ? [['Seen on the display', seen]] : []),
    ] : [
      ['Sent', c && c.pushedAt ? fmt(c.pushedAt) : '–'],
      ['Next update', fmt(s.nextRun)],
    ]),
    ['Battery', batteryHtml(s)],
    ['Display', sleepHtml(s) + deepSleepHtml(s.deepSleep)],
    ['Sleep checks', watchHtml(s.check)],
    ['Display check', checkText(s)],
    ['This round', s.cycle ? esc(s.cycle.shown + ' of ' + s.cycle.total + ' photos ' + (pl ? 'shown or planned' : 'shown') + ' (round ' + s.cycle.n + ')') : '–'],
    ['Album', s.library ? esc(s.library.titles.join(', ') + ' · ' + s.library.count + ' photos · read ' ) + fmt(s.library.fetchedAt) : '–'],
  ];
  if (s.thumbnail && s.thumbnail.file) rows.push(['Screen', '<a href="/img/thumbnails/' + s.thumbnail.file + '?' + s.thumbnail.at + '" target="_blank">thumbnail the display sent ' + esc(fmt(s.thumbnail.at)) + '</a>']);
  $('#info').innerHTML = rows.map(([k, v]) => '<dt>' + k + '</dt><dd>' + v + '</dd>').join('');
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
document.querySelectorAll('.actions button').forEach((b) => b.onclick = async () => {
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
