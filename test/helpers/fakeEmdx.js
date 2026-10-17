// A fake Samsung EMDX for tests: speaks the MDC handshake (banner, TLS, PIN),
// answers commands, and on 0xC7 downloads content.json + the image like the
// real display does. Power-off (0x11 0x00) puts it to sleep: it then refuses
// connections until a Wake-on-LAN packet for its MAC arrives (only heard with
// network standby on) or wake() (someone pressing its button). Like the EM32DX,
// it refuses (NAKs) 0x25 with a timer payload. It answers the clock (0xA7) and,
// unless `hasTimer` is false, refuses timer 1 (0xA4).
//
// Playlists: a content.json with several images is downloaded in full and then played
// by itself: `state.playlistModel` 'push' (each image for its own duration, counted from
// the download), 'equal' (every image for the first one's duration) or 'stuck' (never
// moves on). On 0xC7/0x54 + URL it POSTs a thumbnail (the image it shows) to that URL,
// unless `thumbnails` is false. It keeps Sleep After (0xC6/0x81) and "apply sleep mode
// after content update" (0xC7/0x53 type 0x01).
import dgram from 'node:dgram';
import net from 'node:net';
import tls from 'node:tls';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export function makeCert() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-emdx-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', `${dir}/key.pem`, '-out', `${dir}/cert.pem`, '-days', '1', '-subj', '/CN=fake-emdx'], { stdio: 'ignore' });
  return { key: fs.readFileSync(`${dir}/key.pem`), cert: fs.readFileSync(`${dir}/cert.pem`) };
}

function reply(sock, displayId, cmd, payload = [], ack = true) {
  const body = [0xff, displayId, payload.length + 2, ack ? 0x41 : 0x4e, cmd, ...payload];
  const checksum = body.reduce((a, b) => a + b, 0) % 256;
  sock.write(Buffer.from([0xaa, ...body, checksum]));
}

