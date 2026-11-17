'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createConcertServer } = require('../server/concert-server');
const { listenLocal, closeLocal } = require('../server/listen-local');
async function setup(t, state) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'concert-layout-'));
  if (state) fs.writeFileSync(path.join(directory, 'state.json'), JSON.stringify(state));
  const server = createConcertServer({ dataDirectory: directory });
  t.after(async () => {
    await closeLocal(server);
    fs.rmSync(directory, { recursive: true, force: true });
  });
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
  return { api, directory, server };
}
test('defaults and two announcement presets retain other channels and custom typography', async (t) => {
  const { api } = await setup(t);
  const initial = await api();
  assert.deepEqual(initial.layout.badge, { x: 1260, y: 620, w: 864, h: 486 });
  assert.deepEqual(initial.layout.lyricBg, { x: -210, y: 710, w: 768, h: 432 });
  assert.equal(initial.announcePlacement, 'lower-left');
  await api('/api/layout', { id: 'announceText', color: '#123456', font: 'Custom Font' });
  let preset = await api('/api/layout/preset', { placement: 'center' });
  assert.equal(preset.announcePlacement, 'center');
  assert.deepEqual(preset.layout.announceBg, { x: 166, y: -480, w: 2496, h: 1404 });
  assert.equal(preset.layout.announceText.x, 595);
  assert.equal(preset.layout.announceText.size, 62);
  assert.equal(preset.layout.announceText.color, '#123456');
  assert.equal(preset.layout.announceText.font, 'Custom Font');
  assert.deepEqual(preset.layout.badge, initial.layout.badge);
  assert.deepEqual(preset.layout.lyricText, initial.layout.lyricText);
  const before = await api();
  await api('/api/layout/preset', { placement: 'unknown' }, 400);
  const after = await api();
  assert.deepEqual(after.layout, before.layout);
  assert.equal(after.tick, before.tick);
  preset = await api('/api/layout/preset', { placement: 'lower-left' });
  assert.deepEqual(preset.layout.announceBg, initial.layout.announceBg);
  assert.equal(preset.layout.announceText.size, 46);
  await api('/api/layout', { id: 'announceText', x: 444 });
  assert.equal((await api()).announcePlacement, 'custom');
  await api('/api/layout/reset', {});
  assert.deepEqual((await api()).layout, initial.layout);
  assert.equal((await api()).announcePlacement, 'lower-left');
});
test('v3 migration retains edits, persists v4 and preserves its layout across restart', async (t) => {
  const { api, directory, server } = await setup(t, {
    layoutVersion: 3,
    layout: {
      badge: { x: 0, y: 0, w: 1920, h: 1080 },
      lyricText: {
        x: 510,
        y: 700,
        w: 900,
        h: 210,
        size: 60,
        color: '#123456',
        font: 'Custom Font',
      },
      announceText: { x: 444, y: 650, w: 550, h: 270, size: 80 },
      announceBg: { x: 0, y: 0, w: 1920, h: 1080, scale: 0.5 },
    },
  });
  const state = await api();
  assert.equal(state.layout.badge.x, 1260);
  assert.equal(state.layout.lyricText.x, 270);
  assert.equal(state.layout.lyricText.size, 52);
  assert.equal(state.layout.lyricText.color, '#123456');
  assert.equal(state.layout.lyricText.font, 'Custom Font');
  assert.equal(state.layout.announceText.x, 444);
  assert.equal(state.layout.announceText.y, 650);
  assert.equal(state.layout.announceText.size, 80);
  assert.equal(state.layout.announceBg.scale, 0.5);
  assert.equal(state.announcePlacement, 'custom');
  assert.equal(JSON.parse(fs.readFileSync(path.join(directory, 'state.json'))).layoutVersion, 4);
  await closeLocal(server);
  const restart = createConcertServer({ dataDirectory: directory });
  const url = await listenLocal(restart);
  try {
    assert.deepEqual((await (await fetch(url + '/api/state')).json()).layout, state.layout);
  } finally {
    await closeLocal(restart);
  }
});

test('measured alpha content fits broadcast safe areas in both announcement placements', async (t) => {
  const { api } = await setup(t);
  function bounds(rect, source) {
    return {
      left: rect.x + (source[0] * rect.w) / 1920,
      top: rect.y + (source[1] * rect.h) / 1080,
      right: rect.x + (source[2] * rect.w) / 1920,
      bottom: rect.y + (source[3] * rect.h) / 1080,
    };
  }
  const initial = await api();
  const badge = bounds(initial.layout.badge, [450, 450, 1224, 786]);
  assert(badge.left > 1400 && badge.top > 780 && badge.right < 1872 && badge.bottom < 1032);
  const lyric = bounds(initial.layout.lyricBg, [702, 282, 1134, 642]);
  assert(lyric.left > 48 && lyric.top > 780 && lyric.right < 280 && lyric.bottom < 1032);
  assert(lyric.right < initial.layout.lyricText.x);
  for (const placement of ['lower-left', 'center']) {
    const { layout } = await api('/api/layout/preset', { placement });
    const card = bounds(layout.announceBg, [320, 631, 903, 940]);
    const text = layout.announceText;
    assert(
      text.x >= card.left &&
        text.y >= card.top &&
        text.x + text.w <= card.right &&
        text.y + text.h <= card.bottom,
    );
    const x = (card.left + card.right) / 2,
      y = (card.top + card.bottom) / 2;
    if (placement === 'center') assert(Math.abs(x - 960) < 10 && Math.abs(y - 540) < 10);
    else assert(x < 600 && y > 700);
  }
});

for (const edit of ['text-position', 'background-scale']) {
  test('v3 preserves the complete announcement geometry group for ' + edit, async (t) => {
    const bg = { x: 0, y: 0, w: 1920, h: 1080 };
    const text = { x: 330, y: 650, w: 550, h: 270, size: 52 };
    if (edit === 'text-position') text.x = 444;
    else bg.scale = 0.5;
    const { api } = await setup(t, {
      layoutVersion: 3,
      layout: { announceBg: bg, announceText: text },
    });
    const { layout } = await api();
    assert.deepEqual(layout.announceBg, bg);
    for (const [key, value] of Object.entries(text)) assert.equal(layout.announceText[key], value);
    assert.equal(layout.badge.x, 1260);
  });
}
