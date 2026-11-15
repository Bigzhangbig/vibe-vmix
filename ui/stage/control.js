'use strict';
const $ = (id) => document.getElementById(id);
const fields = [
  'programType',
  'programTitle',
  'programPerformer',
  'programSubtitle',
  'programCaption',
];
const layerLabels = {
  channel: '台标',
  event: '活动 Logo',
  sponsor: '赞助商',
  lower: '节目字幕条',
  caption: '字幕内容',
};
const numericStyles = ['fontSize', 'transitionMs'];
let state,
  templates = [],
  assets = [],
  selected = '',
  dirty = false,
  designDirty = false,
  etag = '',
  writing = false,
  jobTimer,
  formSignature = '';
function notice(message = '') {
  $('notice').textContent = message;
}
async function api(url, payload) {
  const response = await fetch(
    url,
    payload === undefined
      ? { cache: 'no-store' }
      : {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        },
  );
  const body = await response.json();
  if (!response.ok || body.ok === false) throw Error(body.error || '请求失败');
  return body;
}
async function read() {
  const response = await fetch('/api/v1/state', {
    cache: 'no-store',
    headers: etag ? { 'If-None-Match': etag } : {},
  });
  if (response.status === 304) return;
  if (!response.ok) throw Error('读取舞台状态失败');
  state = await response.json();
  etag = response.headers.get('ETag') || '';
  renderState();
}
async function write(patch) {
  if (writing) throw Error('正在保存，请稍后再操作');
  writing = true;
  try {
    await api('/api/v1/state', patch);
    etag = '';
    await read();
  } finally {
    writing = false;
  }
}
async function command(id, payload = {}) {
  await api('/api/v1/commands/' + id, payload);
  etag = '';
  await read();
}
function run(action) {
  return async (event) => {
    event?.preventDefault();
    notice();
    try {
      await action(event);
    } catch (error) {
      notice(error.message);
    }
  };
}
function markDirty() {
  dirty = true;
  $('draftState').textContent = '有未保存修改';
  renderCaptions();
}
function fillProgram() {
  const item = state.programs.find((program) => program.id === selected);
  $('programForm')
    .querySelectorAll('input,select,textarea,button')
    .forEach((input) => {
      input.disabled = !item;
    });
  const values = [
    item?.type || '歌唱',
    item?.title || '',
    item?.performer || '',
    item?.subtitle || '',
    item?.caption || '',
  ];
  fields.forEach((id, index) => {
    $(id).value = values[index];
  });
  formSignature = JSON.stringify(item || null);
  dirty = false;
  $('draftState').textContent = '';
  renderCaptions();
}
function renderCaptions() {
  if (!state) return;
  const item = state.programs.find((program) => program.id === selected);
  const entries = StageCaptions.lines($('programCaption').value);
  const active = state.captionLive;
  const sameProgram = Boolean(item && active?.programId === item.id);
  const sameLyrics = Boolean(sameProgram && active.caption === item.caption && !dirty);
  $('captionCount').textContent = entries.length + ' 句';
  $('captionHint').textContent = !item
    ? '先添加节目，再录入歌词或字幕。'
    : dirty
      ? '保存节目后，可以逐句播出。'
      : !entries.length
        ? '在上方输入歌词，每行一句。'
        : sameProgram && !sameLyrics
          ? '字幕已修改，请点选一句播出新内容。'
          : sameLyrics
            ? (state.layers.caption ? '正在播出第 ' : '已下屏，当前为第 ') +
              (active.index + 1) +
              ' 句。'
            : '点选任意一句，或从第一句开始播出。';
  $('captionPrevious').disabled = !sameLyrics || active.index <= 0;
  $('captionNext').disabled =
    !item ||
    dirty ||
    !entries.length ||
    (sameProgram && !sameLyrics) ||
    (sameLyrics && active.index >= entries.length - 1);
  $('captionNext').textContent = sameProgram ? '下一句' : '播出第一句';
  $('captionHide').disabled = !state.layers.caption;
  const list = $('captionList');
  const scrollTop = list.scrollTop;
  const focused = document.activeElement?.dataset?.captionIndex;
  list.replaceChildren();
  const programId = selected;
  entries.forEach((line, index) => {
    const li = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'caption-row';
    button.dataset.captionIndex = String(index);
    button.disabled = !item || dirty;
    const current = sameLyrics && active.index === index;
    button.setAttribute('aria-current', String(current));
    button.setAttribute('aria-label', '播出第 ' + (index + 1) + ' 句：' + line);
    const number = document.createElement('span');
    number.className = 'caption-row-number';
    number.textContent = String(index + 1).padStart(2, '0');
    const content = document.createElement('span');
    content.className = 'caption-row-text';
    content.textContent = line;
    button.append(number, content);
    if (current) {
      const status = document.createElement('span');
      status.className = 'caption-row-state';
      status.textContent = state.layers.caption ? '上屏' : '已下屏';
      button.append(status);
    }
    button.onclick = run(() => command('caption.take', { programId, index }));
    li.append(button);
    list.append(li);
  });
  list.scrollTop = scrollTop;
  if (focused !== undefined)
    list.querySelector('[data-caption-index="' + focused + '"]')?.focus({ preventScroll: true });
}
function selectProgram(id) {
  if (dirty) {
    notice('请先保存当前节目，再切换。');
    return;
  }
  selected = id;
  fillProgram();
  renderList();
}
function renderList() {
  $('programList').replaceChildren();
  $('emptyPrograms').hidden = state.programs.length > 0;
  state.programs.forEach((item) => {
    const li = document.createElement('li');
    const button = document.createElement('button');
    button.className = 'program-row';
    button.setAttribute('aria-current', String(item.id === selected));
    const text = document.createElement('span');
    const title = document.createElement('strong');
    title.textContent = item.title || '未命名节目';
    const detail = document.createElement('small');
    detail.textContent = [item.type, item.performer].filter(Boolean).join(' · ');
    text.append(title, detail);
    button.append(text);
    if (state.live?.id === item.id) {
      const label = document.createElement('span');
      label.className = 'on-air';
      label.textContent = '播出';
      button.append(label);
    }
    button.onclick = () => selectProgram(item.id);
    li.append(button);
    $('programList').append(li);
  });
}
function fillDesign() {
  for (const key of [
    'channelName',
    'eventName',
    'sponsorName',
    'channelAsset',
    'eventAsset',
    'sponsorAsset',
    'transitionAsset',
  ])
    $(key).value = state[key];
  for (const key of ['accent', 'background', 'foreground', 'font', ...numericStyles])
    $(key).value = state.style[key];
  $('motion').checked = state.style.motion;
  for (const [key, id] of [
    ['port', 'vmixPort'],
    ['input', 'vmixInput'],
    ['titleField', 'titleField'],
    ['subtitleField', 'subtitleField'],
    ['overlay', 'overlay'],
  ])
    $(id).value = state.vmix[key];
}
function renderState() {
  if (!selected || !state.programs.some((item) => item.id === selected)) {
    selected = state.programs[0]?.id || '';
    if (!dirty) fillProgram();
  } else if (
    !dirty &&
    JSON.stringify(state.programs.find((item) => item.id === selected) || null) !== formSignature
  )
    fillProgram();
  renderList();
  renderCaptions();
  $('liveTitle').textContent = state.live ? state.live.title : '尚未播出节目';
  $('take').disabled = !selected;
  $('next').disabled = !state.programs.length;
  for (const key of Object.keys(layerLabels))
    $('layer-' + key).setAttribute('aria-pressed', String(state.layers[key]));
  document
    .querySelectorAll('.template')
    .forEach((button) =>
      button.setAttribute('aria-pressed', String(button.dataset.id === state.templateId)),
    );
  if (!designDirty) fillDesign();
  syncConcert();
}
for (const [key, title] of Object.entries(layerLabels)) {
  const button = document.createElement('button');
  button.id = 'layer-' + key;
  button.textContent = title;
  button.setAttribute('aria-pressed', 'false');
  button.onclick = run(() => {
    if (key === 'caption' && !state.layers.caption && !state.captionLive)
      return command('caption.take', { programId: selected, index: 0 });
    return write({ layers: { [key]: !state.layers[key] } });
  });
  $('layerControls').append(button);
}
document.querySelectorAll('[data-tab]').forEach((button) => {
  button.onclick = () => {
    document
      .querySelectorAll('[data-tab]')
      .forEach((entry) => entry.setAttribute('aria-pressed', String(entry === button)));
    document.querySelectorAll('.tab').forEach((section) => {
      section.hidden =
        section.id !== (button.dataset.tab === 'connection' ? 'connectionTab' : button.dataset.tab);
    });
    if (button.dataset.tab === 'concert') {
      syncConcert();
      probeConcertExport();
    }
  };
});
fields.forEach((id) => $(id).addEventListener('input', markDirty));
function lrcLines(source) {
  let index = 0;
  const entries = [];
  for (const original of source.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    let text = original.trim();
    if (!text || /^\[(?:ar|ti|al|by|re|ve|length|offset):/i.test(text)) continue;
    const times = [];
    let match;
    while ((match = /^\[(\d{1,4}):([0-5]?\d)(?:[.:](\d{1,3}))?\]\s*/.exec(text))) {
      const [, minute, second, fraction] = match;
      times.push(Number(minute) * 60 + Number(second) + Number('0.' + (fraction || '0')));
      text = text.slice(match[0].length).trim();
    }
    if (!text) continue;
    if (!times.length) times.push(null);
    for (const time of times) entries.push({ time, text, index: index++ });
    if (entries.length > 500) throw Error('最多导入 500 句歌词');
  }
  if (!entries.length) throw Error('未从文件读到歌词');
  if (entries.every(({ time }) => time != null))
    entries.sort((a, b) => a.time - b.time || a.index - b.index);
  const result = entries.map(({text}) => text).join('\n');
  if (result.length > 30000) throw Error('歌词不能超过 30,000 个字符');
  return result;
}
$('importProgramLrc').onchange = run(async () => {
  const input = $('importProgramLrc');
  const file = input.files[0];
  if (!file) return;
  const target = selected;
  try {
    if (!target) throw Error('先选择节目，再导入 LRC');
    if (file.size > 1024 * 1024) throw Error('LRC 文件不能超过 1 MB');
    const lines = lrcLines(await file.text());
    if (target !== selected) throw Error('节目已切换，请重新导入歌词');
    if ($('programCaption').value.trim() && !confirm('用导入的 LRC 替换当前歌词？保存后才会生效。'))
      return;
    $('programCaption').value = lines;
    markDirty();
    notice('已填入 LRC 歌词，请保存节目后再逐句播出。');
  } finally {
    input.value = '';
  }
});

$('designForm').addEventListener('input', () => {
  designDirty = true;
});
$('vmixForm').addEventListener('input', () => {
  designDirty = true;
});
$('addProgram').onclick = run(async () => {
  if (dirty) throw Error('请先保存当前节目');
  const item = {
    id: crypto.randomUUID(),
    type: '歌唱',
    title: '',
    performer: '',
    subtitle: '',
    caption: '',
  };
  await write({ programs: [...state.programs, item] });
  selected = item.id;
  fillProgram();
  renderList();
  $('programTitle').focus();
});
$('programForm').onsubmit = run(async () => {
  const item = {
    id: selected,
    type: $('programType').value,
    title: $('programTitle').value,
    performer: $('programPerformer').value,
    subtitle: $('programSubtitle').value,
    caption: $('programCaption').value,
  };
  await write({ programs: state.programs.map((entry) => (entry.id === selected ? item : entry)) });
  fillProgram();
  $('draftState').textContent = '已保存';
});
for (const [id, direction] of [
  ['moveUp', -1],
  ['moveDown', 1],
])
  $(id).onclick = run(async () => {
    if (dirty) throw Error('请先保存当前节目');
    const list = [...state.programs],
      index = list.findIndex((item) => item.id === selected),
      target = index + direction;
    if (target < 0 || target >= list.length) return;
    [list[index], list[target]] = [list[target], list[index]];
    await write({ programs: list });
  });
let deleted;
$('deleteProgram').onclick = run(async () => {
  if (!selected) return;
  deleted = {
    item: state.programs.find((item) => item.id === selected),
    index: state.programs.findIndex((item) => item.id === selected),
  };
  await write({ programs: state.programs.filter((item) => item.id !== selected) });
  dirty = false;
  fillProgram();
  notice('已删除节目。');
  const undo = document.createElement('button');
  undo.textContent = '撤销删除';
  undo.onclick = run(async () => {
    const list = [...state.programs];
    list.splice(deleted.index, 0, deleted.item);
    await write({ programs: list });
    deleted = null;
  });
  $('notice').append(' ', undo);
});
$('take').onclick = run(async () => {
  if (dirty) throw Error('请先保存，再播出节目');
  await command('program.take', { id: selected });
});
$('next').onclick = run(() => command('program.next'));
$('captionPrevious').onclick = run(() => command('caption.previous', { programId: selected }));
$('captionNext').onclick = run(() => command('caption.next', { programId: selected }));
$('captionHide').onclick = run(() => command('caption.hide'));
$('hideAll').onclick = run(() => command('all.hide'));
$('transition').onclick = run(() => command('transition.play'));
function openPreview() {
  if (window.parent !== window) window.parent.postMessage({ type: 'open-preview' }, '*');
  else window.open('/stage/graphics.html?preview=1', '_blank');
}
$('togglePreview').onclick = openPreview;
$('designPreview').onclick = openPreview;
$('designForm').onsubmit = run(async () => {
  const patch = { style: {} };
  for (const key of [
    'channelName',
    'eventName',
    'sponsorName',
    'channelAsset',
    'eventAsset',
    'sponsorAsset',
    'transitionAsset',
  ])
    patch[key] = $(key).value;
  for (const key of ['accent', 'background', 'foreground', 'font']) patch.style[key] = $(key).value;
  for (const key of numericStyles) patch.style[key] = Number($(key).value);
  patch.style.motion = $('motion').checked;
  await write(patch);
  designDirty = false;
  notice('包装设置已保存');
});
$('resetColors').onclick = () => {
  ['accent', 'background', 'foreground'].forEach((key) => {
    $(key).value = '';
  });
  designDirty = true;
};
$('exportShow').onclick = () => {
  const blob = new Blob(
    [
      JSON.stringify(
        { format: 'broadcast-stage-rundown', version: 1, programs: state.programs },
        null,
        2,
      ),
    ],
    { type: 'application/json' },
  );
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = '舞台节目单.json';
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
};
$('importShow').onchange = run(async () => {
  if (dirty) throw Error('请先保存当前节目');
  const file = $('importShow').files[0];
  if (!file) return;
  if (file.size > 1024 * 1024) throw Error('节目单不能超过 1 MB');
  const imported = JSON.parse(await file.text());
  if (
    imported.format !== 'broadcast-stage-rundown' ||
    imported.version !== 1 ||
    !Array.isArray(imported.programs)
  )
    throw Error('节目单格式无效');
  // Import appends with fresh IDs, preserving the existing show and live snapshot.
  await write({
    programs: [
      ...state.programs,
      ...imported.programs.map((item) => ({ ...item, id: crypto.randomUUID() })),
    ],
  });
  notice('节目已追加到节目单');
  $('importShow').value = '';
});
function assetOptions() {
  document.querySelectorAll('[data-assets]').forEach((select) => {
    const concertKey = Object.keys(concertFields).find((key) => concertFields[key] === select.id);
    const value = concertKey
      ? concertDirty ? select.value : state?.concert?.[concertKey] || ''
      : select.value || state?.[select.id] || '';
    select.replaceChildren(new Option('不使用', ''));
    assets
      .filter(
        (item) =>
          item.available &&
          item.kind === select.dataset.assets &&
          (select.dataset.assets !== 'video' || /\.(webm|mp4)$/i.test(item.file)),
      )
      .forEach((item) => {
        select.add(new Option(item.name, item.file));
      });
    select.value = value;
  });
  const prior = $('renderSource').value;
  $('renderSource').replaceChildren(new Option('选择 AE 工程', ''));
  assets
    .filter((item) => item.kind === 'ae' && item.available)
    .forEach((item) => $('renderSource').add(new Option(item.name, item.id)));
  $('renderSource').value = prior || (assets.filter((item) => item.kind === 'ae' && item.available).length === 1
    ? assets.find((item) => item.kind === 'ae' && item.available).id
    : '');
  renderAeCompositions();
}
const formatLabels = {
  image: '图片 · 内置包装可用',
  video: '视频 · 可添加到 vMix',
  gt: 'GT 标题 · vMix 原生渲染',
  ae: 'AE 工程 · 需 AE 渲染',
  newblue: 'NewBlue 工程 · 需原软件导出',
  sequence: '透明 PNG 序列 · 用 vMix 导入首帧',
};
async function loadAssets() {
  assets = (await api('/api/stage/library')).assets;
  $('assetList').replaceChildren();
  if (!assets.length) {
    const p = document.createElement('p');
    p.className = 'empty';
    p.textContent = '尚未导入素材';
    $('assetList').append(p);
  }
  assets.forEach((item) => {
    const row = document.createElement('div');
    row.className = 'asset-row';
    const text = document.createElement('div');
    const title = document.createElement('strong');
    title.textContent = item.name;
    const info = document.createElement('small');
    info.textContent =
      (item.bytes / 1024 / 1024).toFixed(1) +
      ' MB · ' +
      (item.sourcePath ? '链接原文件' : '已复制到素材库');
    text.append(title, info);
    const status = document.createElement('small');
    status.textContent = item.available ? formatLabels[item.kind] : '文件已移动或不存在';
    const actions = document.createElement('div');
    actions.className = 'actions';
    if (['gt', 'image', 'video'].includes(item.kind)) {
      const add = document.createElement('button');
      add.textContent = '添加到 vMix';
      add.disabled = !item.available;
      add.onclick = run(async () => {
        await api('/api/stage/vmix', { action: 'add', id: item.id });
        notice('已发送到 vMix。请在 vMix 中检查输入。');
      });
      actions.append(add);
    }
    if (item.kind === 'sequence' && item.available && /^[a-zA-Z0-9_-]+\.zip$/.test(item.file)) {
      const download = document.createElement('a');
      download.className = 'file-button';
      download.textContent = '下载 PNG 序列';
      download.href = '/assets/' + encodeURIComponent(item.file);
      download.download = item.name;
      actions.append(download);
      status.textContent = [item.frames ? item.frames + ' 帧' : '', item.fps ? item.fps + ' fps' : '',
        formatLabels.sequence].filter(Boolean).join(' · ');
    }
    if (['ae', 'newblue', 'gt'].includes(item.kind)) {
      const open = document.createElement('button');
      open.textContent = '原软件打开';
      open.disabled = !item.available;
      open.onclick = () => {
        const file = item.sourcePath;
        window.parent.postMessage(
          {
            type: 'open-source',
            path: file || '',
            assetId: item.id,
            moduleOrigin: location.origin,
          },
          '*',
        );
        if (window.parent === window && !window.chrome?.webview)
          notice('请在桌面程序中使用原软件打开，或从素材库文件夹手动打开。');
      };
      actions.append(open);
    }
    row.append(text, status, actions);
    $('assetList').append(row);
  });
  assetOptions();
  previewConcert();
}
$('upload').onchange = run(async () => {
  const input = $('upload');
  input.disabled = true;
  try {
    for (const file of input.files) {
      if (file.size > 512 * 1024 * 1024) throw Error('单个素材最多 512 MB');
      notice('正在导入：' + file.name);
      const response = await fetch('/api/stage/upload?name=' + encodeURIComponent(file.name), {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: file,
      });
      const result = await response.json();
      if (!response.ok) throw Error(result.error);
    }
    await loadAssets();
    notice('导入完成。AE / NewBlue 工程的关联素材请保持可访问；推荐使用“链接本地工程”。');
  } finally {
    input.value = '';
    input.disabled = false;
  }
});
$('registerSource').onclick = () => {
  if (window.parent === window && !window.chrome?.webview) {
    notice('请在桌面程序中链接本地工程；也可以用“导入文件”复制工程。');
    return;
  }
  window.parent.postMessage({ type: 'import-source' }, '*');
};
window.addEventListener('message', (event) => {
  if (
    event.source !== window.parent ||
    !/^http:\/\/127\.0\.0\.1:\d+$/.test(event.origin) ||
    event.data?.type !== 'native-source'
  )
    return;
  run(async () => {
    await api('/api/stage/register', { path: event.data.path });
    await loadAssets();
    notice('工程已链接，保留原路径。');
  })();
});
function renderAeCompositions() {
  const source = assets.find((item) => item.id === $('renderSource').value && item.kind === 'ae');
  const list = $('aeCompositions');
  list.replaceChildren();
  const compositions = Array.isArray(source?.compositions) ? source.compositions : [];
  for (const comp of compositions) {
    const choice = document.createElement('option');
    choice.value = comp.name;
    choice.label = comp.width + '×' + comp.height + ' · ' + comp.fps + ' fps';
    list.append(choice);
  }
  $('aeManifestSummary').textContent = compositions.length
    ? '可选 ' + compositions.length + ' 个 AE 合成'
    : '未导入清单时可手动填写合成名称';
  $('aeManifestUpload').disabled = !source;
}
$('renderSource').onchange = renderAeCompositions;
let priorAeFormat = 'mov';
const aeTemplateNames = { mov: 'Lossless with Alpha', 'png-sequence': 'PNG Sequence with Alpha' };
$('aeRenderFormat').onchange = () => {
  const format = $('aeRenderFormat').value;
  const field = $('outputModule');
  if (!field.value || field.value === aeTemplateNames[priorAeFormat]) field.value = '';
  field.placeholder = '填入本机模板名，例如 ' + aeTemplateNames[format];
  priorAeFormat = format;
};
$('aeManifestUpload').onchange = run(async () => {
  const input = $('aeManifestUpload');
  const file = input.files[0];
  if (!file) return;
  try {
    const id = $('renderSource').value;
    if (!id) throw Error('请先选择对应的 AE 工程');
    if (file.size > 240 * 1024) throw Error('AE 合成清单不能超过 240 KB');
    const manifest = JSON.parse(await file.text());
    await api('/api/stage/ae-manifest', { id, manifest });
    await loadAssets();
    notice('已导入 AE 合成清单，可以直接选择合成名称。');
  } finally {
    input.value = '';
  }
});
$('renderForm').onsubmit = run(async () => {
  await api('/api/stage/render', {
    id: $('renderSource').value,
    composition: $('composition').value,
    outputModule: $('outputModule').value,
    format: $('aeRenderFormat').value,
  });
  notice('AE 正在后台渲染，请避免在正式播出时运行重型渲染。');
  pollJobs();
});
async function pollJobs() {
  clearTimeout(jobTimer);
  try {
    const jobs = (await api('/api/stage/render')).jobs;
    $('renderLog').textContent = jobs
      .map(
        (job) =>
          ({ running: '渲染中', done: '渲染完成', failed: '渲染失败' })[job.status] +
          '\n' +
          job.log,
      )
      .join('\n\n');
    if (jobs.some((job) => job.status === 'running')) jobTimer = setTimeout(pollJobs, 2000);
    else if (jobs.length) await loadAssets();
  } catch (error) {
    notice(error.message);
  }
}
$('outputURL').value = location.origin + '/stage/graphics.html';
$('copyURL').onclick = run(async () => {
  await navigator.clipboard.writeText($('outputURL').value);
  notice('上屏地址已复制');
});
$('openOutput').onclick = openPreview;
$('vmixForm').onsubmit = run(async () => {
  await write({
    vmix: {
      port: Number($('vmixPort').value),
      input: $('vmixInput').value,
      titleField: $('titleField').value,
      subtitleField: $('subtitleField').value,
      overlay: Number($('overlay').value),
    },
  });
  designDirty = false;
  notice('连接设置已保存');
});
document.querySelectorAll('[data-vmix]').forEach((button) => {
  button.onclick = run(async () => {
    await api('/api/stage/vmix', { action: button.dataset.vmix });
    notice(button.dataset.vmix === 'connect' ? 'vMix 连接成功' : 'vMix 操作成功');
  });
});
async function poll() {
  try {
    if (!writing) await read();
    $('connection').textContent = '本地服务已连接';
  } catch (error) {
    $('connection').textContent = '连接中断';
    notice(error.message);
  }
  setTimeout(poll, document.hidden ? 5000 : 1500);
}
async function init() {
  templates = (await api('/api/stage/templates')).templates;
  for (const template of templates) {
    const button = document.createElement('button');
    button.className = 'template';
    button.dataset.id = template.id;
    const sample = document.createElement('span');
    sample.className = 'template-sample';
    sample.style.setProperty('--sample-bg', template.background);
    sample.style.setProperty('--sample-fg', template.foreground);
    sample.style.setProperty('--sample-accent', template.accent);
    sample.style.fontFamily = template.font;
    const title = document.createElement('strong');
    title.textContent = '节目名称';
    const subtitle = document.createElement('small');
    subtitle.textContent = '示例 · 表演者 / 演出单位';
    sample.append(title, subtitle);
    const name = document.createElement('strong');
    name.textContent = template.name;
    const description = document.createElement('small');
    description.textContent = template.description;
    button.append(sample, name, description);
    button.onclick = run(async () => {
      await write({
        templateId: template.id,
        style: { accent: '', background: '', foreground: '', font: 'template' },
      });
      for (const key of ['accent', 'background', 'foreground']) $(key).value = '';
      $('font').value = 'template';
    });
    $('templates').append(button);
  }
  await read();
  await loadAssets();
  fillDesign();
  fillProgram();
  poll();
  pollJobs();
}
const concertFields = {
  type: 'concertType',
  show: 'concertShow',
  title: 'concertTitle',
  name: 'concertName',
  number: 'concertNumber',
  subtitle: 'concertSubtitle',
  credits: 'concertCredits',
  lyrics: 'concertLyrics',
  lyric2: 'concertLyric2',
  full: 'concertFull',
  portraitAsset: 'concertPortraitAsset',
  mainAsset: 'concertMainAsset',
  mainFit: 'concertMainFit',
  mainEnabled: 'concertMainEnabled',
};
const concertNames = {
  title: '报幕',
  lyrics: '歌词',
  rank: '名次',
  guest: '嘉宾介绍',
  contestant: '选手介绍',
  award: '人气奖',
  bug: '右下角标',
  finaleCast: '六强阵容',
};
const concertDefaults = {
  type: 'title',
  show: '深秋歌会',
  title: '深秋歌会',
  full: true,
  mainFit: 'contain',
};
let concertDirty = false,
  concertSignature = '',
  concertFrame = 0,
  concertRenderGeneration = 0,
  concertSaving = false,
  concertExportTask = null,
  concertExportCaps;
function concertFill(draft) {
  for (const [key, id] of Object.entries(concertFields)) {
    const field = $(id);
    const value = draft[key] ?? concertDefaults[key];
    if (field.type === 'checkbox') field.checked = Boolean(value);
    else field.value = value ?? '';
  }
  $('concertRanks').value = (draft.ranks || [])
    .map(({ name, score }) => name + (score ? '｜' + score : ''))
    .join('\n');
  renderConcertType();
}
function concertDraft() {
  const draft = { theme: 'finale50' };
  for (const [key, id] of Object.entries(concertFields)) {
    const field = $(id);
    draft[key] = field.type === 'checkbox' ? field.checked : field.value.trim();
  }
  draft.ranks = $('concertRanks')
    .value.split(/\r?\n/)
    .map((line) => {
      const [name, ...parts] = line.split(/[|｜]/);
      return { name: name.trim(), score: parts.join('｜').trim() };
    })
    .filter((row) => row.name);
  return draft;
}
function renderConcertType() {
  const type = $('concertType').value;
  $('concertMainSettings').disabled = !$('concertFull').checked;
  $('concertTitleLabel').textContent = type === 'award' ? '奖项名称（可空，默认人气奖）' : type === 'bug' ? '角标副行（可选）' : '节目标题';
  $('concertNameLabel').textContent = type === 'award' ? '获奖者姓名' : '姓名／演唱者';
  $('concertSubtitleLabel').textContent = type === 'award' ? '票数或颁奖说明（可选）' : '副标题';
  $('concertRanksLabel').textContent = type === 'finaleCast'
    ? '六强选手（最多 6 位，按每行「姓名｜曲目或说明」录入）'
    : '名次（每行一位，姓名与得分用「｜」分隔）';
  $('concertRanks').placeholder = type === 'finaleCast' ? '林知秋｜落叶来信' : '林知秋｜98.6';
  $('concertForm')
    .querySelectorAll('[data-concert-for]')
    .forEach((item) => {
      item.hidden = !item.dataset.concertFor.split(' ').includes(type);
    });
  const follow = type === 'lyrics' && !$('concertLyrics').value.trim();
  const item = state?.programs?.find((entry) => entry.id === selected);
  const active = state?.captionLive;
  const same = item && active?.programId === item.id && active.caption === item.caption && !dirty;
  $('concertLyricsPrevious').disabled = !follow || !same || active.index <= 0;
  const last = item ? StageCaptions.lines(item.caption).length - 1 : -1;
  $('concertLyricsNext').disabled = !follow || !item || dirty || last < 0 || (same && active.index >= last);
}
function currentRenderedConcert(draft = concertDraft()) {
  if (draft.type === 'bug') return { ...draft, full: false, mainEnabled: false };
  if (draft.type !== 'lyrics') return draft.full ? draft : { ...draft, mainEnabled: false };
  const active = state?.captionLive;
  return {
    ...draft,
    full: false,
    mainEnabled: false,
    lyrics:
      draft.lyrics ||
      (state?.layers?.caption && active ? StageCaptions.lines(active.caption)[active.index] || '' : ''),
  };
}
function previewConcert(animate = false) {
  if ($('concert').hidden) return;
  const graphics = window.StageGraphics;
  if (!graphics) return;
  const canvas = $('concertPreview');
  const generation = ++concertRenderGeneration;
  cancelAnimationFrame(concertFrame);
  const cue = currentRenderedConcert();
  Promise.resolve(graphics.ready(cue))
    .then(() => {
      if (generation !== concertRenderGeneration || $('concert').hidden) return;
      const start = performance.now();
      function draw(timestamp) {
        if (generation !== concertRenderGeneration || $('concert').hidden) return;
        const time = animate ? Math.max(0, (timestamp - start) / 1000) : 2.4;
        graphics.render(canvas, cue, { time, duration: 0 });
        if (animate && time < 2.4) concertFrame = requestAnimationFrame(draw);
      }
      concertFrame = requestAnimationFrame(draw);
    })
    .catch((error) => notice('预监素材读取失败：' + error.message));
}
function syncConcert() {
  if (!state?.concert) return;
  const signature = JSON.stringify(state.concert);
  if (!concertDirty && signature !== concertSignature) {
    concertSignature = signature;
    concertFill(state.concert);
  }
  const live = state.concertLive;
  $('concertLiveState').textContent = live
    ? 'PGM · ' + concertNames[live.type] + (live.title ? '：' + live.title : '')
    : 'PGM · 尚未上屏';
  $('concertLiveState').dataset.live = String(Boolean(live));
  $('concertHide').disabled = !live;
  const bug = $('concertBugToggle');
  const bugVisible = Boolean(state.concertBug);
  bug.disabled = false;
  bug.setAttribute('aria-pressed', String(bugVisible));
  bug.textContent = bugVisible ? '关闭随播角标' : '开启随播角标';
  renderConcertType();
  previewConcert();
}
function markConcert() {
  concertDirty = true;
  $('concertDraftState').textContent = '未保存 · 仅预监';
  renderConcertType();
  previewConcert();
}
async function saveConcert(take) {
  if (concertSaving) return;
  if (!state?.concert) throw Error('请等本地舞台服务连接后再操作');
  const draft = concertDraft();
  if (draft.ranks.length > 8) throw Error('最多输入 8 位参赛者');
  if (draft.type === 'finaleCast' && draft.ranks.length > 6) throw Error('六强阵容最多 6 位选手');
  const preview = currentRenderedConcert(draft);
  if (preview.mainEnabled && !preview.mainAsset) throw Error('请先选择或导入主视图');
  $('concertTake').disabled = true;
  concertSaving = true;
  try {
    const signature = JSON.stringify(draft);
    await write({ concert: draft });
    if (JSON.stringify(concertDraft()) === signature) {
      concertDirty = false;
      $('concertDraftState').textContent = '已保存';
      syncConcert();
    }
    if (take) await command('concert.take');
    notice(take ? '歌会包装已上屏。' : '已保存包装资料，播出画面未改动。');
  } finally {
    concertSaving = false;
    $('concertTake').disabled = false;
  }
}
function concertDownload(href, filename) {
  const link = document.createElement('a');
  link.href = href;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
}
function concertBlob(canvas) {
  return new Promise((resolve, reject) =>
    canvas.toBlob((blob) => blob ? resolve(blob) : reject(Error('生成 PNG 失败')), 'image/png'),
  );
}
function concertCanvas() {
  const canvas = document.createElement('canvas');
  canvas.width = 1920;
  canvas.height = 1080;
  return canvas;
}
function concertExportCue() {
  const cue = currentRenderedConcert();
  if (cue.type === 'lyrics' && !cue.lyrics && !cue.lyric2) throw Error('请先填写或播出一行歌词');
  return cue;
}
const concertEndpoint = '/api/stage/concert-export';
async function concertRequest(path, init) {
  const response = await fetch(concertEndpoint + path, init);
  const result = await response.json().catch(() => ({}));
  if (!response.ok || result.ok === false) throw Error(result.error || '导出服务不可用');
  return result;
}
async function probeConcertExport() {
  if (concertExportCaps) return concertExportCaps;
  try {
    concertExportCaps = await concertRequest('', { cache: 'no-store' });
    $('concertFormat').querySelector('option[value="mov"]').disabled = !concertExportCaps.mov;
    if (!concertExportCaps.mov)
      $('concertExportStatus').textContent = '可导出 PNG 序列；安装带 ProRes 编码器的 FFmpeg 后重启，即可导出透明 MOV。';
    return concertExportCaps;
  } catch (_) {
    $('concertExportStatus').textContent = '本地导出服务暂不可用。仍可保存当前画面的 PNG。';
  }
}
function concertUseAction(id, handler) {
  $(id).onclick = run(handler);
}
$('concertForm').addEventListener('input', (event) => {
  if (event.target.id !== 'concertUpload') markConcert();
});
$('concertForm').onsubmit = run(() => saveConcert(false));
concertUseAction('concertTake', () => saveConcert(true));
concertUseAction('concertHide', () => command('concert.hide'));
concertUseAction('concertBugToggle', async () => {
  const toggle = $('concertBugToggle');
  toggle.disabled = true;
  const visible = !state.concertBug;
  const draft = concertDraft();
  try {
    await command('stage.setConcertBug', visible
      ? {
          visible,
          show: draft.show,
          title: draft.type === 'bug' ? draft.title : '',
        }
      : { visible });
    notice(visible ? '已开启独立随播角标。' : '已关闭独立随播角标。');
  } finally {
    toggle.disabled = false;
  }
});
$('concertOpenPreview').onclick = openPreview;
$('concertOpenAE').onclick = () => {
  document.querySelector('[data-tab="library"]').click();
  $('upload').focus();
};
$('concertReplay').onclick = () => previewConcert(true);
$('concertSetSample').onclick = () => {
  const draft = concertDraft();
  const copy = {
    title: { title: '深秋歌会', name: '北京理工大学', subtitle: '借一束秋光，唱给这一夜', credits: '校园音乐现场 · 彩排示例' },
    lyrics: { title: '落叶来信', lyrics: '晚风把秋意写成信', lyric2: '' },
    rank: { title: '最终名次', subtitle: '彩排示例', ranks: [{ name: '林知秋', score: '98.60' }, { name: '周予安', score: '97.25' }, { name: '苏鸣远', score: '96.80' }] },
    guest: { name: '许星遥', title: '秋夜回声', subtitle: '特邀表演 · 彩排示例' },
    contestant: { name: '林知秋', title: '落叶来信', number: '03', subtitle: '参赛选手 · 彩排示例' },
    award: { name: '林知秋', title: '最佳人气奖', subtitle: '432 票 · 彩排示例' },
    bug: { show: '北理工深秋歌会', title: '决赛现场' },
    finaleCast: {
      title: '六强阵容',
      subtitle: '巅峰对决 · 彩排示例',
      ranks: [
        { name: '林知秋', score: '落叶来信' },
        { name: '周予安', score: '夜的回声' },
        { name: '苏鸣远', score: '白色纸飞机' },
        { name: '许星遥', score: '慢慢的星光' },
        { name: '陈予川', score: '向远方' },
        { name: '方晴禾', score: '秋天的风' },
      ],
    },
  }[draft.type];
  if (!copy) return;
  concertFill({ ...draft, ...copy });
  markConcert();
};
$('concertGotoLyrics').onclick = () => {
  document.querySelector('[data-tab="show"]').click();
  $('programCaption').focus();
};
concertUseAction('concertLyricsPrevious', () =>
  command('caption.previous', { programId: selected }),
);
concertUseAction('concertLyricsNext', () => {
  const active = state.captionLive;
  const item = state.programs.find((entry) => entry.id === selected);
  return active?.programId === selected && active.caption !== item?.caption
    ? command('caption.take', { programId: selected, index: 0 })
    : command('caption.next', { programId: selected });
});
$('concertUpload').onchange = run(async () => {
  const input = $('concertUpload');
  const file = input.files[0];
  if (!file) return;
  input.disabled = true;
  try {
    if (!/\.(png|jpe?g|webp)$/i.test(file.name)) throw Error('主视图仅支持 PNG、JPG 或 WebP');
    if (file.size > 64 * 1024 * 1024) throw Error('主视图不能超过 64 MB');
    notice('正在导入主视图：' + file.name);
    const response = await fetch('/api/stage/upload?name=' + encodeURIComponent(file.name), {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: file,
    });
    const result = await response.json();
    if (!response.ok || !result.asset?.file) throw Error(result.error || '导入主视图失败');
    await loadAssets();
    $('concertMainAsset').value = result.asset.file;
    $('concertMainEnabled').checked = true;
    markConcert();
    notice('主视图已导入；确认预监后再上屏。');
  } finally {
    input.disabled = false;
    input.value = '';
  }
});
concertUseAction('concertPng', async () => {
  const cue = concertExportCue();
  const canvas = concertCanvas();
  await window.StageGraphics.ready(cue);
  window.StageGraphics.render(canvas, cue, { time: 2.4, duration: 0 });
  const url = URL.createObjectURL(await concertBlob(canvas));
  concertDownload(url, '深秋歌会.png');
  setTimeout(() => URL.revokeObjectURL(url), 1500);
});
concertUseAction('concertExport', async () => {
  if (concertExportTask) return;
  const cue = concertExportCue();
  const caps = await probeConcertExport();
  if (concertExportTask) return;
  if (!caps) throw Error('本地导出服务不可用');
  const fps = Number($('concertFps').value);
  const duration = Number($('concertDuration').value);
  const frameCount = Math.round(duration * fps);
  if (!(duration >= 0.5 && duration <= 20 && frameCount <= (caps.maxFrames || 600)))
    throw Error('时长须为 0.5–20 秒，总帧数不超过 ' + (caps.maxFrames || 600));
  const format = $('concertFormat').value;
  if (format === 'mov' && !caps.mov) throw Error('本机没有可用于导出透明 MOV 的 FFmpeg');
  const task = { id: null, abort: new AbortController() };
  concertExportTask = task;
  $('concertExport').disabled = true;
  $('concertExportCancel').hidden = false;
  $('concertExportProgress').hidden = false;
  $('concertExportProgress').value = 0;
  const status = (message) => ($('concertExportStatus').textContent = message);
  try {
    status('准备导出…');
    const graphics = window.StageGraphics;
    const canvas = concertCanvas();
    await graphics.ready(cue);
    task.abort.signal.throwIfAborted();
    const result = await concertRequest('', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ format, fps, frameCount }),
    });
    if (typeof result.id !== 'string' || !/^[a-z0-9-]{6,100}$/i.test(result.id))
      throw Error('导出服务没有返回任务编号');
    task.id = result.id;
    let hold;
    for (let index = 0; index < frameCount; index++) {
      task.abort.signal.throwIfAborted();
      const time = Math.min(2.4, index / fps);
      if (!hold) graphics.render(canvas, cue, { time, duration: 0 });
      const blob = hold || await concertBlob(canvas);
      if (time === 2.4) hold = blob;
      await concertRequest('/' + task.id + '/frame/' + index, {
        method: 'POST',
        headers: { 'Content-Type': 'image/png' },
        body: blob,
        signal: task.abort.signal,
      });
      $('concertExportProgress').value = (index + 1) / frameCount;
      status('已生成 ' + (index + 1) + ' / ' + frameCount + ' 帧');
    }
    status(format === 'mov' ? '正在编码 ProRes 4444…' : '正在打包 PNG…');
    const outputs = await concertRequest('/' + task.id + '/finish', {
      method: 'POST',
      signal: task.abort.signal,
    });
    const fallbackPath = concertEndpoint + '/' + task.id + '/download';
    if (outputs.url && outputs.url !== fallbackPath) throw Error('导出下载地址无效');
    concertDownload(fallbackPath, format === 'mov' ? '深秋歌会.mov' : '深秋歌会-PNG序列.zip');
    status('导出完成，已发起下载。');
  } catch (error) {
    if (task.id) concertRequest('/' + task.id, { method: 'DELETE' }).catch(() => {});
    status(error.name === 'AbortError' ? '导出已取消。' : '导出失败：' + error.message);
  } finally {
    concertExportTask = null;
    $('concertExport').disabled = false;
    $('concertExportCancel').hidden = true;
    $('concertExportProgress').hidden = true;
  }
});
$('concertExportCancel').onclick = () => concertExportTask?.abort.abort();

init().catch((error) => notice(error.message));
