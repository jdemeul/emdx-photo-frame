import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMultipart } from '../src/multipart.js';

test('multipart bodies are read, including ones with bare LF line breaks and no closing boundary', async () => {
  // What fetch/FormData sends (well-formed, CRLF).
  const fd = new FormData();
  fd.append('device_id', 'ABC123');
  fd.append('content_type', 'PlaylistContent');
  fd.append('file', new Blob([Buffer.from([1, 2, 3, 4])], { type: 'image/jpeg' }), 'thumb.jpg');
  const req = new Request('http://x/', { method: 'POST', body: fd });
  const parts = parseMultipart(Buffer.from(await req.arrayBuffer()), req.headers.get('content-type'));
  assert.deepEqual(parts.map((p) => [p.name, p.filename, p.type]), [['device_id', null, null], ['content_type', null, null], ['file', 'thumb.jpg', 'image/jpeg']]);
  assert.equal(parts[0].content.toString(), 'ABC123');
  assert.deepEqual([...parts[2].content], [1, 2, 3, 4]);

  // Sloppier: LF only, unquoted name, quoted boundary, body cut off before the closing boundary.
  const sloppy = Buffer.from([
    '--xyz', 'Content-Disposition: form-data; name=device_id', '', 'D1',
    '--xyz', 'Content-Disposition: form-data; name="thumbnail"; filename="t.png"', 'Content-Type: image/png', '', 'PNGDATA',
  ].join('\n'));
  const p2 = parseMultipart(sloppy, 'multipart/form-data; boundary="xyz"');
  assert.deepEqual(p2.map((p) => [p.name, p.filename, p.type, p.content.toString()]), [['device_id', null, null, 'D1'], ['thumbnail', 't.png', 'image/png', 'PNGDATA']]);

  assert.throws(() => parseMultipart(Buffer.from('hello'), 'multipart/form-data; boundary=abc'), /no parts/);
  assert.throws(() => parseMultipart(Buffer.from('hello'), 'application/json'), /no multipart boundary/);
});
