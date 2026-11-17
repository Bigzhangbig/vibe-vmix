'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { createConcertServer } = require('../server/concert-server');
const { listenLocal, closeLocal } = require('../server/listen-local');
async function setup(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'concert-production-'));
  const servers = [];
  t.after(async () => {
    for (const server of servers.reverse()) await closeLocal(server);
    fs.rmSync(directory, { recursive: true, force: true });
  });
  async function start() {
    const server = createConcertServer({ dataDirectory: directory });
    servers.push(server);
    const origin = await listenLocal(server);
    async function api(route = '/api/state', input, status = 200) {
      const response = await fetch(
        origin + route,
        input === undefined
          ? {}
          : {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(input),
            },
      );
      assert.equal(response.status, status);
      return response.json();
    }
    return { server, api, origin };
  }
  return { directory, start, ...(await start()) };
}
test('invalid layout batches leave all geometry, placement and ticks unchanged', async (t) => {
  const { api } = await setup(t);
  const before = await api();
  await api(
    '/api/layout',
    {
      items: [
        { id: 'announceText', x: 444 },
        { id: 'missing', y: 99 },
      ],
    },
    400,
  );
  const after = await api();
  assert.deepEqual(after.layout, before.layout);
  assert.equal(after.announcePlacement, before.announcePlacement);
  assert.equal(after.tick, before.tick);
});
test('oversized song lists are rejected without silently truncating persisted songs', async (t) => {
  const { api, directory } = await setup(t);
  const before = fs.readFileSync(path.join(directory, 'songs.json'), 'utf8');
  await api(
    '/api/songs',
    { songs: Array.from({ length: 201 }, (_, i) => ({ id: String(i), title: '歌曲' + i })) },
    400,
  );
  assert.equal(fs.readFileSync(path.join(directory, 'songs.json'), 'utf8'), before);
});
test('corrupt main song data recovers the previous good backup and preserves evidence', async (t) => {
  const { api, directory, server, start } = await setup(t);
  await api('/api/songs', {
    songs: [{ id: 'first', title: '保留曲目', lyrics: ['', '保留歌词'] }],
  });
  await api('/api/songs', { songs: [{ id: 'second', title: '第二次保存' }] });
  await closeLocal(server);
  const backup = fs.readFileSync(path.join(directory, 'songs.json.bak'), 'utf8');
  fs.writeFileSync(path.join(directory, 'songs.json'), '{damaged');
  const restored = await start();
  assert.equal((await restored.api('/api/songs')).songs[0].id, 'first');
  assert(fs.readdirSync(directory).some((name) => name.startsWith('songs.json.corrupt-')));
  assert((await restored.api()).storageWarnings.length > 0);
  assert.equal(fs.readFileSync(path.join(directory, 'songs.json'), 'utf8'), backup);
  assert.equal(fs.readFileSync(path.join(directory, 'songs.json.bak'), 'utf8'), backup);
  const evidence = fs.readdirSync(directory).find((name) => name.startsWith('songs.json.corrupt-'));
  assert.equal(fs.readFileSync(path.join(directory, evidence), 'utf8'), '{damaged');
});
test('unrecoverable corrupt user data fails initialization and retains original bytes', async (t) => {
  const { directory, server } = await setup(t);
  await closeLocal(server);
  fs.writeFileSync(path.join(directory, 'songs.json'), '{damaged');
  fs.writeFileSync(path.join(directory, 'songs.json.bak'), '{also damaged');
  assert.throws(() => createConcertServer({ dataDirectory: directory }), /songs.json/);
  assert.equal(fs.readFileSync(path.join(directory, 'songs.json'), 'utf8'), '{damaged');
  assert.equal(fs.readFileSync(path.join(directory, 'songs.json.bak'), 'utf8'), '{also damaged');
});

test('legacy user data without any backup is preserved when its JSON is damaged', async (t) => {
  const { directory, server } = await setup(t);
  await closeLocal(server);
  fs.rmSync(path.join(directory, 'songs.json.bak'), { force: true });
  fs.writeFileSync(path.join(directory, 'songs.json'), '{legacy damaged');
  assert.throws(() => createConcertServer({ dataDirectory: directory }), /songs.json/);
  assert.equal(fs.readFileSync(path.join(directory, 'songs.json'), 'utf8'), '{legacy damaged');
});

test('missing primary song data restores backup bytes and reports recovery instead of seeding', async (t) => {
  const { api, directory, server, start } = await setup(t);
  await api('/api/songs', { songs: [{ id: 'recover-me', title: '备份中的节目' }] });
  await api('/api/songs', { songs: [{ id: 'latest', title: '稍后修改' }] });
  await closeLocal(server);
  const backup = fs.readFileSync(path.join(directory, 'songs.json.bak'), 'utf8');
  fs.unlinkSync(path.join(directory, 'songs.json'));
  const restored = await start();
  assert.equal((await restored.api('/api/songs')).songs[0].id, 'recover-me');
  assert.equal(fs.readFileSync(path.join(directory, 'songs.json'), 'utf8'), backup);
  assert.equal(fs.readFileSync(path.join(directory, 'songs.json.bak'), 'utf8'), backup);
  assert((await restored.api()).storageWarnings.some((warning) => warning.includes('songs.json')));
});

