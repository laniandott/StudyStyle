const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('app.js initializes, renders all views, and completes full card & review lifecycle without error', async () => {
  const root = path.resolve(__dirname, '..');
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const styles = ['styles/tokens.css', 'styles/layout.css', 'styles/components.css', 'styles/views.css', 'styles/glass-responsive.css']
    .map(file => fs.readFileSync(path.join(root, file), 'utf8')).join('\n');
  const domainCode = fs.readFileSync(path.join(root, 'domain.cjs'), 'utf8');
  const clientFiles = ['src/state.js', 'src/store.js', 'src/views.js', 'src/review.js', 'app.js'];
  const clientCodes = clientFiles.map(file => fs.readFileSync(path.join(root, file), 'utf8'));

  assert.match(html, /<details class="top-tools-menu action-menu">/);
  assert.match(html, /id="themeToggleButton"/);
  assert.match(html, /id="helpDialogButton"/);
  assert.match(html, /id="settingsButton"/);
  assert.match(html, /<details class="top-tools-menu action-menu">[\s\S]*<button class="action-menu-item" id="settingsButton"[^>]*data-view="settings"/);
  assert.match(html, /<link rel="manifest" href="manifest\.webmanifest"/);
  assert.match(html, /<link rel="apple-touch-icon" sizes="180x180" href="apple-touch-icon\.png"/);
  assert.match(html, /id="themeColorMeta"/);
  assert.match(styles, /\.top-tools-menu \.action-menu-panel\s*\{\s*left:\s*auto;\s*right:\s*0;/);
  assert.match(styles, /\.top-tools-menu \.action-menu-panel\s*\{\s*position:\s*fixed;\s*top:[^}]+left:\s*auto;\s*right:\s*var\(--sp-3\);/);

  class MockClassList {
    constructor() { this.set = new Set(); }
    add(...cls) { cls.forEach(c => this.set.add(c)); }
    remove(...cls) { cls.forEach(c => this.set.delete(c)); }
    toggle(c, force) {
      if (force === undefined) {
        if (this.set.has(c)) { this.set.delete(c); return false; }
        this.set.add(c); return true;
      }
      if (force) this.set.add(c); else this.set.delete(c);
      return !!force;
    }
    contains(c) { return this.set.has(c); }
  }

  const elementsById = new Map();
  function getOrCreateEl(id) {
    if (!elementsById.has(id)) {
      elementsById.set(id, {
        id,
        textContent: '',
        innerHTML: '',
        outerHTML: '',
        value: '',
        disabled: false,
        hidden: false,
        open: false,
        returnValue: '',
        dataset: {},
        attributes: {},
        style: {},
        classList: new MockClassList(),
        listeners: {},
        setAttribute(k, v) { this.attributes[k] = String(v); },
        elements: new Proxy({}, {
          get(target, prop) {
            if (!target[prop]) target[prop] = { value: '' };
            return target[prop];
          }
        }),
        addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); },
        reset() { for (const k of Object.keys(this.elements)) this.elements[k].value = ''; },
        showModal() { this.open = true; },
        close() { this.open = false; (this.listeners.close || []).forEach(fn => fn()); },
        focus() {},
        click() {},
        setSelectionRange() {},
        appendChild() {},
        querySelector(sel) {
          if (sel === '.cloze-mask' && this.innerHTML.includes('cloze-mask')) return {};
          return null;
        },
        requestSubmit() { (this.listeners.submit || []).forEach(fn => fn({ preventDefault() {}, currentTarget: this })); }
      });
    }
    return elementsById.get(id);
  }

  for (const m of html.matchAll(/id="([^"]+)"/g)) getOrCreateEl(m[1]);

  const storage = new Map();
  const sandbox = {
    console,
    assert,
    setTimeout: () => 1,
    clearTimeout: () => {},
    setInterval: () => 1,
    clearInterval: () => {},
    crypto: { randomUUID: () => 'uuid-' + Math.random().toString(16).slice(2) },
    Blob: class { constructor(parts) { this.parts = parts; } },
    URL: Object.assign(URL, { createObjectURL: () => 'blob:test', revokeObjectURL: () => {} }),
    Element: class {},
    addEventListener() {},
    localStorage: {
      getItem: (k) => storage.get(k) ?? null,
      setItem: (k, v) => storage.set(k, String(v)),
      removeItem: (k) => storage.delete(k)
    },
    document: {
      title: '',
      documentElement: { dataset: {} },
      head: { appendChild() {} },
      createElement: (tag) => getOrCreateEl('created:' + tag),
      addEventListener() {},
      querySelector(sel) {
        if (sel.startsWith('#')) {
          const id = sel.slice(1);
          if (elementsById.has(id)) return elementsById.get(id);
          const viewHtml = elementsById.get('viewRoot')?.innerHTML || '';
          if (viewHtml.includes(`id="${id}"`)) return getOrCreateEl(id);
        }
        return null;
      },
      querySelectorAll() { return []; }
    }
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;

  vm.createContext(sandbox);
  vm.runInContext(domainCode, sandbox);
  for (const code of clientCodes) vm.runInContext(code, sandbox);

  await new Promise(r => setTimeout(r, 30));
  // 今日页首屏：h1「今日复习」+ 任务带（规范 §9 标题行不再有副标题）
  assert.ok(elementsById.get('viewRoot').innerHTML.includes('今日复习'));

  await vm.runInContext(`(async () => {
    await openCardDialog();
    await saveCard({ id: '', title: '光合作用', outline: '- **光反应**\\n- 暗反应', tags: ['生物'], due_date: localDay() });
    await render();
    view = 'library';
    await render();
    view = 'settings';
    await render();
    view = 'today';
    await render();
    await beginReview();
    await selectScore(30, 1);
    await saveReview({ preventDefault() {} });
    await undoLastReview();
    await beginReview();
    await selectScore(30, 1);
    await saveReview({ preventDefault() {} });
    await saveCard({ id: '', title: '呼吸作用', outline: '1. ==有氧呼吸==\\n2. 无氧呼吸', tags: ['生物'], due_date: addDays(localDay(), 2) });
    await beginRandomReview();
    await rerollRandomCard();
    await selectScore(90, 4);
    finishAfterSave = true;
    await saveReview({ preventDefault() {} });
    view = 'library';
    await render();
    assert.ok($('#viewRoot').innerHTML.includes('library-more-menu'));
    assert.ok($('#viewRoot').innerHTML.includes('view-mode-switch'));
    assert.ok($('#viewRoot').innerHTML.includes('libraryFilterDrawer'));
    assert.ok(markdownToHtml('==重点==').includes('cloze-mask'));
    await toggleTheme();
    assert.equal(document.documentElement.dataset.theme, 'dark');
    assert.equal($('#themeColorMeta').attributes.content, '#0D1020');
    await toggleTheme();
    assert.equal(document.documentElement.dataset.theme, 'light');
    assert.equal($('#themeColorMeta').attributes.content, '#EEF0FF');
    view = 'settings';
    await render();
    assert.ok($('#viewRoot').innerHTML.includes('install-pwa') || $('#viewRoot').innerHTML.includes('refresh-pwa-cache'));
    await openCardDialog();
    assert.equal($('#cardMetaFold').open, false);
    insertMarkdownFormat('bold');
    insertMarkdownFormat('cloze');
    assert.ok($('#cardOutline').value.includes('**重点词**'));
    assert.ok($('#cardOutline').value.includes('==挖空内容=='));
    await seedDemoCards();
    view = 'today';
    await render();
    assert.ok($('#viewRoot').innerHTML.includes('today-head'));
    assert.ok($('#viewRoot').innerHTML.includes('today-more-menu'));
    assert.ok($('#viewRoot').innerHTML.includes('data-action="start-today"'));
    assert.ok($('#viewRoot').innerHTML.includes('data-action="start-mixed"'));
    assert.ok($('#viewRoot').innerHTML.includes('progress-ring'));
    assert.ok($('#viewRoot').innerHTML.includes('mastery-stack'));
    assert.ok($('#viewRoot').innerHTML.includes('ios-fold-card'));
    await beginReview();
    assert.ok($('#scoreButtons').innerHTML.includes('score-kbd'));
    $('#reviewForm').elements.recall.value = '类囊体薄膜 ATP';
    updateKeyTermCheck();
    assert.ok($('#keyTermCheckBar').innerHTML.includes('命中'));
    assert.ok($('#keyTermCheckBar').innerHTML.includes('不作为掌握度评分'));
    assert.ok(!$('#keyTermCheckBar').innerHTML.includes('data-recommend-score'));
    goToStepTwo(null);
    assert.equal($('#recallInput').readOnly, true);
    beginFeedbackRecall();
    assert.ok($('#recallPanel').classList.contains('hidden'));
    assert.ok($('#reviewAnswerContent').classList.contains('hidden'));
    $('#feedbackRecallInput').value = '看过答案后的补充';
    finishFeedbackRecall();
    assert.ok(!$('#reviewAnswerContent').classList.contains('hidden'));
    await goToStepThree();
    await selectScore(70, 3);
    await saveReview({ preventDefault() {} });
    const feedbackReview = (await getReviews()).find(row => row.recall_draft === '类囊体薄膜 ATP');
    assert.equal(feedbackReview.recall_after_feedback, '看过答案后的补充');
    view = 'library';
    batchMode = true;
    await render();
    assert.ok($('#viewRoot').innerHTML.includes('batchDock'));
    assert.ok($('#viewRoot').innerHTML.includes('batchMdInput'));
    $('#batchMdInput').value = '# 操作系统进程\\n- 进程是资源分配的基本单位\\n## 线程\\n- 线程是调度的基本单位';
    $('#batchMdTags').value = 'OS';
    await batchCreateFromMarkdown();
    const allCardsAfterBatch = await getCards();
    assert.ok(allCardsAfterBatch.some(c => c.title === '操作系统进程'));
    assert.ok(allCardsAfterBatch.some(c => c.title === '线程'));
    insertNoteTemplate('cornell');
    assert.ok($('#cardOutline').value.includes('核心问题 / 线索'));
    applyStudyMethodUI('cornell', { outline: '- 核心阶段：==类囊体== 场所' });
    assert.ok($('#cornellCuesBox').innerHTML.includes('<details>'));
    assert.ok($('#cornellCuesBox').innerHTML.includes('[ ___ ]'));
    applyStudyMethodUI('feynman', { outline: '- 核心阶段' });
    assert.ok($('#cornellCuesBox').innerHTML.includes('解释与举例'));
    view = 'settings';
    await render();
    assert.ok($('#viewRoot').innerHTML.includes('preset-curve-card'));
    assert.ok($('#viewRoot').innerHTML.includes('defaultStudyMethodSelect'));
    assert.ok($('#viewRoot').innerHTML.includes('dailyLimitSelect'));
    assert.ok($('#viewRoot').innerHTML.includes('couchRememberCheck'));
    saveVerifiedCouchCreds({ url: 'https://db.example.com', name: 'studystyle', user: 'alice', password: 'secret-pass-value', autoConnect: true });
    await render();
    const settingsHtml = $('#viewRoot').innerHTML;
    assert.ok(settingsHtml.includes('value="https://db.example.com"'));
    assert.ok(settingsHtml.includes('value="secret-pass-value"'));
    assert.ok(settingsHtml.includes('forget-couch'));
    assert.ok(!localStorage.getItem(LOCAL_KEY).includes('secret-pass-value'), 'CouchDB 密码不得写入业务同步库');
    await disconnectCouch();
    assert.equal(loadSavedCouchCreds().autoConnect, false);
    await forgetSavedCouch();
    assert.equal(loadSavedCouchCreds(), null);
    await balanceOverdueNow();
    await openNotebookDialog();
    $('#notebookNameInput').value = '高等数学';
    selectedNotebookColor = 'emerald';
    await saveNotebookFromDialog({ preventDefault() {} });
    assert.equal(activeNotebookFilter, '高等数学');
    await openCardDialog();
    $('#cardTitle').value = '泰勒公式展开';
    $('#cardOutline').value = '- 核心：用多项式逼近函数';
    $('#cardNotebook').value = '高等数学';
    await saveCardFromDialog({ preventDefault() {} });
    view = 'today';
    await render();
    assert.ok($('#viewRoot').innerHTML.includes('高等数学'));
    assert.ok($('#notebookNav').innerHTML.includes('高等数学'));
    activeNotebookFilter = null;
    view = 'history';
    await render();
    assert.ok($('#viewRoot').innerHTML.includes('history-timeline'));
  })()`, sandbox);

  const historyHtml = elementsById.get('viewRoot').innerHTML;
  assert.ok(historyHtml.includes('光合作用'));
  assert.ok(historyHtml.includes('30%'));
});


