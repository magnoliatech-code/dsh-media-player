/**
 * Smoke test for the client half: load the bundle the way the harness does,
 * then check the renderer registration and the player's render tree.
 *
 *   node test/smoke.mjs
 *
 * No browser: the bundle is a plain script that calls `window.__ModuleLoader__`,
 * so a fake loader and a minimal React are enough to exercise `apply`.
 */
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const bundle = join(here, '..', 'lib', 'client.js');

const problems = [];
const captured = [];

globalThis.window = { __ModuleLoader__: { load: (entry) => captured.push(entry) } };
globalThis.document = {
  createElement: () => ({ setAttribute() {}, remove() {} }),
  head: { append() {} },
};
globalThis.dshMediaPlayer = { url: 'http://127.0.0.1:8099/', root: '/srv/root', port: 8099 };

await import(pathToFileURL(bundle).href);
if (captured.length !== 1) problems.push(`expected one loader registration, got ${captured.length}`);
const entry = captured[0] || {};
if (entry.id !== 'dsh-media-player') problems.push(`bundle id is ${entry.id}`);
if (typeof entry.factory !== 'function') problems.push('bundle has no factory');

let useStateCalls = 0;
let nextStates = [];
const fakeReact = {
  createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
  useState: (initial) => [nextStates[useStateCalls++] ?? initial, () => {}],
  useEffect: () => {},
  useRef: () => ({ current: null }),
};
const fakeRequire = (name) => {
  if (name === 'react') return fakeReact;
  throw new Error(`unexpected module request: ${name}`);
};

const exported = entry.factory(fakeRequire);
const renderers = [];
const bodies = [];
const ctx = {
  effect: (fn) => fn(),
  documentPreviews: { register: (definition) => { renderers.push(definition); return () => {}; } },
  slots: {
    inject: (name, factory) => {
      if (name !== 'sidebar.right.tab.document') throw new Error(`unexpected slot: ${name}`);
      return factory();
    },
    register: (declaration, component) => { bodies.push({ declaration, component }); return () => {}; },
  },
};

exported.apply(ctx);

// --- registration ---------------------------------------------------------
const definition = renderers[0];
const body = bodies[0];

if (!definition) problems.push('no renderer registered');
else {
  if (definition.loading !== 'renderer') problems.push(`loading is ${definition.loading}, expected renderer`);
  if (definition.priority !== 'extension') problems.push(`priority is ${definition.priority}`);
  for (const ext of ['mp4', 'webm', 'mp3', 'wav', 'flac']) {
    if (!definition.extensions.includes(ext)) problems.push(`missing extension ${ext}`);
  }
  if (!definition.binaryExtensions?.includes('mp3')) problems.push('mp3 must be declared binary');
  const stray = (definition.binaryExtensions || []).filter((ext) => !definition.extensions.includes(ext));
  if (stray.length) problems.push(`binaryExtensions outside extensions: ${stray.join(', ')}`);
}
if (!body) problems.push('no body registered');
else {
  if (body.declaration.name !== 'sidebar.right.tab.document') problems.push('body slot name');
  if (body.declaration.key !== definition?.id) problems.push('body key must equal the renderer id');
  if (typeof body.component !== 'function') problems.push('body is not a component');
}
if (JSON.stringify(exported.inject) !== JSON.stringify(['slots', 'documentPreviews'])) {
  problems.push(`inject is ${JSON.stringify(exported.inject)}`);
}

// --- render tree ----------------------------------------------------------
const media = {
  path: 'film/renders/act0.mp4',
  name: 'act0.mp4',
  kind: 'video',
  size: 42800000,
  mtime: 1792447883998,
  url: '/m/film/renders/act0.mp4',
  absolute: '/srv/root/film/renders/act0.mp4',
};
const props = {
  resourceAddress: 'dsh-resource://file/session/s1/film/renders/act0.mp4',
  content: { kind: 'renderer', revision: 3, loaded() {}, failed() {}, reload() {} },
  useTabInfo: () => ({ tab: { id: 'tab-1', signal: new AbortController().signal } }),
};

function tree(node) {
  if (!node || typeof node !== 'object') return [];
  return [node, ...(node.children || []).flatMap(tree)];
}

useStateCalls = 0;
nextStates = [{ status: 'ready', media }, 1, false, false];
const rendered = body.component(props);
const nodes = tree(rendered);
const video = nodes.find((node) => node.type === 'video');
if (!video) problems.push('ready state renders no <video>');
else if (video.props.src !== 'http://127.0.0.1:8099/m/film/renders/act0.mp4') {
  problems.push(`video src is ${video.props.src}`);
}
const link = nodes.find((node) => node.type === 'a');
if (!link || !String(link.props.href).includes('#play=film%2Frenders%2Fact0.mp4')) {
  problems.push('no deep link to the full player page');
}

const audioMedia = { ...media, path: 'aud/M1.mp3', name: 'M1.mp3', kind: 'audio', url: '/m/aud/M1.mp3' };
useStateCalls = 0;
nextStates = [{ status: 'ready', media: audioMedia }, 1, false, true];
const audioTree = tree(body.component({ ...props, content: { ...props.content } }));
const audio = audioTree.find((node) => node.type === 'audio');
if (!audio) problems.push('audio file renders no <audio>');
else if (audio.props.src !== 'http://127.0.0.1:8099/m/aud/M1.mp3') problems.push(`audio src is ${audio.props.src}`);

useStateCalls = 0;
nextStates = [{ status: 'failed', message: 'not under the player root' }, 1, false, false];
const failedTree = tree(body.component({ ...props }));
const retry = failedTree.find((node) => node.type === 'button');
if (!retry) problems.push('failure state offers no retry');
else if (!/not under the player root/.test(JSON.stringify(failedTree))) problems.push('failure text missing');

// --- report ---------------------------------------------------------------
if (problems.length === 0) {
  console.log(`PASS  ${definition.extensions.length} extensions, body keyed ${definition.id}`);
  process.exit(0);
}
console.error('FAIL');
for (const problem of problems) console.error('  - ' + problem);
process.exit(1);
