'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createStageModule } = require('../modules/stage');

const stage = createStageModule();
const picture = '7830d47b02814d278e79145bfb2416ae.png';
const command = (state, id, now = 100) => stage.reduce(state, { _command: id, payload: {} }, now);

test('old state migrates to an empty PGM; validates main visual and live snapshot boundaries', () => {
  let state = stage.migrate({ version: 1, eventName: '北理工' });
  assert.equal(state.eventName, '北理工');
  assert.equal(state.concertLive, null);
  assert.equal(state.concert.mainEnabled, false);
  assert.throws(() => stage.reduce(state, { concertLive: { title: '不可写' } }));
  assert.throws(() => stage.reduce(state, { concert: { mainAsset: '../scoreboard.png' } }));
  assert.throws(() => stage.reduce(state, { concert: { mainAsset: picture.replace('png', 'aep') } }));
  assert.throws(() => stage.reduce(state, { concert: { mainFit: 'stretch' } }));
  state = stage.reduce(state, { concert: { mainEnabled: true } });
  assert.throws(() => command(state, 'concert.take'), /导入并选择/);
  state = stage.reduce(state, {
    concert: {
      title: '深秋歌会',
      mainAsset: picture,
      portraitAsset: picture,
      mainFit: 'contain',
      theme: 'finale50',
      full: true,
    },
  });
  state = command(state, 'concert.take');
  assert.equal(state.concertLive.at, 100);
  assert.equal(state.concertLive.mainAsset, picture);
  assert.equal(state.concertLive.mainFit, 'contain');
  assert.equal(state.concertLive.full, true);
  state = stage.reduce(state, { concert: { title: '下一条', mainEnabled: false } });
  assert.equal(state.concert.title, '下一条');
  assert.equal(state.concertLive.title, '深秋歌会');
  assert.equal(state.concertLive.mainEnabled, true);
  const restored = stage.migrate(state);
  assert.equal(restored.concertLive.title, '深秋歌会');
  assert.equal(restored.concertLive.at, 0);
  assert.equal(command(restored, 'concert.hide').concertLive, null);
  state = command(state, 'all.hide');
  assert.equal(state.concertLive, null);
  assert.equal(state.concert.title, '下一条');
  assert(Object.values(state.layers).every((enabled) => !enabled));
});

test('concert validates rank, guest and contestant cards without changing native caption controls', () => {
  let state = stage.migrate({});
  state = stage.reduce(state, { concert: { type: 'rank' } });
  assert.throws(() => command(state, 'concert.take'), /填写一项名次/);
  assert.throws(() => stage.reduce(state, { concert: { ranks: [{ name: '', score: '98' }] } }));
  state = stage.reduce(state, { concert: { ranks: [{ name: '选手一', score: '98' }] } });
  state = command(state, 'concert.take');
  const original = state.concertLive.ranks;
  state = stage.reduce(state, { concert: { ranks: [{ name: '选手二', score: '96' }] } });
  assert.deepEqual(state.concertLive.ranks, original);
  state = stage.reduce(state, { concert: { type: 'guest' } });
  assert.throws(() => command(state, 'concert.take'), /人物姓名/);
  state = stage.reduce(state, { concert: { name: '来宾', type: 'contestant' } });
  assert.equal(command(state, 'concert.take').concertLive.name, '来宾');
  state = stage.reduce(state, {
    programs: [{ id: 'foo', type: '歌唱', title: 'Foo', caption: '第一行\n第二行' }],
    concert: { type: 'lyrics', lyrics: '', full: true, mainEnabled: true, mainAsset: picture },
  });
  state = stage.reduce(state, { _command: 'caption.take', payload: { programId: 'foo', index: 0 } }, 1);
  state = command(state, 'concert.take');
  assert.equal(state.concertLive.type, 'lyrics');
  assert.equal(state.concertLive.full, false);
  assert.equal(state.concertLive.mainEnabled, false);
  assert.equal(state.captionLive.index, 0);
  state = stage.reduce(state, { _command: 'caption.next', payload: { programId: 'foo' } }, 2);
  assert.equal(state.captionLive.index, 1);
  assert.equal(state.concertLive.type, 'lyrics');
});

test('only finale50 is selectable, with a transparent centered layout and legacy theme migration', () => {
  const defaults = stage.migrate({});
  assert.equal(defaults.concert.theme, 'finale50');
  assert.equal(defaults.concert.full, true);
  for (const theme of ['gold', 'ink', 'campus', 'campus50', 'arena', 'archive', 'collage']) {
    assert.throws(() => stage.reduce(defaults, { concert: { theme } }), /主题或/);
    const saved = stage.migrate({
      concert: { theme, full: false, show: '旧档', mainEnabled: true, mainAsset: picture },
      concertLive: { theme, full: true, title: '旧节目', at: 100 },
    });
    assert.equal(saved.concert.theme, 'finale50');
    assert.equal(saved.concert.full, false);
    assert.equal(saved.concert.show, '旧档');
    assert.equal(saved.concertLive.theme, 'finale50');
    assert.equal(saved.concertLive.full, true);
    assert.equal(saved.concertLive.title, '旧节目');
    const next = command(saved, 'concert.take');
    assert.equal(next.concert.mainEnabled, true);
    assert.equal(next.concertLive.mainEnabled, false);
    assert.equal(next.concertLive.mainAsset, picture);
  }
  assert.throws(() => stage.reduce(defaults, { concert: { theme: 'unavailable' } }), /主题或/);
});

test('finale scenes validate award and cast data; corner bug is always transparent', () => {
  let state = stage.migrate({});
  state = stage.reduce(state, { concert: { type: 'award', theme: 'finale50' } });
  assert.throws(() => command(state, 'concert.take'), /获奖者姓名/);
  state = stage.reduce(state, { concert: { name: '林知秋', subtitle: '432 票' } });
  state = command(state, 'concert.take');
  assert.equal(state.concertLive.type, 'award');
  assert.equal(stage.migrate(state).concertLive.subtitle, '432 票');

  state = stage.reduce(state, {
    concert: { type: 'bug', full: true, mainEnabled: true, show: '', title: '' },
  });
  assert.throws(() => command(state, 'concert.take'), /角标文字/);
  state = stage.reduce(state, { concert: { show: '深秋歌会' } });
  state = command(state, 'concert.take');
  assert.equal(state.concert.full, true);
  assert.equal(state.concert.mainEnabled, true);
  assert.equal(state.concertLive.full, false);
  assert.equal(state.concertLive.mainEnabled, false);
  assert.equal(stage.migrate(state).concertLive.type, 'bug');

  state = stage.reduce(state, {
    concert: { type: 'finaleCast', mainEnabled: false, ranks: [] },
  });
  assert.throws(() => command(state, 'concert.take'), /1–6 位/);
  const names = Array.from({ length: 7 }, (_, i) => ({ name: '选手 ' + (i + 1), score: '曲目' }));
  state = stage.reduce(state, { concert: { ranks: names } });
  assert.throws(() => command(state, 'concert.take'), /1–6 位/);
  state = stage.reduce(state, { concert: { ranks: names.slice(0, 6) } });
  state = command(state, 'concert.take');
  assert.equal(state.concertLive.ranks.length, 6);
  assert.deepEqual(stage.migrate(state).concertLive.ranks, names.slice(0, 6));
});
