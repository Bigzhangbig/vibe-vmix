'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { listenLocal, closeLocal } = require('../server/listen-local');

async function request(origin, route, data) {
  const response = await fetch(
    origin + route,
    data === undefined
      ? {}
      : {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(data),
        },
  );
  assert.equal(response.status, 200);
  return response.json();
}

test('concert factory seeds, serves and persists an isolated managed lifecycle', async (t) => {
  const { createConcertServer } = require('../server/concert-server');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'concert-test-'));
  const servers = [];
  t.after(async () => {
    for (const server of servers.reverse()) await closeLocal(server);
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const firstDirectory = path.join(directory, 'first');
  const first = createConcertServer({ dataDirectory: firstDirectory });
  assert.equal(first.listening, false);
  servers.push(first);
  const origin = await listenLocal(first);
  let state = await request(origin, '/api/state');
  assert(state.songs.songs.length > 0);
  assert.equal(state.assets.length, 4);
  for (const asset of state.assets) assert.equal((await fetch(origin + asset.url)).status, 200);
  assert.equal((await fetch(origin + '/fonts/ShangguSansSC-Missing.ttf')).status, 404);
  const second = createConcertServer({ dataDirectory: path.join(directory, 'second') });
  servers.push(second);
  const other = await listenLocal(second);
  const song = state.songs.songs[0];
  await request(origin, '/api/songs/select', { id: song.id });
  await request(origin, '/api/command', { channel: 'badge', action: 'on' });
  await request(origin, '/api/command', { channel: 'announce', action: 'on' });
  state = await request(origin, '/api/state');
  assert.equal(state.channels.announce.on, true);
  assert(state.channels.announce.text.includes(song.title));
  assert.equal((await request(other, '/api/state')).channels.badge.on, false);
  await request(origin, '/api/command', { channel: 'lyric', action: 'next' });
  state = await request(origin, '/api/state');
  assert.equal(state.channels.lyric.text, song.lyrics[1]);
  assert.equal(state.channels.announce.on, false);
  await closeLocal(first);
  const persistedSongs = fs.readFileSync(path.join(firstDirectory, 'songs.json'), 'utf8');
  fs.unlinkSync(path.join(firstDirectory, 'credits.json'));
  const restored = createConcertServer({ dataDirectory: firstDirectory });
  assert.equal(fs.readFileSync(path.join(firstDirectory, 'songs.json'), 'utf8'), persistedSongs);
  assert(fs.existsSync(path.join(firstDirectory, 'credits.json')));
  servers.push(restored);
  const restoredOrigin = await listenLocal(restored);
  state = await request(restoredOrigin, '/api/state');
  assert.equal(state.channels.lyric.text, song.lyrics[1]);
  assert.equal(state.channels.badge.on, true);
  assert.equal(state.songs.currentId, song.id);
  await closeLocal(restored);
  await closeLocal(second);
});

test('concert shutdown ends SSE and cancels pending lyric handoff before flushing state', async (t) => {
  const { createConcertServer } = require('../server/concert-server');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'concert-stop-'));
  const server = createConcertServer({ dataDirectory: directory });
  t.after(async () => {
    await closeLocal(server);
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const origin = await listenLocal(server);
  const response = await fetch(origin + '/api/events');
  const reader = response.body.getReader();
  await reader.read();
  await request(origin, '/api/command', { channel: 'announce', action: 'on' });
  const { channels } = await request(origin, '/api/state');
  await request(origin, '/api/event', {
    type: 'media-ended',
    channel: 'announce',
    playbackId: channels.announce.playbackId,
  });
  await closeLocal(server);
  const saved = fs.readFileSync(path.join(directory, 'state.json'), 'utf8');
  assert.equal(JSON.parse(saved).channels.lyric.on, false);
  await new Promise((resolve) => setTimeout(resolve, 750));
  assert.equal(fs.readFileSync(path.join(directory, 'state.json'), 'utf8'), saved);
  try {
    while (!(await reader.read()).done) {}
  } catch (error) {
    assert.match(error.message, /terminated|abort|closed/i);
  }
});

async function runningConcert(t) {
  const { createConcertServer } = require('../server/concert-server');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'concert-race-'));
  const server = createConcertServer({ dataDirectory: directory });
  t.after(async () => {
    await closeLocal(server);
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return listenLocal(server);
}

test('stale renderer completion cannot finish a replacement announcement', async (t) => {
  const origin = await runningConcert(t);
  const announce = () => request(origin, '/api/command', { channel: 'announce', action: 'on' });
  const ended = (playbackId) =>
    request(origin, '/api/event', {
      type: 'media-ended',
      channel: 'announce',
      playbackId,
    });
  await announce();
  const old = (await request(origin, '/api/state')).channels.announce.playbackId;
  await announce();
  await ended(old);
  let state = await request(origin, '/api/state');
  assert.equal(state.channels.announce.on, true);
  assert.equal(typeof state.channels.announce.playbackId, 'string');
  const replacement = state.channels.announce.playbackId;
  assert.notEqual(replacement, old);
  await request(origin, '/api/command', { channel: 'badge', action: 'on' });
  assert.equal((await request(origin, '/api/state')).channels.announce.playbackId, replacement);
  await request(origin, '/api/songs/select', { id: state.songs.songs[0].id });
  await ended(replacement);
  state = await request(origin, '/api/state');
  assert.equal(state.channels.announce.on, true);
  assert.notEqual(state.channels.announce.playbackId, replacement);
  await ended(state.channels.announce.playbackId);
  await new Promise((resolve) => setTimeout(resolve, 400));
  state = await request(origin, '/api/state');
  assert.equal(state.channels.announce.on, false);
  assert.equal(state.channels.lyric.on, true);
});

test('manual qualification, credits and clear operations cancel delayed lyric handoff', async (t) => {
  const origin = await runningConcert(t);
  for (const nextChannel of ['qualify', 'credits', 'clear']) {
    for (const channel of ['announce', 'lyric', 'qualify', 'credits']) {
      await request(origin, '/api/command', { channel, action: 'off' });
    }
    await request(origin, '/api/command', { channel: 'announce', action: 'on' });
    const state = await request(origin, '/api/state');
    await request(origin, '/api/event', {
      type: 'media-ended',
      channel: 'announce',
      playbackId: state.channels.announce.playbackId,
    });
    await request(origin, '/api/command', {
      channel: nextChannel === 'clear' ? 'announce' : nextChannel,
      action: nextChannel === 'clear' ? 'off' : 'on',
    });
    await new Promise((resolve) => setTimeout(resolve, 400));
    const after = await request(origin, '/api/state');
    assert.equal(after.channels.lyric.on, false, nextChannel + ' must cancel pending lyrics');
    if (nextChannel !== 'clear') assert.equal(after.channels[nextChannel].on, true);
  }
});

test('independent badge changes preserve delayed lyric handoff', async (t) => {
  const origin = await runningConcert(t);
  await request(origin, '/api/command', { channel: 'announce', action: 'on' });
  const state = await request(origin, '/api/state');
  await request(origin, '/api/event', {
    type: 'media-ended',
    channel: 'announce',
    playbackId: state.channels.announce.playbackId,
  });
  await request(origin, '/api/command', { channel: 'badge', action: 'on' });
  await new Promise((resolve) => setTimeout(resolve, 400));
  const after = await request(origin, '/api/state');
  assert.equal(after.channels.badge.on, true);
  assert.equal(after.channels.lyric.on, true);
  assert.equal(after.channels.announce.on, false);
});
