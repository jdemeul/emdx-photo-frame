// A fake Samsung EMDX for tests: speaks the MDC handshake (banner, TLS, PIN),
// answers commands, and on 0xC7 downloads content.json + the image like the
// real display does. Power-off (0x11 0x00) puts it to sleep: it then refuses
// connections until a Wake-on-LAN packet for its MAC arrives (only heard with
// network standby on) or wake() (someone pressing its button). Like the EM32DX,
// it refuses (NAKs) 0x25 with a timer payload.
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

export async function startFakeEmdx({ pin = '123456', battery = 87, fetchImage = true, mac = '02:00:00:00:00:01' } = {}) {
  const { key, cert } = makeCert();
  // Events look like 'auth', 'cmd:1b', 'cmd:b5:1' (hex command, decimal payload), 'wol'.
  const events = [];
  const received = [];
  const state = { awake: true, networkStandby: true };
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
      events.push(`cmd:${cmd.toString(16)}${len && cmd !== 0xc7 ? `:${[...payload].join(',')}` : ''}`);
      if (cmd === 0x1b) return reply(sock, id, cmd, [0x73, 0x00, 0x01, 0x00, battery, 0x00, 0x02]);
      if (cmd === 0x25 && len > 1) return reply(sock, id, cmd, [0x01], false);
      if (cmd === 0xb5 && !len) return reply(sock, id, cmd, [state.networkStandby ? 0x01 : 0x00]);
      if (cmd === 0xb5 && len) state.networkStandby = payload[0] === 0x01;
      if (cmd === 0x11 && len && payload[0] === 0x00) {
        reply(sock, id, cmd, [0x00]);
        state.awake = false;
        return;
      }
      if (cmd === 0xc7) {
        const url = payload.subarray(3, 3 + payload[2]).toString();
        reply(sock, id, cmd, []);
        if (!fetchImage) return;
        try {
          const content = JSON.parse((await (await fetch(url)).text()).replaceAll('\\/', '/'));
          events.push('content.json');
          const c = content.schedule[0].contents[0];
          const img = Buffer.from(await (await fetch(c.image_url)).arrayBuffer());
          received.push({ content, image: img });
          events.push('image');
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
    events.push(state.networkStandby ? 'wol' : 'wol-unheard');
    if (state.networkStandby) state.awake = true;
  });
  await new Promise((r) => wol.bind(0, '127.0.0.1', r));

  return {
    port: server.address().port,
    wolPort: wol.address().port,
    mac,
    events,
    received,
    state,
    wake() { state.awake = true; },
    close: () => new Promise((r) => { wol.close(); server.close(r); }),
  };
}
