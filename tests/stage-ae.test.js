'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { spawn } = require('node:child_process');
const { crc32 } = require('node:zlib');
const { createAssetLibrary } = require('../server/stage-assets');
const { normalizeManifest, renderArgs } = require('../server/stage-ae');

const manifest = {
  kind: 'vibe-vmix-ae',
  version: 1,
  project: '深秋歌会.aepx',
  compositions: [{ name: '03 选手 · 王 + 舞台', width: 2, height: 2, fps: 25, duration: 2 }],
};

async function waitForResult(lib, id) {
  const deadline = Date.now() + 9000;
  while (Date.now() < deadline) {
    const job = lib.jobs().find((item) => item.id === id);
    if (job?.status !== 'running') return job;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw Error('mock aerender job timed out');
}
function openFixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-stage-ae-'));
  const assetsDir = path.join(dir, 'assets');
  const src = path.join(dir, manifest.project);
  fs.writeFileSync(src, 'fake-project-not-a-real-aepx');
  const engineScript = path.join(dir, 'fake aerender.js');
  fs.writeFileSync(engineScript, [
    "const fs = require('node:fs'), z = require('node:zlib'), args = process.argv.slice(2);",
    "function get(k) { return args[args.indexOf(k)+1]; }",
    "const out = get('-output'), mode = get('-OMtemplate');",
    "if (!get('-project').endsWith('深秋歌会.aepx') || !get('-comp').includes('王 + 舞台')) process.exit(4);",
    "function chunk(type, bytes) { const data=Buffer.concat([Buffer.from(type),bytes]); const out=Buffer.alloc(8+data.length); out.writeUInt32BE(bytes.length);data.copy(out,4);out.writeUInt32BE(z.crc32(data), 4+data.length);return out; }",
    "function png(alpha) {const b=Buffer.alloc(13); b.writeUInt32BE(2,0);b.writeUInt32BE(2,4);b[8]=8;b[9]=alpha?6:2; return Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),chunk('IHDR',b),chunk('IDAT',z.deflateSync(Buffer.alloc(alpha?18:14))),chunk('IEND',Buffer.alloc(0))]); }",
    "if (out.endsWith('.mov')) {const b=Buffer.alloc(24); b.writeUInt32BE(24); b.write('ftypqt  ',4);fs.writeFileSync(out, b);}",
    "else if (out.includes('[#####]')) for (const i of mode==='missing frame'?[11,13]:[11,12,13]) fs.writeFileSync(out.replace('[#####]',String(i).padStart(5,'0')),png(mode!=='RGB only'));",
    "else process.exit(5);"
  ].join('\n'));
  const lib = createAssetLibrary(assetsDir, {
    env: { BROADCAST_AERENDER: process.execPath },
    spawnEngine: (engine, args, opt) => spawn(engine, [engineScript, ...args], opt),
  });
  t.after(() => {
    lib.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { lib, src, assetsDir };
}
function checkZip(data) {
  // Read stored local records via offsets supplied by the ZIP central directory.
  const end = data.length - 22;
  assert.equal(data.readUInt32LE(end), 0x06054b50);
  let cursor = data.readUInt32LE(end + 16);
  const frames = [];
  for (let i = 0; i < data.readUInt16LE(end + 10); i++) {
    assert.equal(data.readUInt32LE(cursor), 0x02014b50);
    const nameLength = data.readUInt16LE(cursor + 28);
    const name = data.toString('utf8', cursor + 46, cursor + 46 + nameLength);
    const offset = data.readUInt32LE(cursor + 42);
    assert.equal(data.readUInt32LE(offset), 0x04034b50);
    const start = offset + 30 + data.readUInt16LE(offset + 26);
    const file = data.subarray(start, start + data.readUInt32LE(cursor + 24));
    assert.equal(crc32(file), data.readUInt32LE(cursor + 16));
    assert.equal(file[25], 6);
    frames.push(name);
    cursor += 46 + nameLength;
  }
  return frames;
}

test('validates AE composition metadata and passes literal aerender arguments', () => {
  assert.deepEqual(normalizeManifest(manifest).compositions, manifest.compositions);
  assert.throws(() => normalizeManifest({ ...manifest, version: 2 }), /有效/);
  assert.throws(() => normalizeManifest({ ...manifest, compositions: [{ ...manifest.compositions[0], fps: '25' }] }), /无效/);
  assert.deepEqual(
    renderArgs({ project: '演出 文件.aep', composition: '树叶 & 落款', outputModule: '透明 RGBA', format: 'mov', output: '测试.mov' }),
    ['-project', '演出 文件.aep', '-comp', '树叶 & 落款', '-OMtemplate', '透明 RGBA', '-output', '测试.mov'],
  );
});

test('links AEPX, imports comp list and renders a real ZIP of ordered RGBA frames', async (t) => {
  const { lib, src, assetsDir } = openFixture(t);
  const project = lib.register(src);
  assert.equal(lib.filename(project), src);
  assert.deepEqual(lib.attachAEManifest({ id: project.id, manifest }).compositions, manifest.compositions);
  const job = lib.renderAE({ id: project.id, composition: manifest.compositions[0].name, outputModule: 'PNG Alpha', format: 'png-sequence' });
  assert.throws(() => lib.renderAE({ id: project.id, composition: 'Another', outputModule: 'PNG Alpha', format: 'png-sequence' }), /已有/);
  const done = await waitForResult(lib, job.id);
  assert.equal(done.status, 'done', done.log);
  assert.equal(done.asset.kind, 'sequence');
  assert.equal(done.asset.frames, 3);
  assert.equal(done.asset.fps, 25);
  assert.equal(done.asset.width, 2);
  assert.match(done.asset.download, /^\/assets\/[a-f0-9]{32}\.zip$/);
  assert.equal(fs.readFileSync(path.join(assetsDir, done.asset.firstFrame))[25], 6);
  assert.deepEqual(checkZip(fs.readFileSync(lib.filename(done.asset))), ['frame_00000.png', 'frame_00001.png', 'frame_00002.png']);
});

test('refuses missing and RGB-only frames rather than publishing a broken sequence', async (t) => {
  const { lib, src } = openFixture(t);
  const project = lib.register(src);
  for (const [outputModule, error] of [['RGB only', /Alpha/], ['missing frame', /不连续/]]) {
    const job = lib.renderAE({ id: project.id, composition: manifest.compositions[0].name, outputModule, format: 'png-sequence' });
    const result = await waitForResult(lib, job.id);
    assert.equal(result.status, 'failed');
    assert.match(result.log, error);
    assert.equal(lib.list().length, 1);
  }
});

test('preserves the existing MOV path without claiming alpha verification', async (t) => {
  const { lib, src } = openFixture(t);
  const project = lib.register(src);
  const out = await waitForResult(lib, lib.renderAE({
    id: project.id, composition: manifest.compositions[0].name, outputModule: 'Custom MOV',
  }).id);
  assert.equal(out.status, 'done', out.log);
  assert.equal(out.asset.kind, 'video');
  assert.equal(out.format, 'mov');
  assert.match(out.asset.file, /\.mov$/);
});

test('AE JSX exports the selected composition without writing the project itself', () => {
  const scriptPath = path.join(__dirname, '..', 'ae-plugin', 'jsx', 'export-compositions.jsx');
  const script = fs.readFileSync(scriptPath, 'utf8').replace(/^#include.*\n/, '');
  function CompItem(data) { Object.assign(this, data); }
  const comp = new CompItem({ ...manifest.compositions[0], frameRate: 25 });
  let body;
  function File() {}
  File.saveDialog = () => ({ name: 'export.json', open: () => true, close: () => {}, write: (s) => { body = s; return true; } });
  File.decode = decodeURIComponent;
  vm.runInNewContext(script, {
    app: { project: { file: { name: encodeURIComponent(manifest.project) }, selection: [comp] } },
    File,
    CompItem,
    alert: () => {},
  });
  assert.deepEqual(JSON.parse(body), manifest);
});
