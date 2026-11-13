const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('app.js initializes, renders all views, and completes full card & review lifecycle without error', async () => {
  const root = path.resolve(__dirname, '..');
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const styles = fs.readFileSync(path.join(root, 'styles.css'), 'utf8');
  const domainCode = fs.readFileSync(path.join(root, 'domain.cjs'), 'utf8');
  const appCode = fs.readFileSync(path.join(root, 'app.js'), 'utf8');

  assert.match(html, /<details class="top-tools-menu action-menu">/);
  assert.match(html, /id="themeToggleButton"/);
  assert.match(html, /id="helpDialogButton"/);
  assert.match(html, /id="settingsButton"/);
  assert.match(html, /<details class="top-tools-menu action-menu">[\s\S]*<button class="action-menu-item" id="settingsButton"[^>]*data-view="settings"/);
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
        style: {},
        classList: new MockClassList(),
        listeners: {},
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
  vm.runInContext(appCode, sandbox);

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
    await toggleTheme();
    assert.equal(document.documentElement.dataset.theme, 'light');
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
