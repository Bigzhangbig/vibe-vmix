'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

async function workspace() {
  function element() {
    return {
      children: [],
      dataset: {},
      attributes: {},
      textContent: '',
      src: '',
      disabled: false,
      append(...children) {
        this.children.push(...children);
      },
      replaceChildren(...children) {
        this.children = children;
      },
      setAttribute(key, value) {
        this.attributes[key] = value;
      },
      contentWindow: { postMessage() {} },
    };
  }
  const nodes = new Map();
  const get = (id) => {
    if (!nodes.has(id)) nodes.set(id, element());
    return nodes.get(id);
  };
  const modules = [
    {
      id: 'concert',
      name: '深秋歌会',
      description: '歌会',
      features: [],
      enabled: true,
      url: 'http://127.0.0.1:8127',
      controlPath: '/control.html',
      outputPath: '/graphics.html',
      editorPath: '/edit.html',
    },
    {
      id: 'stage',
      name: '舞台节目',
      description: '舞台',
      features: [],
      enabled: true,
      url: 'http://127.0.0.1:8125',
    },
  ];
  const popups = [];
  const nativeOpen = (...args) => {
    popups.push(args);
    return {};
  };
  const context = vm.createContext({
    URL,
    console,
    open: nativeOpen,
    addEventListener() {},
    navigator: { clipboard: { async writeText() {} } },
    document: {
      getElementById: get,
      createElement: element,
      querySelector: () => get('brand'),
      querySelectorAll: (selector) =>
        selector === '#navigation button' ? get('navigation').children : [],
    },
    fetch: async () => ({
      ok: true,
      json: async () => ({
        version: 'test',
        loaded: modules.filter((m) => m.enabled).map((m) => m.id),
        modules,
      }),
    }),
  });
  context.window = context;
  vm.runInContext(
    fs.readFileSync(path.join(__dirname, '../ui/workspace/workspace.js'), 'utf8'),
    context,
  );
  await new Promise((resolve) => setImmediate(resolve));
  return { context, get, popups, nativeOpen, modules };
}

test('opening concert layout preserves native window.open and the selected module', async () => {
  const { context, get, popups, nativeOpen } = await workspace();
  get('navigation').children[0].onclick();
  assert.equal(get('moduleName').textContent, '深秋歌会');
  assert.equal(get('moduleFrame').src, 'http://127.0.0.1:8127/control.html');
  const frame = get('moduleFrame').src;
  const output = get('moduleAddress').textContent;
  get('openPreview').onclick();
  assert.equal(popups.length, 1);
  assert.deepEqual(popups[0], ['http://127.0.0.1:8127/edit.html', '_blank']);
  assert.equal(context.open, nativeOpen);
  assert.equal(get('moduleName').textContent, '深秋歌会');
  assert.equal(get('moduleFrame').src, frame);
  assert.equal(get('moduleAddress').textContent, output);
  vm.runInContext("openModule('http://127.0.0.1:8127/edit.html')", context);
  assert.equal(get('moduleFrame').src, frame);
  assert.equal(get('moduleName').textContent, '深秋歌会');
});

test('layout entry follows active module selection and rejects unavailable module addresses', async () => {
  const { context, get, popups, modules } = await workspace();
  assert.equal(get('openPreview').disabled, true);
  get('openPreview').onclick();
  assert.equal(popups.length, 0);
  get('navigation').children[1].onclick();
  assert.equal(get('openPreview').disabled, false);
  get('openPreview').onclick();
  assert.equal(popups[0][0], '/workspace/preview.html?module=stage');
  get('manage').onclick();
  assert.equal(get('openPreview').disabled, true);
  modules[0].url = undefined;
  get('navigation').children[0].onclick();
  assert.equal(get('moduleFrame').src, 'about:blank');
  assert.equal(get('openPreview').disabled, true);
  vm.runInContext('render()', context);
  assert.equal(get('openPreview').disabled, true);
});

test('unloading the selected module disables layout and clears stale output addresses', async () => {
  const { context, get, modules, popups } = await workspace();
  get('navigation').children[0].onclick();
  modules[0].enabled = false;
  vm.runInContext('render()', context);
  assert.equal(get('openPreview').disabled, true);
  assert.equal(get('moduleFrame').src, 'about:blank');
  assert.equal(get('moduleAddress').textContent, '');
  assert.equal(get('moduleName').textContent, '');
  get('openPreview').onclick();
  assert.equal(popups.length, 0);
});
