'use strict';
const $ = (id) => document.getElementById(id);
const preview = new URLSearchParams(location.search).has('preview');
const workspacePreview = new URLSearchParams(location.search).get('workspacePreview') === '1';
const workspaceOrigin = document.referrer ? new URL(document.referrer).origin : '';
let latestState,
  draftStyle = {},
  previewPresentation = { mode: 'live', only: '', hidden: [] };
if (workspacePreview)
  window.addEventListener('message', (event) => {
    if (
      event.source !== parent ||
      event.origin !== workspaceOrigin ||
      event.data?.type !== 'preview-layout' ||
      event.data.module !== 'stage'
    )
      return;
    draftStyle = event.data.layout || {};
    previewPresentation = event.data.presentation || { mode: 'live', only: '', hidden: [] };
    if (latestState) render(latestState);
  });
if (preview) document.body.classList.add('preview');
let etag = '',
  templates,
  cue = null,
  transitionTimer,
  animation,
  captionAnimation;
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
function setText(id, value) {
  $(id).textContent = value || '';
}
function stopTransition() {
  clearTimeout(transitionTimer);
  animation?.cancel();
  animation = null;
  const video = $('transitionVideo');
  video.pause();
  video.removeAttribute('src');
  video.load();
  video.style.display = 'none';
  $('transition').classList.remove('playing');
}
function transition(state) {
  const value = state.transition;
  if (cue === value.cue) return;
  const first = cue === null;
  cue = value.cue;
  const elapsed = Date.now() - value.at;
  if ((first && !value.at) || elapsed < 0 || elapsed >= value.duration) return;
  stopTransition();
  $('transition').classList.add('playing');
  const remaining = value.duration - elapsed;
  if (state.transitionAsset && /\.(webm|mp4)$/i.test(state.transitionAsset)) {
    const video = $('transitionVideo');
    video.src = '/assets/' + state.transitionAsset;
    video.style.display = 'block';
    video.onloadedmetadata = () => {
      if (Number.isFinite(video.duration))
        video.currentTime = Math.min(elapsed / 1000, Math.max(0, video.duration - 0.05));
      video.play().catch(stopTransition);
    };
    video.onerror = stopTransition;
  } else if (state.style.motion && !reduced) {
    animation = $('wipe').animate(
      [
        { transform: 'translateX(-110%)', offset: 0 },
        { transform: 'translateX(0)', offset: 0.35 },
        { transform: 'translateX(0)', offset: 0.65 },
        { transform: 'translateX(110%)', offset: 1 },
      ],
      { duration: value.duration, easing: 'cubic-bezier(.25,.1,.25,1)' },
    );
    animation.currentTime = elapsed;
  } else {
    $('wipe').style.transform = 'translateX(0)';
  }
  transitionTimer = setTimeout(() => {
    stopTransition();
    $('wipe').style.transform = '';
  }, remaining);
}
function renderCaption(state) {
  const active = state.captionLive;
  const content = active ? StageCaptions.lines(active.caption)[active.index] || '' : '';
  const element = $('caption');
  const text = $('captionText');
  const visible = Boolean(state.layers.caption && content);
  if (text.textContent !== content) {
    const switching =
      visible && element.classList.contains('visible') && state.style.motion && !reduced;
    captionAnimation?.cancel();
    text.textContent = content;
    if (switching)
      captionAnimation = text.animate([{ opacity: 0.35 }, { opacity: 1 }], {
        duration: 150,
        easing: 'cubic-bezier(0.23, 1, 0.32, 1)',
      });
  }
  element.classList.toggle('visible', visible);
}
let concertFrame = 0;
let concertKey = null;
let concertRenderGeneration = 0;
let concertStarted = 0;
function clearConcert() {
  concertRenderGeneration++;
  concertKey = null;
  cancelAnimationFrame(concertFrame);
  const canvas = $('concertOutput');
  canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);
}
function renderConcert(cue, motion) {
  if (!cue) {
    if (concertKey !== null) clearConcert();
    return;
  }
  const signature = JSON.stringify([cue, motion]);
  if (signature === concertKey) return;
  const isNew = concertKey === null || concertStarted !== cue.at;
  concertKey = signature;
  concertStarted = cue.at;
  const generation = ++concertRenderGeneration;
  const canvas = $('concertOutput');
  const reducedMotion = !motion || reduced || !isNew;
  function frame() {
    if (generation !== concertRenderGeneration) return;
    const elapsed = !cue.at || reducedMotion ? 2.5 : Math.max(0, (Date.now() - cue.at) / 1000);
    // Placement lives in the cue. Both centered and lower-left templates retain alpha.
    StageGraphics.render(canvas, cue, { time: elapsed });
    if (elapsed < 2.4) concertFrame = requestAnimationFrame(frame);
  }
  cancelAnimationFrame(concertFrame);
  frame();
  StageGraphics.ready(cue).then(() => {
    if (generation !== concertRenderGeneration) return;
    cancelAnimationFrame(concertFrame);
    frame();
  });
}
let bugFrame = 0;
let bugKey = null;
function clearConcertBug() {
  cancelAnimationFrame(bugFrame);
  bugFrame = 0;
  bugKey = null;
  const canvas = $('concertBugOutput');
  canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);
}
function renderConcertBug(bug, motion) {
  if (!bug) {
    if (bugKey !== null) clearConcertBug();
    return;
  }
  const signature = JSON.stringify([bug, motion]);
  if (signature === bugKey) return;
  cancelAnimationFrame(bugFrame);
  bugKey = signature;
  const canvas = $('concertBugOutput');
  const moving = motion && !reduced;
  const started = bug.at || Date.now() - 2500;
  let painted = -Infinity;
  function frame() {
    if (bugKey !== signature) return;
    const now = Date.now();
    if (now - painted >= 30) {
      StageGraphics.render(canvas, bug, {
        time: moving ? Math.max(0, now - started) / 1000 : 2.5,
      });
      painted = now;
    }
    if (moving) bugFrame = requestAnimationFrame(frame);
  }
  frame();
}
function stageConcert(state) {
  if (workspacePreview) {
    const { only, hidden = [] } = previewPresentation;
    if ((only && only !== 'concert') || hidden.includes('concert')) return null;
  }
  const cue = state.concertLive;
  if (!cue) return null;
  if (cue.type !== 'lyrics' || cue.lyrics) return cue;
  const active = state.captionLive;
  return {
    ...cue,
    lyrics: active && state.layers.caption ? StageCaptions.lines(active.caption)[active.index] : '',
  };
}
function render(state) {
  latestState = state;
  if (workspacePreview) state = { ...state, style: { ...state.style, ...draftStyle } };
  if (workspacePreview) {
    const config = previewPresentation,
      layers = { ...state.layers };
    const layout = config.mode === 'layout';
    for (const key of ['channel', 'event', 'sponsor', 'lower', 'caption'])
      layers[key] =
        (layout || layers[key]) &&
        (!config.only || config.only === key) &&
        !(config.hidden || []).includes(key);
    state = { ...state, layers };
    if (layout) {
      const item = state.live || state.programs[0];
      state = {
        ...state,
        channelName: state.channelName || '台标',
        eventName: state.eventName || '活动名称',
        sponsorName: state.sponsorName || '赞助商',
        live: item?.title
          ? item
          : {
              type: '歌唱',
              title: '节目名称',
              performer: '表演者',
              subtitle: '排版预览示例',
            },
        captionLive: state.captionLive || {
          caption: item?.caption || '歌词字幕 · 排版预览示例',
          index: 0,
        },
      };
    }
  }
  const activeConcert = stageConcert(state);
  renderConcert(activeConcert, state.style.motion);
  const { only, hidden = [], mode } = previewPresentation;
  const canShowBug =
    !workspacePreview ||
    (mode !== 'layout' && (!only || only === 'concert') && !hidden.includes('concert'));
  renderConcertBug(
    canShowBug && activeConcert?.type !== 'bug' ? state.concertBug : null,
    state.style.motion,
  );
  // A newer concert card replaces the generic stage lower third, but native logos can coexist.
  if (activeConcert && !['lyrics', 'bug'].includes(activeConcert.type))
    state = { ...state, layers: { ...state.layers, lower: false } };
  if (activeConcert?.type === 'lyrics')
    state = { ...state, layers: { ...state.layers, caption: false } };
  const template = templates.find((item) => item.id === state.templateId) || templates[0];
  const style = state.style,
    root = $('canvas');
  root.dataset.template = template.id;
  root.classList.toggle('no-motion', !style.motion);
  for (const key of ['accent', 'background', 'foreground'])
    root.style.setProperty('--' + key, style[key] || template[key]);
  root.style.setProperty('--font', style.font === 'template' ? template.font : style.font);
  root.style.setProperty('--title-size', style.fontSize + 'px');
  root.style.setProperty('--logo-size', style.logoSize + 'px');
  for (const key of ['channel', 'event', 'sponsor']) {
    const element = $(key),
      image = element.querySelector('img'),
      src = state[key + 'Asset'] ? '/assets/' + state[key + 'Asset'] : '';
    if (src && image.getAttribute('src') !== src) image.src = src;
    else if (!src) image.removeAttribute('src');
    element.querySelector('span').textContent = state[key === 'event' ? 'eventName' : key + 'Name'];
    element.style.left = style[key + 'X'] + 'px';
    element.style.top = style[key + 'Y'] + 'px';
    element.classList.toggle('visible', state.layers[key]);
  }
  $('lower').style.left = style.lowerX + 'px';
  $('lower').style.top = style.lowerY + 'px';
  $('lower').style.width = style.lowerWidth + 'px';
  $('caption').style.left = style.captionX + 'px';
  $('caption').style.top = style.captionY + 'px';
  $('caption').style.bottom = 'auto';
  setText('eventName', state.eventName);
  setText('type', state.live?.type);
  setText('title', state.live?.title);
  setText('subtitle', [state.live?.performer, state.live?.subtitle].filter(Boolean).join(' · '));
  renderCaption(state);
  $('lower').classList.toggle('visible', Boolean(state.layers.lower && state.live));
  if (
    !activeConcert &&
    !state.concertBug &&
    !Object.values(state.layers).some(Boolean) &&
    cue !== null &&
    state.transition.cue === cue
  )
    stopTransition();
  transition(state);
  if (workspacePreview && workspaceOrigin && parent !== window) {
    const boxes = {};
    for (const key of ['channel', 'event', 'sponsor', 'lower', 'caption']) {
      const rect = $(key).getBoundingClientRect();
      boxes[key] = { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    }
    parent.postMessage({ type: 'preview-geometry', module: 'stage', boxes }, workspaceOrigin);
  }
}
async function poll() {
  try {
    const response = await fetch('/api/v1/state', {
      cache: 'no-store',
      headers: etag ? { 'If-None-Match': etag } : {},
    });
    if (response.ok) {
      const state = await response.json();
      etag = response.headers.get('ETag');
      render(state);
    } else if (response.status !== 304) throw Error('模块不可用');
  } catch (_) {
    // A stopped module must not leave stale graphics frozen on air.
    document.querySelectorAll('.layer').forEach((element) => element.classList.remove('visible'));
    stopTransition();
    clearConcert();
    clearConcertBug();
    etag = '';
  }
  setTimeout(poll, preview && document.hidden ? 2000 : 300);
}
fetch('/api/stage/templates')
  .then((response) => response.json())
  .then((body) => {
    templates = body.templates;
    poll();
  });
window.addEventListener('pagehide', () => {
  stopTransition();
  clearConcert();
  clearConcertBug();
  etag = '';
});