export async function startFakeEmdx({ pin = '123456', battery = 87, fetchImage = true, mac = '02:00:00:00:00:01', thumbnails = true } = {}) {
  const { key, cert } = makeCert();
  // Events look like 'auth', 'cmd:1b', 'cmd:b5:1' (hex command, decimal payload), 'wol'.
  const events = [];
  const received = [];
  // hearsWol: false simulates a sleeping display that Wake-on-LAN doesn't reach at all;
  // ignoresPowerOff: how many power-off commands it acknowledges but then stays awake
  // (Infinity: all of them).
  const state = {
    awake: true, networkStandby: true, hearsWol: true, ignoresPowerOff: 0, pluggedIn: false,
    sleepAfter: [0x07], applySleep: false, playlistModel: 'push', playing: null, thumbnailsPosted: 0,
  };
  // The image it shows now (playlists move on by themselves).
  const showing = () => {
    const p = state.playing;
    if (!p) return null;
    if (p.images.length === 1 || state.playlistModel === 'stuck') return { index: 0, ...p };
    const ds = state.playlistModel === 'equal' ? p.durations.map(() => p.durations[0]) : p.durations;
    let x = (Date.now() - p.startedAt) % ds.reduce((a, b) => a + b, 0);
    let index = 0;
    while (x >= ds[index]) x -= ds[index++];
    return { index, ...p };
  };
  async function postThumbnail(url) {
    const now = showing();
    const form = new FormData();
    form.append('device_id', 'FAKE0001');
    form.append('content_id', now?.content.id || 'null');
    form.append('content_name', now?.content.name || 'null');
    form.append('content_type', now?.content.content_type || 'null');
    form.append('content_player_type', 'MobileCMS');
    form.append('schedule_downloaded_timestamp', String(now?.startedAt || 0));
    form.append('thumbnail_timestamp', String(Date.now()));
    if (now) form.append('file', new Blob([now.images[now.index]], { type: 'image/png' }), 'thumbnail.png');
    try {
      await fetch(url, { method: 'POST', body: form });
      state.thumbnailsPosted++;
      events.push('thumbnail');
    } catch (err) {
      events.push(`thumbnail-error:${err.message}`);
    }
  }
  const server = net.createServer((raw) => {
    raw.on('error', () => {});
    if (!state.awake) { // asleep: nothing answers
      events.push('refused');
      raw.destroy();
      return;
    }
    raw.write('MDCSTART<<TLS>>');
    const sock = new tls.TLSSocket(raw, { isServer: true, key, cert });
    sock.on('error', () => {});
    let authed = false;
    sock.on('data', async (data) => {
      if (!authed) {
        if (data.toString() === pin) { authed = true; sock.write('MDCAUTH<<PASS>>'); events.push('auth'); }
        else { sock.write('MDCAUTH<<FAIL:0x01>>'); events.push('bad-pin'); }
        return;
      }
      if (data[0] !== 0xaa) return;
      const cmd = data[1], id = data[2], len = data[3];
      const payload = data.subarray(4, 4 + len);
      const sub = cmd === 0xc7 ? payload[0] : null;
      // 0xC7: 'cmd:c7' for a content download, 'cmd:c7/<sub>[:data]' for the rest.
      events.push(cmd === 0xc7
        ? (sub === 0x53 && payload[1] === 0x80 ? 'cmd:c7' : `cmd:c7/${sub.toString(16)}${len > 1 && sub !== 0x54 ? `:${[...payload.subarray(1)].join(',')}` : ''}`)
        : `cmd:${cmd.toString(16)}${len ? `:${[...payload].join(',')}` : ''}`);
      if (cmd === 0xc6 && payload[0] === 0x81) {
        if (len > 1) state.sleepAfter = [...payload.subarray(1)];
        return reply(sock, id, cmd, [0x81, ...state.sleepAfter]);
      }
      if (cmd === 0xcb) return reply(sock, id, cmd, [0x00, 0x00]);
      if (cmd === 0xc7 && sub === 0x81) return reply(sock, id, cmd, [0x81, 0x04]);
      if (cmd === 0xc7 && sub === 0x53 && payload[1] !== 0x80) {
        if (len > 2 && payload[1] === 0x01) state.applySleep = payload[2] === 0x01;
        return reply(sock, id, cmd, [0x53, 0x01, state.applySleep ? 0x01 : 0x00]);
      }
      if (cmd === 0xc7 && sub === 0x54) {
        if (!thumbnails) return reply(sock, id, cmd, [0x00], false);
        const url = payload.subarray(1).toString();
        reply(sock, id, cmd, [0x54]);
        setTimeout(() => postThumbnail(url), 20);
        return;
      }
      if (cmd === 0x1b) return reply(sock, id, cmd, [0x73, 0x00, 0x01, 0x00, battery, 0x00, state.pluggedIn ? 0x02 : 0x00]);
      if (cmd === 0x25 && len > 1) return reply(sock, id, cmd, [0x01], false);
      if (cmd === 0xa7 && !len) return reply(sock, id, cmd, [16, 1, 5, 10, 0x07, 0xea, 0x00]); // 16 Oct 2026 13:05
      if (cmd === 0xa4 && !len) return reply(sock, id, cmd, [0x01], false);
      if (cmd === 0xb5 && !len) return reply(sock, id, cmd, [state.networkStandby ? 0x01 : 0x00]);
      if (cmd === 0xb5 && len) state.networkStandby = payload[0] === 0x01;
      if (cmd === 0x11 && len && payload[0] === 0x00) {
        reply(sock, id, cmd, [0x00]);
        if (state.ignoresPowerOff > 0) state.ignoresPowerOff--;
        else state.awake = false;
        return;
      }
      if (cmd === 0xc7) {
        const url = payload.subarray(3, 3 + payload[2]).toString();
        reply(sock, id, cmd, []);
        if (!fetchImage) return;
        try {
          const content = JSON.parse((await (await fetch(url)).text()).replaceAll('\\/', '/'));
          events.push('content.json');
          const items = content.schedule[0].contents;
          const images = [];
          for (const c of items) {
            images.push(Buffer.from(await (await fetch(c.image_url)).arrayBuffer()));
            events.push('image');
          }
          received.push({ content, image: images[0], images });
          state.playing = { content, images, durations: items.map((c) => c.duration), startedAt: Date.now() };
        } catch (err) {
          events.push(`fetch-error:${err.message}`);
        }
        return;
      }
      reply(sock, id, cmd, [0x00]);
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));

  // Wake-on-LAN: 6 x 0xFF followed by the MAC 16 times.
  const magic = Buffer.concat([Buffer.alloc(6, 0xff), ...Array(16).fill(Buffer.from(mac.replace(/:/g, ''), 'hex'))]);
  const wol = dgram.createSocket('udp4');
  wol.on('message', (msg) => {
    if (!msg.equals(magic)) return events.push('wol-other');
    const heard = state.networkStandby && state.hearsWol;
    events.push(heard ? 'wol' : 'wol-unheard');
    if (heard) state.awake = true;
  });
  await new Promise((r) => wol.bind(0, '127.0.0.1', r));

  return {
    port: server.address().port,
    wolPort: wol.address().port,
    mac,
    events,
    received,
    state,
    showing,
    wake() { state.awake = true; },
    close: () => new Promise((r) => { wol.close(); server.close(r); }),
  };
}