test('STORE_TOKEN 鉴权闭环与自适应记忆引擎状态持久化', async t => {
  const os = require('node:os');
  const { createStudyStyleServer } = await import('../server.mjs');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'studystyle-app-token-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const srv = createStudyStyleServer({
    dataDir: tmpDir,
    storeToken: 'token-xyz',
    logger: { log() {}, error() {} }
  });
  await new Promise(resolve => srv.listen(0, '127.0.0.1', resolve));
  const port = srv.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;
  t.after(() => new Promise(resolve => { srv.closeAllConnections?.(); srv.close(resolve); }));

  const root = path.resolve(__dirname, '..');
  const domainCode = fs.readFileSync(path.join(root, 'domain.cjs'), 'utf8');
  const clientFiles = ['src/state.js', 'src/store.js', 'src/views.js', 'src/review.js', 'app.js'];
  const clientCodes = clientFiles.map(file => fs.readFileSync(path.join(root, file), 'utf8'));

  const storage = new Map();
  const elements = new Map();
  function makeClassList(el) {
    const set = new Set();
    return {
      add: (...cls) => cls.forEach(c => set.add(c)),
      remove: (...cls) => cls.forEach(c => set.delete(c)),
      toggle: (c, force) => {
        if (force === undefined) { if (set.has(c)) { set.delete(c); return false; } set.add(c); return true; }
        if (force) set.add(c); else set.delete(c);
        return Boolean(force);
      },
      contains: c => set.has(c)
    };
  }
  function getEl(id) {
    if (!elements.has(id)) {
      const el = {
        id,
        value: '',
        innerHTML: '',
        textContent: '',
        disabled: false,
        readOnly: false,
        open: false,
        checked: false,
        dataset: {},
        style: {},
        elements: { recall: null, note: null },
        close() { this.open = false; },
        showModal() { this.open = true; },
        focus() {},
        click() {},
        addEventListener() {},
        setAttribute() {},
        removeAttribute() {},
        querySelector() { return null; },
        querySelectorAll() { return []; },
        closest() { return null; }
      };
      el.classList = makeClassList(el);
      elements.set(id, el);
    }
    return elements.get(id);
  }
  const recallEl = getEl('recallInput');
  const noteEl = getEl('reviewNote');
  const reviewForm = getEl('reviewForm');
  reviewForm.elements = { recall: recallEl, note: noteEl };

  const sandbox = {
    console, Math, Date, JSON, Set, Map, Array, Object, String, Number, Boolean, Error, Promise, URL, URLSearchParams,
    setTimeout, clearTimeout, setInterval: () => 0, clearInterval: () => {},
    Element: class {},
    addEventListener() {},
    removeEventListener() {},
    crypto: { randomUUID: () => 'test-' + Math.random().toString(16).slice(2, 10) },
    fetch: (u, opts = {}) => globalThis.fetch(`${baseUrl}${u}`, opts),
    localStorage: {
      getItem: k => (storage.has(k) ? storage.get(k) : null),
      setItem: (k, v) => storage.set(k, String(v)),
      removeItem: k => storage.delete(k)
    },
    navigator: { onLine: true },
    matchMedia: () => ({ matches: false }),
    location: { protocol: 'http:', hostname: '127.0.0.1', search: '' },
    document: {
      title: '',
      visibilityState: 'visible',
      documentElement: { dataset: {} },
      head: { appendChild() {} },
      createElement: tag => getEl('tag:' + tag),
      addEventListener() {},
      querySelector: sel => (sel.startsWith('#') ? getEl(sel.slice(1)) : null),
      querySelectorAll: () => []
    }
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(domainCode, sandbox);
  for (const code of clientCodes) vm.runInContext(code, sandbox);

  await new Promise(r => setTimeout(r, 80));
  assert.equal(vm.runInContext('serverTokenRequired', sandbox), true, '未设令牌时应识别 401');

  await vm.runInContext(`(async () => {
    saveStoreToken('token-xyz');
    await hydrateFromServerStore();
    await saveCard({ id: '', title: 'Token测试卡', outline: '- **FSRS** 稳定度', tags: ['算法'], due_date: localDay() });
    flushServerStore();
  })()`, sandbox);
  await new Promise(r => setTimeout(r, 120));

  assert.equal(vm.runInContext('serverTokenRequired', sandbox), false);
  assert.equal(storage.get('studystyle-store-token-v1'), 'token-xyz');

  const srvStore = await (await fetch(`${baseUrl}/api/store`, { headers: { 'X-Store-Token': 'token-xyz' } })).json();
  const srvCard = srvStore.docs.find(d => d.title === 'Token测试卡');
  assert.ok(srvCard, '携带令牌保存的卡片必须写入服务端');
  assert.ok(!JSON.stringify(srvStore.docs).includes('token-xyz'), '访问令牌绝不能写入同步文档');

  // 验证空回忆提示与自适应参数持久化
  const cardAfter = await vm.runInContext(`(async () => {
    const cards = await getCards();
    const target = cards.find(c => c.title === 'Token测试卡');
    reviewQueue = [target];
    reviewIndex = 0;
    reviewMode = 'due';
    await showReviewCard();
    // 空回忆直接翻面
    document.querySelector('#recallInput').value = '';
    goToStepTwo(null);
    const blankWarnVisible = !document.querySelector('#blankRecallWarning').classList.contains('hidden');
    // 选择 90 分，应提示空草稿谨慎打高分，并写出 adaptive stability/difficulty
    selectScore(90, 4);
    const preselectNotice = document.querySelector('#scorePreselectHint').textContent;
    await saveReview({ preventDefault() {} });
    const updated = await db.get(target._id);
    const reviews = await getReviews();
    return { blankWarnVisible, preselectNotice, updated, review: reviews[0] };
  })()`, sandbox);

  assert.equal(cardAfter.blankWarnVisible, true, '空草稿翻面必须弹出书面回忆提示');
  assert.match(cardAfter.preselectNotice, /未填写书面回忆草稿/);
  assert.ok(Number.isFinite(cardAfter.updated.stability) && cardAfter.updated.stability > 0, 'adaptive 模式必须保存 stability');
  assert.ok(Number.isFinite(cardAfter.updated.difficulty), 'adaptive 模式必须保存 difficulty');
  assert.equal(cardAfter.updated.reps, 1);
  assert.equal(cardAfter.updated.lapses, 0);
  assert.ok(cardAfter.updated.next_interval_days >= 1);
  assert.equal(cardAfter.review.stability_after, cardAfter.updated.stability);
});


