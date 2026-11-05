const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const ts = require('typescript');
global.document = { title: 'Test' };

function load(file, imports = {}) {
  const { outputText } = ts.transpileModule(readFileSync(resolve(__dirname, file), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  const module = { exports: {} };
  new Function('require', 'module', 'exports', outputText)(name => {
    if (Object.hasOwn(imports, name)) return imports[name];
    throw new Error(`Unexpected test import: ${name}`);
  }, module, module.exports);
  return module.exports;
}

const file = 'C:\\Test\\main.swift';
let failWrite = true;
let writeBarrier = null;
let writeStarted = () => {};
let writes = 0;
let diskText = '';
let builds = 0;
let updates = 0;
let quits = 0;
const errors = [];
const paths = load('../src/lib/paths.ts');
const models = load('../src/lib/models.ts', {
  './paths': paths,
  './monaco': { monaco: {
    Uri: { file: path => path },
    editor: {
      getModel: () => null,
      createModel(content) {
        let version = 1;
        let current = { content, version };
        const history = [];
        return {
          getValue: () => current.content,
          setValue: text => { history.push(current); current = { content: text, version: ++version }; },
          undo: () => { if (history.length) current = history.pop(); },
          getAlternativeVersionId: () => current.version,
          updateOptions() {}, dispose() {},
        };
      },
    },
  } },
});
const i18n = { t: key => key, tn: key => key };
const api = {
  writeTextFile: async (_path, text) => {
    if (failWrite) throw new Error('Disk is full');
    writes += 1;
    writeStarted(text);
    await writeBarrier;
    diskText = text;
  },
  startBuild: async () => ++builds,
  quitApp: async () => { quits += 1; },
};
const ipc = { api, errorMessage: error => error.message };
const store = load('../src/lib/store.ts', {
  zustand: require('zustand'),
  '../i18n': i18n,
  './dialogs': { saveChoice: async () => 'save' },
  './format': {},
  './ipc': ipc,
  './lsp': { stopLsp: async () => undefined },
  './models': models,
  './paths': paths,
  './updater': { installUpdate: async () => { updates += 1; } },
});
const { useStore } = store;
const { requestClose } = load('../src/lib/appWindow.ts', {
  '../i18n': i18n, './ipc': ipc, './models': models, './store': store,
});

function reset(autoSave = true) {
  models.disposeAll();
  models.createDoc(file, 'print("Original")').model.setValue('print("Unsaved edits")');
  errors.length = 0;
  useStore.setState({
    settings: { autoSave },
    project: { root: 'C:\\Test', name: 'Test', kind: 'executable' },
    trusted: true, tabs: [file], active: file, task: null, updateState: 'idle',
    toast: (kind, text) => { if (kind === 'error') errors.push(text); },
  });
}

async function check() {
  reset(false);
  await useStore.getState().closeTab(file);
  assert.ok(models.getDoc(file), 'Failed Save must keep the editor document open');
  assert.ok(models.isDirty(file), 'Failed Save must preserve unsaved changes');
  assert.equal(errors.length, 1, 'Failed Save still reports its error');
  reset();
  assert.equal(await useStore.getState().closeProject(), false, 'Failed autosave blocks project close');
  assert.ok(models.getDoc(file));
  await useStore.getState().build('build');
  assert.equal(builds, 0, 'Failed autosave blocks building stale disk content');
  await useStore.getState().installUpdate();
  assert.equal(updates, 0, 'Failed autosave blocks an update restart');
  await requestClose();
  assert.equal(quits, 0, 'Failed autosave blocks app quit');
  assert.ok(models.isDirty(file));

  failWrite = false;
  assert.equal(await useStore.getState().saveAll(), true);
  assert.equal(models.isDirty(file), false);
  await useStore.getState().closeTab(file);
  assert.equal(models.getDoc(file), undefined, 'Successful save allows closing the document');
  reset();
  assert.equal(await useStore.getState().closeProject(), true);
  assert.equal(models.allDocs().length, 0, 'Successful autosave permits project close');

  for (const action of [() => useStore.getState().closeTab(file), () => useStore.getState().build('build')]) {
    reset();
    let finishWrite;
    writeBarrier = new Promise(resolve => { finishWrite = resolve; });
    const started = new Promise(resolve => { writeStarted = resolve; });
    const pending = action();
    assert.equal(await started, 'print("Unsaved edits")');
    models.getDoc(file).model.setValue('print("Newer edits")');
    finishWrite();
    await pending;
    assert.ok(models.getDoc(file), 'Edits made during Save keep the document open');
    assert.ok(models.isDirty(file), 'Edits made during Save remain unsaved');
    assert.equal(builds, 0, 'Newer unsaved edits block building stale disk content');
    writeBarrier = null;
    writeStarted = () => {};
  }

  reset();
  writes = 0;
  let finishOlder;
  writeBarrier = new Promise(resolve => { finishOlder = resolve; });
  const olderStarted = new Promise(resolve => { writeStarted = resolve; });
  const older = useStore.getState().save(file);
  await olderStarted;
  models.getDoc(file).model.setValue('print("Newest edits")');
  let finishNewer;
  writeBarrier = new Promise(resolve => { finishNewer = resolve; });
  const newerStarted = new Promise(resolve => { writeStarted = resolve; });
  const closing = useStore.getState().closeTab(file);
  await new Promise(setImmediate);
  assert.equal(writes, 1, 'A newer save must wait for the older disk write');
  finishOlder();
  await older;
  assert.equal(await newerStarted, 'print("Newest edits")');
  finishNewer();
  await closing;
  assert.equal(diskText, 'print("Newest edits")', 'Closing cannot leave an older write that overwrites the newest data');
  assert.equal(models.getDoc(file), undefined, 'Closing proceeds after the newest write finishes');

  reset();
  let failOlder;
  writeBarrier = new Promise((_resolve, reject) => { failOlder = reject; });
  const failedStarted = new Promise(resolve => { writeStarted = resolve; });
  const failed = useStore.getState().save(file);
  await failedStarted;
  const retry = useStore.getState().save(file);
  writeBarrier = null;
  failOlder(new Error('Disk is full'));
  assert.equal(await failed, false);
  assert.equal(await retry, true, 'A failed pending save does not reject a queued retry');
  assert.equal(errors.length, 1);

  reset();
  writes = 0;
  let finishDisposed;
  writeBarrier = new Promise(resolve => { finishDisposed = resolve; });
  const disposedStarted = new Promise(resolve => { writeStarted = resolve; });
  const disposedSave = useStore.getState().save(file);
  await disposedStarted;
  models.disposeDoc(file);
  models.createDoc(file, 'print("Reopened")').model.setValue('print("Reopened edits")');
  writeBarrier = null;
  const reopenedSave = useStore.getState().save(file);
  await new Promise(setImmediate);
  assert.equal(writes, 1, 'Reopening a path does not bypass its pending disk write');
  finishDisposed();
  assert.equal(await disposedSave, false);
  assert.equal(await reopenedSave, true);
  assert.equal(diskText, 'print("Reopened edits")');

  const secondFile = 'C:\\Test\\other.swift';
  for (const action of [() => useStore.getState().closeProject(), () => useStore.getState().build('build'), () => requestClose()]) {
    reset();
    builds = quits = 0;
    models.createDoc(secondFile, 'print("Clean at save start")');
    useStore.setState({ tabs: [file, secondFile] });
    let finishBatch;
    writeBarrier = new Promise(resolve => { finishBatch = resolve; });
    const batchStarted = new Promise(resolve => { writeStarted = resolve; });
    const pending = action();
    await batchStarted;
    models.getDoc(secondFile).model.setValue('print("Edited during another save")');
    finishBatch();
    await pending;
    assert.ok(models.getDoc(secondFile), 'A newly dirty second file prevents project close');
    assert.ok(models.isDirty(secondFile));
    assert.equal(builds + quits, 0, 'A newly dirty second file blocks build and quit');
    writeBarrier = null;
  }

  for (const action of [() => useStore.getState().closeTab(file), () => useStore.getState().closeProject(), () => useStore.getState().build('build'), () => requestClose()]) {
    reset();
    builds = quits = 0;
    let finishUndone;
    writeBarrier = new Promise(resolve => { finishUndone = resolve; });
    const undoStarted = new Promise(resolve => { writeStarted = resolve; });
    const oldSave = useStore.getState().save(file);
    await undoStarted;
    models.getDoc(file).model.undo();
    assert.equal(models.isDirty(file), false, 'Undo returns to the saved alternative version');
    writeBarrier = null;
    let finished = false;
    const pending = action().then(() => { finished = true; });
    await new Promise(setImmediate);
    assert.equal(finished, false, 'Close/build/quit must wait for a write of undone content');
    assert.ok(models.getDoc(file));
    assert.equal(builds + quits, 0);
    finishUndone();
    await oldSave;
    await pending;
    assert.equal(diskText, 'print("Original")', 'Pending stale text cannot overwrite the undone content');
  }
  console.log('PASS: failed and outdated saves preserve edits and block close/build/update/quit; successful saves permit closing.');
}

check().catch(error => { console.error(error); process.exitCode = 1; });