test('missing primary with damaged backup fails without creating seed data or changing evidence', async (t) => {
  const { directory, server } = await setup(t);
  await closeLocal(server);
  fs.unlinkSync(path.join(directory, 'songs.json'));
  fs.writeFileSync(path.join(directory, 'songs.json.bak'), '{damaged backup');
  assert.throws(() => createConcertServer({ dataDirectory: directory }), /songs.json/);
  assert.equal(fs.existsSync(path.join(directory, 'songs.json')), false);
  assert.equal(fs.readFileSync(path.join(directory, 'songs.json.bak'), 'utf8'), '{damaged backup');
});
test('branding validation and disk failures cannot partially change configuration', async (t) => {
  const { api, directory } = await setup(t);
  const before = (await api()).config;
  await api('/api/config', { fadeIn: 123, branding: { eventTitle: '更改', accent: 'bad' } }, 400);
  assert.deepEqual((await api()).config, before);
  await api('/api/config', {
    branding: { eventTitle: '今年歌会', subtitle: '现场', accent: '#123456', badgeMode: 'text' },
  });
  assert.equal((await api()).config.branding.eventTitle, '今年歌会');
  const saved = (await api()).config;
  fs.mkdirSync(path.join(directory, 'config.json.tmp'));
  await api('/api/config', { fadeIn: 999 }, 400);
  assert.deepEqual((await api()).config, saved);
});
test('songId is selected atomically with its announce or lyric cue, invalid ids change nothing', async (t) => {
  const { api } = await setup(t);
  await api('/api/songs', {
    songs: [
      { id: 'one', title: '甲', lyrics: ['', '甲句'] },
      { id: 'two', title: '乙', lyrics: ['', '乙句'] },
    ],
  });
  await api('/api/command', { channel: 'announce', payload: { songId: 'two' } });
  let state = await api();
  assert.equal(state.songs.currentId, 'two');
  assert(state.channels.announce.text.includes('乙'));
  assert.equal(state.channels.lyric.index, 0);
  const before = state;
  await api('/api/command', { channel: 'announce', payload: { songId: 'unknown' } }, 400);
  state = await api();
  assert.deepEqual(state.channels, before.channels);
  assert.equal(state.songs.currentId, 'two');
  assert.equal(state.tick, before.tick);
  await api('/api/command', { channel: 'lyric', action: 'next', payload: { songId: 'one' } });
  state = await api();
  assert.equal(state.songs.currentId, 'one');
  assert.equal(state.channels.lyric.text, '甲句');
  assert.equal(state.channels.announce.on, false);
});
test('clear cancels handoff, closes every channel and reports real vMix failure', async (t) => {
  const { api } = await setup(t);
  const vmixFunctions = [];
  const vmix = http.createServer((req, res) => {
    vmixFunctions.push(new URL(req.url, 'http://localhost').searchParams.get('Function'));
    res.writeHead(503);
    res.end('unavailable');
  });
  const vmixOrigin = await listenLocal(vmix);
  t.after(() => closeLocal(vmix));
  await api('/api/config', {
    vmix: { enabled: true, host: '127.0.0.1', port: Number(new URL(vmixOrigin).port) },
  });
  await api('/api/command', { channel: 'badge' });
  await api('/api/command', { channel: 'visual' });
  await api('/api/command', { channel: 'announce' });
  const before = await api();
  await api('/api/event', {
    type: 'media-ended',
    channel: 'announce',
    playbackId: before.channels.announce.playbackId,
  });
  const result = await api('/api/clear', {});
  assert.equal(result.vmix.ok, false);
  assert.equal(result.vmix.status, 503);
  assert.equal(vmixFunctions.at(-1), 'OverlayInput1Out');
  await new Promise((resolve) => setTimeout(resolve, 400));
  const after = await api();
  assert(Object.values(after.channels).every((channel) => channel.on === false));
  assert.deepEqual(after.layout, before.layout);
  assert.deepEqual(after.songs, before.songs);
});

