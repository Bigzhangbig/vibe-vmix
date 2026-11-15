'use strict';
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { runInNewContext } = require('node:vm');
const test = require('node:test');
const { createStageModule } = require('../modules/stage');

const change = (stage, state, id, payload = {}, at = 100) =>
  stage.reduce(state, { _command: id, payload }, at);

test('corner bug has an independent validated, persisted snapshot and a true all-clear', () => {
  const stage = createStageModule();
  let state = stage.migrate({});
  assert.equal(state.concertBug, null);
  assert.throws(() => stage.reduce(state, { concertBug: null }), /未知/);
  assert.throws(() => change(stage, state, 'stage.setConcertBug', { visible: 1 }), /开关/);
  assert.throws(() => change(stage, state, 'stage.setConcertBug', { visible: true, show: 'X'.repeat(31) }), /格式/);
  assert.throws(() => change(stage, state, 'stage.setConcertBug', { visible: true, theme: 'gold' }), /未知/);

  state = stage.reduce(state, { concert: { show: '歌会定稿' } });
  state = change(stage, state, 'stage.setConcertBug', { visible: true, title: '总决赛' }, 100);
  assert.deepEqual(state.concertBug, {
    at: 100, full: false, show: '歌会定稿', theme: 'finale50', title: '总决赛', type: 'bug',
  });
  assert.deepEqual(stage.status(state).concertBug, state.concertBug);
  const liveBug = state.concertBug;
  state = stage.reduce(state, { concert: { show: '草稿名称', type: 'lyrics', lyrics: '心里有光' } });
  assert.equal(change(stage, state, 'stage.setConcertBug', { visible: true }, 200), state);
  state = change(stage, state, 'concert.take');
  assert.equal(state.concertLive.type, 'lyrics');
  assert.equal(state.concertBug, liveBug);
  state = change(stage, state, 'concert.hide');
  assert.equal(state.concertLive, null);
  assert.equal(state.concertBug, liveBug);

  const restored = stage.migrate(state);
  assert.deepEqual(restored.concertBug, { ...liveBug, at: 0 });
  assert.throws(() => stage.migrate({ ...state, concertBug: { ...liveBug, full: true } }), /数据无效/);
  assert.equal(change(stage, restored, 'stage.setConcertBug', { visible: false }).concertBug, null);
  assert.equal(change(stage, restored, 'all.hide').concertBug, null);
  assert.equal(change(stage, restored, 'stage.setConcertBug', { visible: true, show: '正式赛', title: '' }).concertBug.show, '正式赛');
});

test('PGM placement passes through the cue and the independent bug animation stops on clear', () => {
  const draw = [];
  const pending = new Map();
  const canvas = {
    id: 'concertBugOutput', width: 1920, height: 1080,
    getContext: () => ({clearRect: (...coords) => draw.push({clear: coords})}),
  };
  let stamp = 1000, ticket = 0;
  const mainCanvas = { ...canvas, id: 'concertOutput' };
  const outputs = { concertOutput: mainCanvas, concertBugOutput: canvas };
  const context = {
    URLSearchParams, location: {search:''}, window: {addEventListener(){}},
    document: {referrer: '', getElementById(id) { assert.ok(outputs[id]); return outputs[id]; }},
    matchMedia: () => ({matches:false}), fetch: () => new Promise(() => {}),
    requestAnimationFrame(fn) { pending.set(++ticket, fn); return ticket; },
    cancelAnimationFrame(id) { pending.delete(id); },
    Date: {now: () => stamp},
    StageGraphics: {
      ready: () => new Promise(() => {}),
      render(target, cue, opts) { draw.push({target, cue, ...opts}); },
    },
  };
  runInNewContext(readFileSync(join(__dirname,'../ui/stage/graphics.js'),'utf8'), context);
  const cue = {type:'bug',theme:'finale50', show:'歌会',title:'',full:false,at:stamp};
  context.renderConcertBug(cue, true);
  assert.equal(draw.length, 1);
  assert.equal(draw[0].target, canvas);
  assert.equal(draw[0].alpha, undefined);
  assert.equal(draw[0].time, 0);
  const first = pending.get(ticket);
  pending.delete(ticket);
  stamp += 40;
  first();
  assert.equal(draw[1].time, .04);
  context.renderConcertBug({...cue}, true);
  assert.equal(draw.length, 2);
  context.renderConcertBug(null, true);
  assert.deepEqual(draw[2].clear, [0,0,1920,1080]);
  assert.equal(pending.size, 0);
  context.renderConcertBug(cue, false);
  assert.equal(draw[3].time, 2.5);
  assert.equal(pending.size, 0);

  for (const full of [true, false]) {
    const card = {type:'title', theme:'finale50', full, at:0};
    context.renderConcert(card, false);
    const frame = draw.at(-1);
    assert.equal(frame.target, mainCanvas);
    assert.equal(frame.cue.full, full);
    assert.equal(frame.alpha, undefined);
    assert.equal(frame.time, 2.5);
  }
});