test('CouchDB / PouchDB 变更桥接回写 /api/store', async t => {
  const os = require('node:os');
  const { createStudyStyleServer } = await import('../server.mjs');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'studystyle-pouch-bridge-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const srv = createStudyStyleServer({ dataDir: tmpDir, logger: { log() {}, error() {} } });
  await new Promise(resolve => srv.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${srv.address().port}`;
  t.after(() => new Promise(resolve => { srv.closeAllConnections?.(); srv.close(resolve); }));

  const root = path.resolve(__dirname, '..');
  const domainCode = fs.readFileSync(path.join(root, 'domain.cjs'), 'utf8');
  const clientFiles = ['src/state.js', 'src/store.js', 'src/views.js', 'src/review.js', 'app.js'];
  const clientCodes = clientFiles.map(file => fs.readFileSync(path.join(root, file), 'utf8'));

  const pouchDocs = new Map();
  let changeListeners = [];
  let syncChangeListeners = [];
  function FakePouchDB() {
    this.allDocs = async () => ({
      rows: [...pouchDocs.values()].filter(d => !d._deleted).map(d => ({ doc: { ...d } }))
    });
    this.get = async id => {
      const doc = pouchDocs.get(id);
      if (!doc || doc._deleted) throw { status: 404 };
      return { ...doc };
    };
    this.put = async doc => {
      const copy = { ...doc, _rev: doc._rev || `1-${Math.random().toString(16).slice(2, 8)}` };
      pouchDocs.set(copy._id, copy);
      changeListeners.forEach(fn => fn({ id: copy._id, deleted: Boolean(copy._deleted), doc: copy }));
      return { ok: true, id: copy._id, rev: copy._rev };
    };
    this.changes = () => {
      const api = {
        on(event, fn) {
          if (event === 'change') changeListeners.push(fn);
          return api;
        },
        cancel() { changeListeners = []; }
      };
      return api;
    };
    this.sync = () => {
      const api = {
        on(event, fn) {
          if (event === 'change') syncChangeListeners.push(fn);
          (syncEventListeners[event] ||= []).push(fn);
          return api;
        },
        cancel() { syncChangeListeners = []; }
      };
      return api;
    };
  }
  const syncEventListeners = {};

  const storage = new Map();
  const elements = new Map();
  const stubEl = id => {
    if (!elements.has(id)) {
      elements.set(id, {
        id, innerHTML: '', textContent: '', value: '', open: false, dataset: {}, style: {},
        classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
        elements: { recall: { value: '' }, note: { value: '' } },
        setAttribute() {}, removeAttribute() {}, addEventListener() {},
        querySelector() { return null; }, querySelectorAll() { return []; }
      });
    }
    return elements.get(id);
  };

  const sandbox = {
    console, Math, Date, JSON, Set, Map, Array, Object, String, Number, Boolean, Error, Promise, URL, URLSearchParams,
    setTimeout, clearTimeout, setInterval: () => 0, clearInterval: () => {},
    Element: class {},
    addEventListener() {},
    removeEventListener() {},
    crypto: { randomUUID: () => 'bridge-' + Math.random().toString(16).slice(2, 8) },
    fetch: (u, opts = {}) => globalThis.fetch(`${baseUrl}${u}`, opts),
    localStorage: {
      getItem: k => (storage.has(k) ? storage.get(k) : null),
      setItem: (k, v) => storage.set(k, String(v)),
      removeItem: k => storage.delete(k)
    },
    navigator: { onLine: true },
    matchMedia: () => ({ matches: false }),
    location: { protocol: 'http:', hostname: '127.0.0.1', search: '' },
    PouchDB: FakePouchDB,
    document: {
      title: '',
      visibilityState: 'visible',
      documentElement: { dataset: {} },
      head: { appendChild() {} },
      createElement: tag => stubEl('tag:' + tag),
      addEventListener() {},
      querySelector: sel => (sel.startsWith('#') ? stubEl(sel.slice(1)) : null),
      querySelectorAll: () => []
    }
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(domainCode, sandbox);
  for (const code of clientCodes) vm.runInContext(code, sandbox);

  await new Promise(r => setTimeout(r, 80));
  await vm.runInContext(`(async () => {
    await migrateLocalDocsToPouch();
    await db.put({
      _id: 'card:from-couch',
      type: 'card',
      title: '远端 Couch 同步卡',
      outline: '- 通过 bridge 同步到服务端',
      due_date: localDay(),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    });
    await new Promise(r => setTimeout(r, 20));
    flushServerStore();
  })()`, sandbox);
  await new Promise(r => setTimeout(r, 150));

  const srvDocs = await (await fetch(`${baseUrl}/api/store`)).json();
  assert.ok(srvDocs.docs.some(d => d._id === 'card:from-couch' && d.title === '远端 Couch 同步卡'), `PouchDB/CouchDB 变更必须回写到 /api/store，实际: ${JSON.stringify(srvDocs.docs.map(d => d._id))}`);

  // 服务端 CouchDB 安全代理连接：浏览器端只保存 mode: 'proxy' 与库名，不存储任何密码
  let usedProxyUrl = '';
  sandbox.PouchDB = class ProxyRecordingPouchDB extends FakePouchDB {
    constructor(name, opts) {
      super(name, opts);
      if (String(name).includes('/api/couch/db/')) usedProxyUrl = name;
    }
    async info() { return { db_name: 'studystyle' }; }
    async put(doc) { return { ok: true, id: doc._id, rev: '1-probe' }; }
    async remove() { return { ok: true }; }
    sync() {
      const h = {
        on() { return h; },
        cancel() {}
      };
      return h;
    }
  };
  await vm.runInContext(`(async () => {
    window.location = { origin: '${baseUrl}', protocol: 'http:', hostname: '127.0.0.1', search: '' };
    await connectCouch(false, null, true);
  })()`, sandbox);
  assert.ok(usedProxyUrl.startsWith(`${baseUrl}/api/couch/db/`), 'proxy 模式必须连接同源 /api/couch/db/');
  const savedProxy = JSON.parse(storage.get('studystyle-couch-local-v1') || '{}');
  assert.equal(savedProxy.mode, 'proxy');
  assert.equal(savedProxy.password, undefined, 'proxy 模式不得在浏览器保存任何密码');

  // CouchDB 双向 sync 拉取远端删除墓碑时（即便 pouch.changes 未先触发），也不得从服务端旧副本复活
  pouchDocs.delete('card:from-couch');
  for (const fn of syncChangeListeners) {
    await fn({
      direction: 'pull',
      change: { docs: [{ _id: 'card:from-couch', _rev: '2-del', _deleted: true }] }
    });
  }
  await vm.runInContext('flushServerStore()', sandbox);
  await new Promise(r => setTimeout(r, 150));
  const srvDocsAfterDel = await (await fetch(`${baseUrl}/api/store`)).json();
  const couchCardOnServer = srvDocsAfterDel.docs.find(d => d._id === 'card:from-couch');
  assert.equal(Boolean(couchCardOnServer?._deleted), true, `CouchDB 拉取的删除墓碑不得在 /api/store 复活，实际: ${JSON.stringify(couchCardOnServer)}`);

  // PouchDB 模式下编辑旧文档必须刷新 updated_at，否则服务端「同时间戳服务端胜」会静默丢弃编辑
  await vm.runInContext(`(async () => {
    await db.put({ _id: 'card:edit-me', type: 'card', title: '编辑前', outline: '- a', due_date: localDay(), updated_at: '2020-01-01T00:00:00.000Z' });
  })()`, sandbox);
  assert.notEqual(pouchDocs.get('card:edit-me').updated_at, '2020-01-01T00:00:00.000Z', 'PouchDB 写入应统一打上最新 updated_at');
  await new Promise(r => setTimeout(r, 10));
  const stampBefore = pouchDocs.get('card:edit-me').updated_at;
  await vm.runInContext(`(async () => {
    const doc = await db.get('card:edit-me');
    await db.put({ ...doc, title: '编辑后' });
    await new Promise(r => setTimeout(r, 20));
    flushServerStore();
  })()`, sandbox);
  assert.ok(pouchDocs.get('card:edit-me').updated_at > stampBefore, '编辑后 updated_at 必须前进');
  await new Promise(r => setTimeout(r, 200));
  const srvAfterEdit = await (await fetch(`${baseUrl}/api/store`)).json();
  assert.equal(srvAfterEdit.docs.find(d => d._id === 'card:edit-me')?.title, '编辑后', 'CouchDB 模式下的编辑必须送达 /api/store');

  // PouchDB 模式下非法 _id 写入被拒绝
  const badIdRejected = await vm.runInContext(`db.put({ _id: 'bad"id', type: 'card' }).then(() => false, e => /非法/.test(e.message))`, sandbox);
  assert.equal(badIdRejected, true);

  // 未接 CouchDB 的其它设备经 /api/store 写入的变更，必须回灌进本机 PouchDB（界面读的是 PouchDB），且保留原时间戳
  const remoteStamp = '2030-01-01T00:00:00.000Z';
  const putRes = await fetch(`${baseUrl}/api/store`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      mode: 'delta',
      base_rev: srvAfterEdit.rev,
      docs: [{ _id: 'card:from-server-only', type: 'card', title: '仅服务端设备新增', outline: '- s', due_date: '2030-01-01', updated_at: remoteStamp }]
    })
  });
  assert.equal(putRes.ok, true);
  const hydrateRes = await vm.runInContext(`hydrateFromServerStore({ incremental: true })`, sandbox);
  assert.equal(hydrateRes.changed, true);
  const backfilled = pouchDocs.get('card:from-server-only');
  assert.ok(backfilled, '服务端变更必须回灌进 PouchDB');
  assert.equal(backfilled.updated_at, remoteStamp, '回灌不得重打时间戳，避免多设备乒乓');

  // paused(err) 断网重连状态不得被后续 render() 冲回「已同步」
  for (const fn of syncEventListeners.paused || []) fn(new Error('net down'));
  assert.equal(vm.runInContext('couchSyncPhase', sandbox), 'reconnecting');
  await vm.runInContext('render()', sandbox);
  assert.equal(elements.get('syncLabel')?.textContent, 'CouchDB 重连中', 'render() 不得覆盖 CouchDB 重连中指示器');

  // 同步遇到致命错误后必须释放句柄，网络恢复时才能自动重连
  for (const fn of syncEventListeners.error || []) fn(new Error('boom'));
  assert.equal(vm.runInContext('syncHandler', sandbox), null, 'sync error 后应释放 syncHandler');
  assert.equal(vm.runInContext('couchSyncPhase', sandbox), 'idle');

  // PouchDB 模式下 importData：恢复曾删除卡片时不因旧墓碑被吞、保留现有 settings.couch 并同步主题至 DOM
  const backupJson = JSON.stringify({
    docs: [
      { _id: 'card:from-couch', type: 'card', title: '备份恢复卡', outline: '- restored', due_date: '2030-01-02' },
      { _id: 'settings:main', type: 'settings', theme: 'dark', study_method: 'feynman' }
    ]
  });
  sandbox.__backupFile = { text: async () => backupJson };
  await vm.runInContext('importData(__backupFile)', sandbox);
  await new Promise(r => setTimeout(r, 150));
  assert.equal(sandbox.document.documentElement.dataset.theme, 'dark', '导入或同步深色设置后 render() 应立即同步 dataset.theme');
  const savedSettingAfterImport = await vm.runInContext('getSetting()', sandbox);
  assert.equal(savedSettingAfterImport?.couch?.mode, 'proxy', '导入不含 couch 的备份不得抹掉当前已配置的 CouchDB 连接信息');
  const srvAfterImport = await (await fetch(`${baseUrl}/api/store`)).json();
  const restoredOnServer = srvAfterImport.docs.find(d => d._id === 'card:from-couch');
  assert.equal(Boolean(restoredOnServer && !restoredOnServer._deleted), true, '通过 JSON 备份重新导入曾删卡片应在服务端恢复存活');
  assert.equal(restoredOnServer?.title, '备份恢复卡');

  // 代理模式 fetch 包装：PouchDB 传入 Headers 实例时必须保留 Content-Type，并附加 X-Store-Token
  const merged = vm.runInContext(`(() => {
    const h = new Map([['Content-Type', 'application/json'], ['Accept', 'application/json']]);
    return mergeFetchHeaders(h, { 'X-Store-Token': 't0k' });
  })()`, sandbox);
  assert.equal(merged['content-type'], 'application/json', 'Headers 实例中的 Content-Type 不得在代理包装中丢失');
  assert.equal(merged.accept, 'application/json');
  assert.equal(merged['x-store-token'], 't0k');
  const mergedPlain = vm.runInContext(`mergeFetchHeaders({ 'Content-Type': 'application/json' }, {})`, sandbox);
  assert.equal(mergedPlain['content-type'], 'application/json');

  // CouchDB _design/* 与 _local/* 内部文档不得混入 /api/store 推送，也不得阻塞后续正常卡片 delta 同步
  pouchDocs.set('_design/idx', { _id: '_design/idx', _rev: '1-dd', language: 'query', views: {} });
  pouchDocs.set('_local/ckpt', { _id: '_local/ckpt', _rev: '0-1', seq: 42 });
  for (const fn of syncChangeListeners) {
    await fn({
      direction: 'pull',
      change: { docs: [{ _id: '_design/idx', _rev: '1-dd', language: 'query' }] }
    });
  }
  await vm.runInContext(`(async () => {
    await db.put({
      _id: 'card:after-design',
      type: 'card',
      title: '设计文档之后的正常卡',
      outline: '- ok',
      due_date: localDay()
    });
    await new Promise(r => setTimeout(r, 20));
    flushServerStore();
  })()`, sandbox);
  await new Promise(r => setTimeout(r, 150));
  const srvAfterDesign = await (await fetch(`${baseUrl}/api/store`)).json();
  assert.equal(srvAfterDesign.docs.some(d => String(d._id || '').startsWith('_')), false, '_design/_local 内部文档不得进入 /api/store');
  assert.equal(srvAfterDesign.docs.some(d => d._id === 'card:after-design'), true, '_design 文档存在时后续正常卡片仍须成功推上 /api/store');
});
