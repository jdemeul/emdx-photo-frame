import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { extractInitData, parseItems, parseBatchResponse, parseShareUrl, fetchAlbum, fetchItemInfo, sizedUrl, endpoints } from '../src/sources/googleAlbum.js';
import { startMockGoogle } from './helpers/mockGoogle.js';

let mock;
before(async () => {
  mock = await startMockGoogle();
  endpoints.batchexecute = mock.batchUrl;
});
after(() => mock.close());

test('extracts AF_initDataCallback payloads', () => {
  const html = `<script>AF_initDataCallback({key: 'ds:1', hash: '2', data:[null,[["id",["https://x/y",10,20],5]],"tok"], sideChannel: {}});</script>
  <script>AF_initDataCallback({key: 'ds:2', isError:  false , hash: '3', data:["a]b\\"c", [1]], sideChannel: {}});</script>`;
  const blocks = extractInitData(html);
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].key, 'ds:1');
  assert.equal(blocks[1].data[0], 'a]b"c');
  assert.deepEqual(parseItems(blocks[0].data[1]).map((i) => [i.id, i.width, i.height]), [['id', 10, 20]]);
});

test('parses share URLs and batchexecute responses', () => {
  assert.deepEqual(parseShareUrl('https://photos.google.com/share/AF1Qabc?key=K1'), { id: 'AF1Qabc', key: 'K1' });
  const text = `)]}'\n\n[["wrb.fr","snAcKc","[null,[],\\"T\\"]",null,null,null,"generic"],["di",42]]`;
  assert.deepEqual(parseBatchResponse(text, 'snAcKc'), [[null, [], 'T']]);
  const chunked = `)]}'\n\n123\n[["wrb.fr","snAcKc","[1]",null,null,null,"generic"]]\n25\n[["e",4,null,null,147]]\n`;
  assert.deepEqual(parseBatchResponse(chunked, 'snAcKc'), [[1]]);
});

test('reads a shared album across pages', async () => {
  const album = await fetchAlbum(mock.shortUrl);
  assert.equal(album.title, 'Family album');
  assert.equal(album.items.length, mock.photos.length);
  assert.equal(album.pages, 2);
  assert.ok(album.items.every((i) => i.width > 0 && i.takenAt > 0));
});

test('identifies videos by file name', async () => {
  const info = await fetchItemInfo('TESTKEY', ['AF1QipV0', 'AF1QipL0']);
  assert.equal(info.get('AF1QipV0').isVideo, true);
  assert.equal(info.get('AF1QipL0').isVideo, false);
});

test('requests a size that covers the cell without exceeding the original', () => {
  const it = { url: 'https://lh3/x', width: 4000, height: 3000 };
  const m = /=w(\d+)-h(\d+)-no$/.exec(sizedUrl(it, 1440, 1270));
  const [w, h] = [Number(m[1]), Number(m[2])];
  assert.ok(w >= 1440 && h >= 1270 && w <= 4000 && h <= 3000);
});
