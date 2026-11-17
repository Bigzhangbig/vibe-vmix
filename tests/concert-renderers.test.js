'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createRendererRegistry } = require('../server/concert-renderers');

test('only fresh output heartbeats count and a refreshed page replaces its expired identity', () => {
  let time = 1000;
  const registry = createRendererRegistry({ now: () => time });
  assert.deepEqual(registry.snapshot().outputs, []);
  const body = {
    id: 'output-a', width: 1920, height: 1080,
    media: [{ channel: 'announce', file: '报幕1.webm', readyState: 2, paused: false, on: true, error: '' }],
  };
  registry.report(body);
  assert.equal(registry.snapshot().outputs[0].media[0].readyState, 2);
  body.media[0].error = 'changed outside registry';
  assert.equal(registry.snapshot().outputs[0].media[0].error, '');
  time += 14000;
  assert.equal(registry.snapshot().outputs.length, 1);
  time += 1001;
  registry.report({ ...body, id: 'output-b' });
  assert.deepEqual(registry.snapshot().outputs.map((output) => output.id), ['output-b']);
});

test('bad output reports cannot replace a healthy report or create partial diagnostics', () => {
  const registry = createRendererRegistry();
  const good = { id: 'output', width: 1920, height: 1080, media: [] };
  registry.report(good);
  for (const invalid of [null, {}, { ...good, width: 0 }, {
    ...good, media: [{ channel: 'announce', readyState: 7 }],
  }, { ...good, media: [{ channel: 'unknown', readyState: 2 }] }]) {
    assert.throws(() => registry.report(invalid));
  }
  assert.equal(registry.snapshot().outputs.length, 1);
  assert.deepEqual(registry.snapshot().outputs[0].media, []);
});