test('SSE reconnect begins with the current snapshot instead of replaying stale cues', async (t) => {
  const { api, origin } = await setup(t);
  async function firstSnapshot() {
    const abort = new AbortController();
    const response = await fetch(origin + '/api/events', { signal: abort.signal });
    const reader = response.body.getReader();
    let text = '';
    try {
      while (!text.includes('data: '))
        text += new TextDecoder().decode((await reader.read()).value);
      return JSON.parse(text.split('data: ')[1].split('\n')[0]);
    } finally {
      abort.abort();
    }
  }
  assert.equal((await firstSnapshot()).state.channels.badge.on, false);
  await api('/api/command', { channel: 'badge' });
  const current = await api();
  const reconnected = await firstSnapshot();
  assert.equal(reconnected.type, 'snapshot');
  assert.equal(reconnected.state.channels.badge.on, true);
  assert.equal(reconnected.state.tick, current.tick);
});

test('renderer reports stay in memory and invalid reports preserve previous outputs', async (t) => {
  const { api, directory } = await setup(t);
  const files = fs.readdirSync(directory);
  await api('/api/renderer', { id: 'vmix-1', width: 1920, height: 1080, media: [] });
  await api('/api/renderer', { id: 'vmix-1', width: 0, height: 1080, media: [] }, 400);
  const report = await api('/api/renderers');
  assert.equal(report.outputs.length, 1);
  assert.equal(report.outputs[0].width, 1920);
  assert.deepEqual(fs.readdirSync(directory), files);
});

test('failed direct document saves preserve both memory and persisted documents', async (t) => {
  const { api, directory } = await setup(t);
  for (const [route, file, input, field] of [
    ['/api/lyrics', 'lyrics.json', { lines: ['', '不应保存'] }, 'lyrics'],
    [
      '/api/credits',
      'credits.json',
      { groups: [{ role: '导演', names: ['不应保存'] }] },
      'credits',
    ],
    ['/api/songs', 'songs.json', { songs: [{ id: 'failed', title: '不应保存' }] }, 'songs'],
  ]) {
    const before = await api();
    const persisted = fs.readFileSync(path.join(directory, file), 'utf8');
    fs.mkdirSync(path.join(directory, file + '.tmp'));
    await api(route, input, 400);
    assert.deepEqual((await api())[field], before[field]);
    assert.equal(fs.readFileSync(path.join(directory, file), 'utf8'), persisted);
  }
});

test('song activation failure rolls back lyric files and leaves the current on-air state unchanged', async (t) => {
  const { api, directory } = await setup(t);
  const before = await api();
  const persisted = fs.readFileSync(path.join(directory, 'lyrics.json'), 'utf8');
  fs.mkdirSync(path.join(directory, 'songs.json.tmp'));
  await api(
    '/api/command',
    { channel: 'announce', payload: { songId: before.songs.songs[0].id } },
    400,
  );
  const after = await api();
  assert.deepEqual(after.channels, before.channels);
  assert.deepEqual(after.songs, before.songs);
  assert.deepEqual(after.lyrics, before.lyrics);
  assert.equal(fs.readFileSync(path.join(directory, 'lyrics.json'), 'utf8'), persisted);
});

test('failed asset deletion persistence keeps the asset and its background binding intact', async (t) => {
  const { api, directory } = await setup(t);
  await api('/api/assets/import', { name: 'custom.png', dataUrl: 'data:image/png;base64,eA==' });
  await api('/api/backgrounds', { channel: 'badge', file: 'custom.png' });
  const before = (await api()).config;
  fs.mkdirSync(path.join(directory, 'config.json.tmp'));
  await api('/api/assets/delete', { file: 'custom.png' }, 400);
  assert.deepEqual((await api()).config, before);
  assert(fs.existsSync(path.join(directory, 'assets/custom.png')));
});

test('loading user-selected Microsoft YaHei never rewrites the saved font', async (t) => {
  const { api, directory, server, start } = await setup(t);
  await api('/api/config', { font: { family: 'Microsoft YaHei' } });
  await closeLocal(server);
  const before = fs.readFileSync(path.join(directory, 'config.json'), 'utf8');
  const restored = await start();
  assert.equal((await restored.api()).config.font.family, 'Microsoft YaHei');
  assert.equal(fs.readFileSync(path.join(directory, 'config.json'), 'utf8'), before);
});

test('shutdown releases SSE and HTTP even when final state persistence fails', async (t) => {
  const { api, origin, directory, server } = await setup(t);
  const events = await fetch(origin + '/api/events');
  const reader = events.body.getReader();
  await reader.read();
  await api('/api/command', { channel: 'badge' });
  const persisted = fs.readFileSync(path.join(directory, 'state.json'), 'utf8');
  fs.mkdirSync(path.join(directory, 'state.json.tmp'));
  await assert.doesNotReject(closeLocal(server));
  await assert.rejects(fetch(origin + '/api/state'));
  assert.equal(fs.readFileSync(path.join(directory, 'state.json'), 'utf8'), persisted);
  try {
    while (!(await reader.read()).done) {}
  } catch (error) {
    assert.match(error.message, /terminated|abort|closed/i);
  }
});
