'use strict';

const { assertObject } = require('../../core/state-store');

const types = ['title', 'lyrics', 'rank', 'guest', 'contestant', 'award', 'bug', 'finaleCast'];
const theme = 'finale50';
const legacyThemes = new Set(['gold', 'ink', 'campus', 'campus50', 'arena', 'archive', 'collage']);
const fits = ['cover', 'contain'];
const imageRef = /^[a-f\d]{32}\.(?:png|jpe?g|webp)$/i;
const limits = {
  show: 30,
  title: 100,
  name: 100,
  subtitle: 160,
  credits: 500,
  number: 14,
  lyrics: 200,
  lyric2: 200,
};
function concertDefaults() {
  return {
    type: 'title',
    theme,
    show: '深秋歌会',
    title: '',
    name: '',
    subtitle: '',
    credits: '',
    number: '',
    lyrics: '',
    lyric2: '',
    ranks: [],
    full: true,
    portraitAsset: '',
    mainAsset: '',
    mainFit: 'contain',
    mainEnabled: false,
  };
}
function fields(value, allowed) {
  assertObject(value);
  if (Object.keys(value).some((key) => !allowed.has(key))) throw Error('未知的歌会包装设置项');
}
function string(value, limit) {
  if (typeof value !== 'string' || value.length > limit) throw Error('歌会文字过长或格式无效');
  return value.trim();
}
function image(value) {
  value = string(value, 42);
  if (value && !imageRef.test(value)) throw Error('主视图或人像素材须为 PNG、JPG 或 WebP');
  return value;
}
const draftKeys = new Set(Object.keys(concertDefaults()));
const rankKeys = new Set(['name', 'score']);
function reduceConcert(current, patch) {
  fields(patch, draftKeys);
  const next = { ...current };
  for (const [key, limit] of Object.entries(limits))
    if (Object.hasOwn(patch, key)) next[key] = string(patch[key], limit);
  for (const [key, options] of [
    ['type', types], ['theme', [theme]], ['mainFit', fits],
  ])
    if (Object.hasOwn(patch, key)) {
      if (!options.includes(patch[key])) throw Error('歌会包装类型、主题或主视图适配无效');
      next[key] = patch[key];
    }
  for (const key of ['portraitAsset', 'mainAsset'])
    if (Object.hasOwn(patch, key)) next[key] = image(patch[key]);
  for (const key of ['full', 'mainEnabled'])
    if (Object.hasOwn(patch, key)) {
      if (typeof patch[key] !== 'boolean') throw Error('歌会包装开关无效');
      next[key] = patch[key];
    }
  if (Object.hasOwn(patch, 'ranks')) {
    if (!Array.isArray(patch.ranks) || patch.ranks.length > 8)
      throw Error('歌会名次最多八项');
    next.ranks = patch.ranks.map((row) => {
      fields(row, rankKeys);
      const name = string(row.name, 50);
      if (!name) throw Error('请填写名次对应的选手姓名');
      return { name, score: string(row.score ?? '', 32) };
    });
  }
  return next;
}
function migrateConcertDraft(draft) {
  assertObject(draft);
  return legacyThemes.has(draft.theme) ? { ...draft, theme } : draft;
}
function savedConcert(value) {
  assertObject(value);
  const { at, ...draft } = value;
  if (!Number.isSafeInteger(at) || at < 0) throw Error('歌会播出时间无效');
  return { ...onAirConcert(reduceConcert(concertDefaults(), migrateConcertDraft(draft))), at: 0 };
}
function onAirConcert(cue) {
  if (cue.type === 'bug' || cue.type === 'lyrics') return { ...cue, full: false, mainEnabled: false };
  return cue.full ? cue : { ...cue, mainEnabled: false };
}
function takeConcert(state, now) {
  const cue = onAirConcert(state.concert);
  if (cue.mainEnabled && !cue.mainAsset) throw Error('请先导入并选择主视图');
  if (cue.type === 'rank' && !cue.ranks.length) throw Error('请至少填写一项名次');
  if (cue.type === 'finaleCast' && (cue.ranks.length < 1 || cue.ranks.length > 6))
    throw Error('六强阵容需要填写 1–6 位选手');
  if (cue.type === 'award' && !cue.name) throw Error('请先填写人气奖获奖者姓名');
  if (['contestant', 'guest'].includes(cue.type) && !cue.name) throw Error('请先填写人物姓名');
  if (cue.type === 'bug' && !cue.show && !cue.title) throw Error('请填写角标文字');
  return {
    ...state,
    concertLive: { ...cue, ranks: cue.ranks.map((row) => ({ ...row })), at: now },
  };
}

module.exports = { concertDefaults, reduceConcert, migrateConcertDraft, savedConcert, takeConcert };
