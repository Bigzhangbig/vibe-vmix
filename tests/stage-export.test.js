'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { crc32, deflateSync } = require('node:zlib');
const { createStageServer } = require('../server/stage-server');
const { listenLocal, closeLocal } = require('../server/listen-local');

function png() {
  function chunk(type, data) {
    const header = Buffer.alloc(8), crc = Buffer.alloc(4);
    header.writeUInt32BE(data.length);
    header.write(type, 4);
    crc.writeUInt32BE(crc32(data, crc32(header.subarray(4))));
    return Buffer.concat([header, data, crc]);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1920, 0);
  header.writeUInt32BE(1080, 4);
  header[8] = 8;
  header[9] = 6;
  const width = 1920 * 4 + 1;
  const data = Buffer.alloc(width * 1080);
  for (let y = 0; y < 1080; y++) {
    for (let x = 0; x < 1920; x++) {
      const i = y * width + x * 4 + 1;
      data[i] = 226;
      data[i + 1] = 176;
      data[i + 2] = 136;
      data[i + 3] = x < 640 ? 0 : x < 1280 ? 128 : 255;
    }
  }
  return Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'),
    chunk('IHDR', header), chunk('IDAT', deflateSync(data)), chunk('IEND', Buffer.alloc(0)),
  ]);
}

test('stage renders an ordered lossless PNG ZIP and ProRes alpha when FFmpeg is available', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vibe-export-test-'));
  const server = createStageServer({ dataDirectory: dir });
  const origin = await listenLocal(server);
  t.after(async () => { await closeLocal(server); await fs.rm(dir, { recursive: true, force: true }); });
  const endpoint = origin + '/api/stage/concert-export';
  const post = (url, value, originHeader) => fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(originHeader ? { Origin: originHeader } : {}) },
    body: JSON.stringify(value),
  });
  const body = png();
  const sendFrame = (project, index, image = body) => fetch(project + '/frame/' + index, {
    method: 'POST', headers: { 'Content-Type': 'image/png' }, body: image,
  });
  const caps = await (await fetch(endpoint)).json();
  assert.equal(caps.maxFrames, 600);
  assert.equal((await post(endpoint, { format: 'png', fps: 25, frameCount: 1 }, 'https://not-local.invalid')).status, 403);
  for (const format of caps.mov ? ['png', 'mov'] : ['png']) {
    const created = await post(endpoint, { format, fps: 25, frameCount: 2 });
    assert.equal(created.status, 201);
    const project = endpoint + '/' + (await created.json()).id;
    assert.equal((await sendFrame(project, 1)).status, 409);
    assert.equal((await sendFrame(project, 0, Buffer.from('invalid'))).status, 400);
    for (const index of [0, 1]) assert.equal((await sendFrame(project, index)).status, 200);
    const result = await fetch(project + '/finish', { method: 'POST' });
    assert.equal(result.status, 200, await result.clone().text());
    const url = origin + (await result.json()).url;
    const response = await fetch(url);
    assert.match(response.headers.get('Content-Disposition'), /^attachment;/);
    const data = Buffer.from(await response.arrayBuffer());
    if (format === 'png') {
      assert.equal(data.readUInt32LE(0), 0x04034b50);
      assert.equal(data.readUInt32LE(data.length - 22), 0x06054b50);
      assert.equal(data.readUInt16LE(data.length - 12), 2);
      const firstNameLength = data.readUInt16LE(26);
      const start = 30 + firstNameLength;
      assert.equal(data.toString('ascii', 30, start), 'frame_00000.png');
      assert.deepEqual(data.subarray(start, start + body.length), body);
      assert.equal(data.readUInt32LE(start + body.length + 4), crc32(body));
    } else {
      const movie = path.join(dir, 'stage-test.mov');
      await fs.writeFile(movie, data);
      const decoded = execFileSync(process.env.BROADCAST_FFMPEG || 'ffmpeg', [
        '-hide_banner', '-loglevel', 'error', '-i', movie, '-vf', 'format=rgba',
        '-threads', '1', '-frames:v', '1', '-f', 'rawvideo', '-',
      ], { maxBuffer: 16 * 1024 * 1024 });
      assert.equal(decoded[3], 0);
      assert.ok(Math.abs(decoded[960 * 4 + 3] - 128) <= 3);
      assert.equal(decoded[1600 * 4 + 3], 255);
    }
    let cleanup;
    for (let retry = 0; retry < 10; retry++) {
      cleanup = await fetch(project, { method: 'DELETE' });
      if (cleanup.status !== 409) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(cleanup.status, 200);
    assert.equal((await fetch(url)).status, 404);
  }
});
