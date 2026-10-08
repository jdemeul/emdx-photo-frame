// A stand-in for a shared Google Photos album: short link -> album page with the
// first page of items embedded, batchexecute pagination, item info, and images.
import http from 'node:http';
import sharp from 'sharp';

function item(id, url, w, h, takenAt) {
  return [id, [url, w, h, null, null, null, null, null, [1]], takenAt, 'hash', 7200000, takenAt + 1000, null, null, null, []];
}

export async function startMockGoogle({ landscape = 7, portrait = 4, video = 1 } = {}) {
  let base = '';
  const photos = [];
  const day = 24 * 3600 * 1000;
  let t = Date.UTC(2021, 5, 1);
  for (let i = 0; i < landscape; i++) photos.push({ id: `AF1QipL${i}`, w: 4032, h: 3024, t: (t += day * (i % 3 === 0 ? 30 : 0.1)) });
  for (let i = 0; i < portrait; i++) photos.push({ id: `AF1QipP${i}`, w: 3024, h: 4032, t: (t += day * 2) });
  for (let i = 0; i < video; i++) photos.push({ id: `AF1QipV${i}`, w: 1920, h: 1080, t: (t += day), video: true });
  const urlFor = (p) => `${base}/lh3/${p.id}`;
  const page1 = photos.slice(0, 6);
  const page2 = photos.slice(6);
  const albumInfo = ['AF1QipALBUM', 'Family album', [null, null, null, null, 1600000000000]];
  const stats = { batch: 0, images: 0, pageRequests: 0 };

  const imageCache = new Map();
  async function imageFor(p) {
    const key = `${p.w}x${p.h}`;
    if (!imageCache.has(key)) {
      // A colourful gradient photo stand-in.
      const w = 600, h = Math.round((600 * p.h) / p.w);
      const raw = Buffer.alloc(w * h * 3);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const o = (y * w + x) * 3;
        raw[o] = (x * 255) / w; raw[o + 1] = (y * 255) / h; raw[o + 2] = 128 + 127 * Math.sin(x / 40);
      }
      imageCache.set(key, await sharp(raw, { raw: { width: w, height: h, channels: 3 } }).jpeg().toBuffer());
    }
    return imageCache.get(key);
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, base);
    if (url.pathname === '/short') {
      res.writeHead(302, { Location: `${base}/share/AF1QipALBUM?key=TESTKEY` }).end();
      return;
    }
    if (url.pathname === '/share/AF1QipALBUM') {
      stats.pageRequests++;
      const ds0 = JSON.stringify([[1, 2, 3], 'decoy']);
      const ds1 = JSON.stringify([null, page1.map((p) => item(p.id, urlFor(p), p.w, p.h, p.t)), 'TOKEN-2', albumInfo]);
      const html = `<!doctype html><html><head><link rel="canonical" href="${base}/share/AF1QipALBUM?key=TESTKEY"></head><body>
<script nonce="x">AF_initDataCallback({key: 'ds:0', hash: '1', data:${ds0}, sideChannel: {}});</script>
<script nonce="x">AF_initDataCallback({key: 'ds:1', hash: '2', data:${ds1}, sideChannel: {}});</script>
</body></html>`;
      res.writeHead(200, { 'Content-Type': 'text/html' }).end(html);
      return;
    }
    if (url.pathname === '/batchexecute' && req.method === 'POST') {
      stats.batch++;
      let body = '';
      for await (const chunk of req) body += chunk;
      const freq = JSON.parse(new URLSearchParams(body).get('f.req'));
      const out = [];
      for (const [rpc, payloadStr] of freq[0]) {
        const payload = JSON.parse(payloadStr);
        if (rpc === 'snAcKc') {
          const token = payload[1];
          const data = token === 'TOKEN-2'
            ? [null, page2.map((p) => item(p.id, urlFor(p), p.w, p.h, p.t)), null, albumInfo]
            : [null, page1.map((p) => item(p.id, urlFor(p), p.w, p.h, p.t)), 'TOKEN-2', albumInfo];
          out.push(['wrb.fr', 'snAcKc', JSON.stringify(data), null, null, null, 'generic']);
        } else if (rpc === 'fDcn4b') {
          const p = photos.find((x) => x.id === payload[0]);
          if (p) out.push(['wrb.fr', 'fDcn4b', JSON.stringify([[p.id, '', p.video ? `VID_${p.id}.mp4` : `IMG_${p.id}.jpg`, p.t, null, 123456, p.w, p.h]]), null, null, null, 'generic']);
        }
      }
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(`)]}'\n\n${JSON.stringify(out)}`);
      return;
    }
    const m = /^\/lh3\/([^=]+)=w(\d+)-h(\d+)/.exec(url.pathname);
    if (m) {
      stats.images++;
      const p = photos.find((x) => x.id === m[1]);
      if (!p) { res.writeHead(404).end(); return; }
      const buf = await imageFor(p);
      res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': buf.length }).end(buf);
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    shortUrl: `${base}/short`,
    batchUrl: `${base}/batchexecute`,
    photos,
    stats,
    close: () => new Promise((r) => { server.close(r); server.closeAllConnections(); }),
  };
}
