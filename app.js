const Domain = window.StudyStyleDomain;
const INTERVALS = Domain.DEFAULT_INTERVALS;

/* ===================== 记忆等级（6 级靛蓝单色相） =====================
   规范 §2.3：L1 中性灰（无记忆数据）+ L2–L6 靛蓝明度阶梯。
   颜色一律由 CSS token（--bag-l1..l6）承载，JS 只输出等级序号，不写死 hex。 */
const BAG_ORDER = [
  { key: 'l1', name: '待首次复习' },
  { key: 'l2', name: '待加强' },
  { key: 'l3', name: '较弱' },
  { key: 'l4', name: '一般' },
  { key: 'l5', name: '较好' },
  { key: 'l6', name: '熟悉' }
];
/* 5 档评分对应的等级名（与 L2–L6 同序），评分按钮另用完全忘记/忘记/… 文案 */
const BAG_NAMES = BAG_ORDER.slice(1).map(level => level.name);
const SCORE_PRESETS = [10, 30, 50, 70, 90];
const SCORE_GRADES = ['完全忘记', '忘记', '勉强', '记得', '很熟'];
const LEVEL_NAMES = BAG_ORDER.map(level => level.name);

const LOCAL_KEY = 'studystyle-fallback-v1';
const COUCH_LOCAL_CREDS_KEY = 'studystyle-couch-local-v1';
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const uuid = () => crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
const localDay = (date = new Date()) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
const addDays = (day, amount) => Domain.addLocalDays(day, amount);
const fmtDate = (day, opts = { month: 'short', day: 'numeric' }) => day ? new Date(`${day}T12:00:00`).toLocaleDateString('zh-CN', opts) : '未安排';
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const intervalFor = (card, intervals = INTERVALS) => Domain.intervalDays(card.interval_index, intervals);
/* 用宽容版取袋：导入的历史数据可能含脏分数，不能让整页渲染崩溃 */
const bagFor = card => Domain.scoreToBagSafe(card.latest_memory_score);
/* 等级下标：0 = L1 待首次复习 …… 5 = L6 熟悉 */
const bagIndex = card => bagFor(card) + 1;
const bagInfo = card => BAG_ORDER[bagIndex(card)];
const levelClass = index => `lv-${index + 1}`;
/* 等级 chip / 徽章：色点 + 文字，底色与字色走 token */
const badgeHtml = card => {
  const info = bagInfo(card);
  return `<span class="badge ${levelClass(bagIndex(card))}"><span class="bag-dot"></span>${info.name}</span>`;
};
/* 统一的图标输出（内联 sprite，stroke: currentColor） */
const icon = (name, cls = 'icon') => `<svg class="${cls}" aria-hidden="true" focusable="false"><use href="#i-${name}"></use></svg>`;

let db;
let pouchMode = false;
let syncHandler = null;
let view = 'today';
let activeBagFilter = null;
let activeNotebookFilter = null;
let selectedNotebookColor = 'indigo';
let activeHistoryCardFilter = null;
let libraryFilter = { query: '', tag: 'all', status: 'all', sort: 'due', layout: 'list' };
let uiFolds = { todayInsights: false, libraryFilters: false, libraryArchived: false, couchSettings: false, batchImporter: false, customLadder: false, importJson: false, pwaInfo: false };
let expandedCardIds = new Set();
let batchMode = false;
let selectedCardIds = new Set();
let activeRowMenuCardId = null;
let deferredInstallPrompt = null;
let swRegistration = null;
let couchStatusState = { text: '', variant: '' };
let couchConnectPromise = null;
let cardReviewStartedAt = 0;
let reviewTimerInterval = null;
let activeStudyMethod = 'blurting';
let reviewQueue = [];
let reviewIndex = 0;
let reviewMode = 'due';
let reviewStep = 1;
let preselectPending = null;
let firstRecallDraft = null;
let feedbackRecallMode = false;
let feedbackRecallDraft = null;
let currentReviewSettings = null;
let todaySettings = null;
let randomPool = [];
let randomDrawCount = 0;
let finishAfterSave = false;
let lastReviewSnapshot = null;
let selectedScore = null;
let selectedPreset = null;
/* 当前卡的低分策略选择（hold/reset/advance）：null 表示用户未手动选过，沿用全局默认 */
let lowCycleChoice = null;
let toastTimer;
let observedDay = localDay();
let pendingDayRefresh = false;
let longPressTimer = null;

let pouchReadyPromise = null;
function ensurePouchDB() {
  if (window.PouchDB) return Promise.resolve(window.PouchDB);
  if (pouchReadyPromise) return pouchReadyPromise;
  pouchReadyPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://cdn.jsdelivr.net/npm/pouchdb@9.0.0/dist/pouchdb.min.js';
    script.crossOrigin = 'anonymous';
    script.onload = () => window.PouchDB ? resolve(window.PouchDB) : reject(new Error('PouchDB 加载失败'));
    script.onerror = () => { pouchReadyPromise = null; reject(new Error('PouchDB 浏览器库无法从 CDN 加载，请检查网络')); };
    document.head.appendChild(script);
  });
  return pouchReadyPromise;
}

let serverStoreActive = false;
/* 服务端库版本号：服务端返回的 rev，用于乐观锁；服务端未升级时保持 null（走整库替换兼容路径） */
let serverRev = null;
/* 推送去抖：同一时间窗内的多次写入合并为一次全量 PUT，避免写放大 */
let pushTimer = null;
let pendingPushDocs = null;

function writeLocalDocs(docs) {
  try {
    localStorage.setItem(LOCAL_KEY, JSON.stringify(docs));
  } catch (error) {
    const isQuota = error?.name === 'QuotaExceededError' || error?.code === 22 || error?.code === 1014;
    const message = isQuota
      ? '本地存储空间已满，数据未保存。请导出备份后清理部分数据再重试。'
      : '本地保存失败，数据未写入浏览器存储。';
    showToast(message);
    throw new Error(message, { cause: error });
  }
}

/* 立即把待推送数据发出去（页面隐藏、导入完成等关键时机调用），避免防抖窗口内丢同步。
   注意：必须直连 pushServerStoreNow，若改走 pushServerStore 会重新进入防抖，导致关页时数据根本发不出去。 */
function flushServerStore() {
  if (pushTimer) { clearTimeout(pushTimer); pushTimer = null; }
  const docs = pendingPushDocs;
  pendingPushDocs = null;
  if (docs) pushServerStoreNow(docs);
}

function pushServerStore(docs) {
  if (typeof fetch !== 'function') return;
  pendingPushDocs = docs;
  if (pushTimer) clearTimeout(pushTimer);
  pushTimer = setTimeout(() => { pushTimer = null; const payload = pendingPushDocs; pendingPushDocs = null; if (payload) pushServerStoreNow(payload); }, 300);
}
function pushServerStoreNow(docs) {
  if (typeof fetch !== 'function') return;
  /* 携带 base_rev：服务端版本不一致时走合并而非整库覆盖，避免多设备互相抹除。
     尚未拿到服务端 rev 时先取一次，否则会退化成无条件整库覆盖（架构审计 P0-2）。 */
  if (!serverRev) {
    fetch('/api/store', { cache: 'no-store' })
      .then(r => (r.ok ? r.json() : null))
      .then(data => {
        if (!data || !data.rev) return;
        serverRev = data.rev;
        pushServerStoreNow(docs);
      })
      .catch(() => {});
    return;
  }
  const body = { docs, base_rev: serverRev };
  fetch('/api/store', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  }).then(r => { if (!r.ok) return; serverStoreActive = true; return r.json(); })
    .then(data => {
      if (data && data.rev) serverRev = data.rev;
      /* 服务端返回合并结果时再与当前本地状态合并，避免覆盖并发编辑 */
      if (data && data.merged && Array.isArray(data.docs)) {
        const localDocs = JSON.parse(localStorage.getItem(LOCAL_KEY) || '[]');
        const reconciled = Domain.reconcileDocSets(localDocs, data.docs);
        writeLocalDocs(reconciled.docs);
        showToast('已与服务器同步，合并了其他设备的更新');
        if (reconciled.needsPush) pushServerStore(reconciled.docs);
        render();
      }
    }).catch(() => {});
}

async function hydrateFromServerStore() {
  if (typeof fetch !== 'function') return;
  try {
    const res = await fetch('/api/store', { cache: 'no-store' });
    if (!res.ok) return;
    const data = await res.json();
    const remoteDocs = Array.isArray(data?.docs) ? data.docs : [];
    const localDocs = JSON.parse(localStorage.getItem(LOCAL_KEY) || '[]');
    serverStoreActive = true;
    /* 记录服务端版本号，后续推送带上 base_rev 走乐观锁 */
    if (data?.rev) serverRev = data.rev;
    if (remoteDocs.length === 0 && localDocs.length > 0) {
      pushServerStore(localDocs);
      return;
    }
    if (remoteDocs.length > 0) {
      /* 与服务端共用仲裁规则，墓碑始终代表删除意图。 */
      const reconciled = Domain.reconcileDocSets(localDocs, remoteDocs);
      writeLocalDocs(reconciled.docs);
      if (reconciled.needsPush) pushServerStore(reconciled.docs);
    }
  } catch {}
}

function createLocalStore() {
  /* 统一版本号：与 PouchDB 的 <数字>-<hash> 格式兼容，同毫秒内多次写入也不会撞号 */
  let revCounter = 0;
  const nextRev = () => `${++revCounter}-${Math.random().toString(16).slice(2, 10)}`;
  /* _id 会进入 HTML 属性（data-review-card 等），在存储层统一限定字符集，
     使所有写入路径自动免疫属性注入，不必依赖每个调用点自觉转义。 */
  const SAFE_ID = /^[A-Za-z0-9:._-]{1,128}$/;
  return {
    async allDocs() { const docs = JSON.parse(localStorage.getItem(LOCAL_KEY) || '[]'); return { rows: docs.map(doc => ({ doc })) }; },
    async get(id) { const doc = (JSON.parse(localStorage.getItem(LOCAL_KEY) || '[]')).find(item => item._id === id && !item._deleted); if (!doc) throw { status: 404 }; return doc; },
    async put(doc) { if (!SAFE_ID.test(String(doc?._id || ''))) throw new Error('非法的文档 _id'); const docs = JSON.parse(localStorage.getItem(LOCAL_KEY) || '[]'); const old = docs.findIndex(item => item._id === doc._id); doc._rev = nextRev(); doc.updated_at = new Date().toISOString(); if (old < 0) docs.push(doc); else docs[old] = doc; writeLocalDocs(docs); pushServerStore(docs); return { ok: true, id: doc._id }; },
    /* 删除写墓碑而非直接抹除：全量同步模型下「直接删除」会被服务端旧副本复活，
       墓碑让删除意图也能传播到其它设备（架构审计 P0-1）。 */
    async remove(doc) {
      const docs = JSON.parse(localStorage.getItem(LOCAL_KEY) || '[]');
      const rest = docs.filter(item => item._id !== doc._id);
      const tombstone = { _id: doc._id, _deleted: true, _rev: nextRev(), updated_at: new Date().toISOString(), deleted_at: new Date().toISOString() };
      rest.push(tombstone);
      writeLocalDocs(rest);
      pushServerStore(rest);
      return { ok: true };
    },
    /* 批量写入：本地逐条落盘，但只在循环结束后推送一次，避免 N 次全量 PUT */
    async bulkDocs(docs) {
      let all = JSON.parse(localStorage.getItem(LOCAL_KEY) || '[]');
      for (const doc of docs) {
        const old = all.findIndex(item => item._id === doc._id);
        doc._rev = nextRev(); doc.updated_at = new Date().toISOString();
        if (old < 0) all.push(doc); else all[old] = doc;
      }
      writeLocalDocs(all);
      pushServerStore(all);
      return [];
    }
  };
}

db = createLocalStore();

function applyTheme(theme = 'light') {
  const normalized = theme === 'dark' ? 'dark' : 'light';
  document.documentElement.dataset.theme = normalized;
  $('#themeColorMeta')?.setAttribute?.('content', normalized === 'dark' ? '#0D1020' : '#EEF0FF');
  const btn = $('#themeToggleButton');
  if (btn) {
    btn.innerHTML = icon(normalized === 'dark' ? 'sun' : 'moon', 'icon icon-20');
    btn.title = normalized === 'dark' ? '切换为浅色外观' : '切换为深色外观';
    btn.setAttribute?.('aria-label', normalized === 'dark' ? '切换为浅色外观' : '切换为深色外观');
  }
}

function isStandalonePwa() {
  return Boolean(
    (typeof window !== 'undefined' && window.matchMedia?.('(display-mode: standalone)')?.matches) ||
    (typeof navigator !== 'undefined' && navigator.standalone === true)
  );
}

function isPwaSecureContext() {
  if (typeof location === 'undefined') return false;
  return location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1';
}

function updateInstallControls() {
  const menuBtn = $('#pwaInstallMenuBtn');
  if (menuBtn) menuBtn.classList.toggle('hidden', !(deferredInstallPrompt && !isStandalonePwa()));
}

async function installPwaApp() {
  if (!deferredInstallPrompt) {
    showToast('请在浏览器菜单或分享面板中选择「添加到主屏幕」');
    return;
  }
  const promptEvent = deferredInstallPrompt;
  deferredInstallPrompt = null;
  updateInstallControls();
  try {
    await promptEvent.prompt();
    const choice = await promptEvent.userChoice;
    if (choice?.outcome === 'accepted') showToast('正在将 StudyStyle 安装到设备');
  } catch (err) {
    console.error(err);
  }
  if (view === 'settings') await render();
}

async function registerPwaServiceWorker() {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator) || !isPwaSecureContext()) return null;
  try {
    swRegistration = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
    return swRegistration;
  } catch (err) {
    console.error('SW registration failed:', err);
    return null;
  }
}

async function refreshPwaOfflineCache() {
  if (!swRegistration) swRegistration = await registerPwaServiceWorker();
  if (!swRegistration) {
    showToast(isPwaSecureContext() ? '当前环境不支持离线缓存组件' : '请通过 HTTPS 或 localhost 访问以启用离线缓存');
    return;
  }
  try {
    await swRegistration.update();
    if (swRegistration.waiting) swRegistration.waiting.postMessage({ type: 'SKIP_WAITING' });
    showToast('已检查并刷新离线应用缓存');
    if (view === 'settings') await render();
  } catch (err) {
    showToast(`刷新缓存失败：${err.message || err}`);
  }
}

async function toggleTheme() {
  const settings = (await getSetting()) || {};
  const next = settings.theme === 'dark' ? 'light' : 'dark';
  await saveSetting({ ...settings, theme: next });
  applyTheme(next);
  if (view === 'settings') await render();
  showToast(next === 'dark' ? '已切换至深色外观' : '已切换至浅色外观');
}

async function initStore() {
  if (!db) db = createLocalStore();
  pouchMode = false;
  if (typeof location !== 'undefined' && location.search && typeof URLSearchParams !== 'undefined') {
    const reqView = new URLSearchParams(location.search).get('view');
    if (['today', 'library', 'history', 'settings'].includes(reqView)) view = reqView;
  }
  void registerPwaServiceWorker();
  updateInstallControls();
  await hydrateFromServerStore();
  let settings = await getSetting();
  if (!settings) {
    await saveSetting({
      interval_days: INTERVALS,
      interval_preset: 'balanced',
      hold_interval_below_score: 40,
      default_low_action: 'hold',
      /* 高分跳级默认关闭：计划 §6 明确将自适应记忆算法列为首版范围外，需用户主动开启 */
      adaptive_leap: false,
      daily_review_limit: 25,
      study_method: 'blurting',
      theme: 'light'
    });
    settings = await getSetting();
  }
  activeStudyMethod = settings?.study_method || 'blurting';
  applyTheme(settings?.theme || 'light');
  await render();
  void resumeSavedCouchSync();
}

/* 墓碑（_deleted）是删除意图的传播载体，对业务读取一律透明过滤 */
async function allDocs() { const result = await db.allDocs({ include_docs: true }); return result.rows.map(row => row.doc).filter(doc => doc && !doc._deleted); }
async function getCards() { return (await allDocs()).filter(doc => doc.type === 'card' && !doc.archived_at); }
async function getReviews() { return (await allDocs()).filter(doc => doc.type === 'review').sort((a, b) => String(b.reviewed_at || '').localeCompare(String(a.reviewed_at || ''))); }
async function getSetting() { try { return await db.get('settings:main'); } catch { return null; } }
async function saveSetting(settings) { const previous = await getSetting(); return db.put({ ...(previous || {}), ...settings, _id: 'settings:main', type: 'settings' }); }
const cardNotebook = card => Domain.normalizeNotebook(card?.notebook);
const filterByNotebook = (cards, nb = activeNotebookFilter) => nb == null ? cards : cards.filter(c => cardNotebook(c) === nb);

function notebookChipHtml(nbName, notebooks = []) {
  const norm = Domain.normalizeNotebook(nbName);
  const found = notebooks.find(n => n.name === norm);
  const color = found?.color || 'indigo';
  return `<button type="button" class="notebook-chip nb-color-${color}" data-notebook-filter="${escapeHtml(norm)}" title="切换到科目笔记本：${escapeHtml(norm)}">${icon('book')}<span>${escapeHtml(norm)}</span></button>`;
}

function notebookShelfHtml(notebooks, allCardsCount, allDueCount) {
  const allBtn = `<button type="button" class="notebook-pill ${activeNotebookFilter == null ? 'active' : ''}" data-notebook-filter="all">${icon('book')}<span>全部科目</span><span class="count-pill">${allCardsCount}</span></button>`;
  const nbBtns = notebooks.map(nb => `<button type="button" class="notebook-pill ${activeNotebookFilter === nb.name ? 'active' : ''}" data-notebook-filter="${escapeHtml(nb.name)}"><i class="nb-dot nb-color-${nb.color}"></i><span>${escapeHtml(nb.name)}</span><span class="count-pill">${nb.due > 0 ? `${nb.due}待` : nb.total}</span></button>`).join('');
  const manageBtn = activeNotebookFilter != null
    ? `<button type="button" class="notebook-pill notebook-manage-pill" data-edit-notebook="${escapeHtml(activeNotebookFilter)}" title="重命名或管理当前笔记本">${icon('edit')}管理本子</button>`
    : '';
  const addBtn = `<button type="button" class="notebook-pill notebook-add-pill" data-action="open-notebook-dialog" title="新建或管理科目笔记本">${icon('plus')}新建科目本</button>`;
  return `<div class="notebook-shelf" role="group" aria-label="科目笔记本切换">${allBtn}${nbBtns}${manageBtn}${addBtn}</div>`;
}

async function saveCard(data) {
  const current = data.id ? await db.get(data.id) : null;
  const settings = await getSetting();
  const intervals = settings?.interval_days || INTERVALS;
  const day = localDay();
  const dueDate = data.due_date && /^\d{4}-\d{2}-\d{2}$/.test(data.due_date) ? data.due_date : (current?.due_date || addDays(day, intervals[0]));
  const nbName = Domain.normalizeNotebook(data.notebook ?? current?.notebook ?? activeNotebookFilter ?? Domain.DEFAULT_NOTEBOOK);
  const savedNbs = Array.isArray(settings?.notebooks) ? [...settings.notebooks] : [];
  if (!savedNbs.some(item => (typeof item === 'string' ? item : item?.name) === nbName)) {
    const color = Domain.NOTEBOOK_COLORS[savedNbs.length % Domain.NOTEBOOK_COLORS.length];
    savedNbs.push({ name: nbName, color });
    await saveSetting({ ...(settings || {}), notebooks: savedNbs });
  }
  const doc = { ...(current || {}), _id: current?._id || `card:${uuid()}`, type: 'card', title: data.title.trim(), outline: data.outline.trim(), tags: data.tags, notebook: nbName, created_at: current?.created_at || new Date().toISOString(), archived_at: null, interval_index: current?.interval_index ?? 0, due_date: dueDate, last_reviewed_at: current?.last_reviewed_at || null, latest_memory_score: current?.latest_memory_score ?? null };
  return db.put(doc);
}
async function archiveCard(id, restore = false) { const doc = await db.get(id); doc.archived_at = restore ? null : new Date().toISOString(); await db.put(doc); }
async function deleteCard(id) { const doc = await db.get(id); await db.remove(doc); const reviews = (await getReviews()).filter(row => row.card_id === id); for (const review of reviews) await db.remove(review); }
async function dueCards(respectNotebook = true) {
  const today = localDay();
  const all = (await getCards()).filter(card => card.due_date <= today);
  return Domain.sortDueCards(respectNotebook ? filterByNotebook(all) : all);
}
function markdownToHtml(markdown) {
  let html = escapeHtml(markdown)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/==([^=]+)==/g, (match, word) => `<button type="button" class="cloze-mask" aria-expanded="false" aria-label="挖空：${word}，点击显示答案" title="点击显示答案">${word}</button>`);
  const lines = html.split(/\r?\n/); let out = ''; let listOpen = false;
  for (const raw of lines) {
    const headingMatch = raw.match(/^(#{1,4})\s+(.*)$/);
    const listMatch = raw.match(/^(\s*)(?:[-*+]|\d+\.)\s+(.*)$/);
    if (headingMatch) {
      if (listOpen) { out += '</ul>'; listOpen = false; }
      out += `<h4 class="md-heading">${headingMatch[2]}</h4>`;
    } else if (listMatch) {
      if (!listOpen) { out += '<ul>'; listOpen = true; }
      const indent = Math.min(8, Math.floor(listMatch[1].replace(/\t/g, '  ').length / 2)) * 16;
      out += `<li style="margin-left:${indent}px">${listMatch[2]}</li>`;
    } else {
      if (listOpen) { out += '</ul>'; listOpen = false; }
      if (raw.trim()) out += `<p>${raw}</p>`;
    }
  }
  if (listOpen) out += '</ul>';
  return out || '<p class="muted">还没有填写大纲</p>';
}
function showToast(message, undoable = false) {
  const el = $('#toast');
  if (undoable && lastReviewSnapshot) {
    el.innerHTML = `<span>${escapeHtml(message)}</span><button type="button" class="toast-undo" data-action="undo-review">${icon('undo')}撤销</button>`;
  } else {
    el.textContent = message;
  }
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), undoable ? 4200 : 2300);
}
function fmtDue(card) { const today = localDay(); const diff = Math.round((new Date(`${today}T12:00:00`) - new Date(`${card.due_date}T12:00:00`)) / 86400000); if (diff > 0) return `<span class="due-label overdue">逾期 ${diff} 天</span>`; return `<span class="due-label">${card.due_date === today ? '今天到期' : fmtDate(card.due_date)}</span>`; }
/* 顶栏 breadcrumb 已按规范删除，这里只维护浏览器标题 */

/* 等级计数：counts[i] 对应 BAG_ORDER[i]（i = 0 → L1 待首次复习） */
function levelCounts(cards) {
  const counts = Array(BAG_ORDER.length).fill(0);
  for (const card of cards) counts[bagIndex(card)]++;
  return counts;
}
/* 等级筛选 chips：侧栏与移动端共用 activeBagFilter */
function levelFilterRow(cards) {
  const counts = levelCounts(cards);
  const all = `<button type="button" class="level-chip ${activeBagFilter == null ? 'active' : ''}" data-bag-filter="all">全部<span class="count-pill">${cards.length}</span></button>`;
  const chips = BAG_ORDER.map((level, index) => `<button type="button" class="level-chip ${activeBagFilter === index - 1 ? 'active' : ''}" data-bag-filter="${index - 1}"><span class="bag-dot ${levelClass(index)}"></span>${level.name}<span class="count-pill">${counts[index]}</span></button>`).join('');
  return `<div class="level-filter-row" role="group" aria-label="按等级筛选">${all}${chips}</div>`;
}

async function render() {
  closeAllRowMenus();
  const allCards = await getCards();
  const allDue = await dueCards(false);
  const settings = (await getSetting()) || {};
  const notebooks = Domain.collectNotebooks(allCards, settings.notebooks || [], localDay());
  if (activeNotebookFilter && !notebooks.some(n => n.name === activeNotebookFilter)) activeNotebookFilter = null;
  const cards = filterByNotebook(allCards);
  const due = filterByNotebook(allDue);
  const dueCount = $('#navDueCount'); if (dueCount) dueCount.textContent = due.length ? String(due.length) : '';
  const topDate = $('#todayDate'); if (topDate) topDate.textContent = new Date().toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'short' });
  const topPage = $('#topbarPageName');
  if (topPage) {
    const viewLabels = { today: '今日复习', library: '全部卡片', history: '复习记录', settings: '设置与同步' };
    topPage.textContent = activeNotebookFilter ? `${viewLabels[view] || 'StudyStyle'} · ${activeNotebookFilter}` : (viewLabels[view] || 'StudyStyle');
  }
  document.title = `${due.length ? `(${due.length}) ` : ''}StudyStyle · 间隔提醒`;
  const nbNav = $('#notebookNav');
  if (nbNav) {
    const allNbItem = `<button type="button" class="bag-link ${activeNotebookFilter == null ? 'active' : ''}" data-notebook-filter="all">${icon('book')}<span class="bag-link-name">全部科目</span><span class="bag-link-count">${allCards.length || ''}</span></button>`;
    const nbItems = notebooks.map(nb => `<button type="button" class="bag-link ${activeNotebookFilter === nb.name ? 'active' : ''}" data-notebook-filter="${escapeHtml(nb.name)}" title="${escapeHtml(nb.name)}：共 ${nb.total} 张，今日待复习 ${nb.due} 张"><i class="nb-dot nb-color-${nb.color}"></i><span class="bag-link-name">${escapeHtml(nb.name)}</span><span class="bag-link-count">${nb.due > 0 ? `${nb.due}/${nb.total}` : (nb.total || '')}</span></button>`).join('');
    nbNav.innerHTML = allNbItem + nbItems;
  }
  const counts = levelCounts(cards);
  const totalCards = Math.max(1, cards.length);
  const bagNav = $('#bagNav');
  if (bagNav) {
    const allItem = `<button type="button" class="bag-link ${activeBagFilter == null ? 'active' : ''}" data-bag-filter="all"><span class="bag-link-name">全部</span><span class="bag-link-count">${cards.length || ''}</span></button>`;
    const levels = BAG_ORDER.map((level, index) => {
      const pct = cards.length ? Math.round((counts[index] / totalCards) * 100) : 0;
      return `<button type="button" class="bag-link ${activeBagFilter === index - 1 ? 'active' : ''}" data-bag-filter="${index - 1}" title="${level.name}：${counts[index]} 张（${pct}%）"><i class="bag-dot ${levelClass(index)}"></i><span class="bag-link-name">${level.name}</span><span class="bag-link-count">${counts[index] || ''}</span></button>`;
    }).join('');
    bagNav.innerHTML = allItem + levels;
  }
  if (view === 'today') $('#viewRoot').innerHTML = await renderToday(cards, due, notebooks, allCards, allDue);
  if (view === 'library') { $('#viewRoot').innerHTML = await renderLibrary(cards, notebooks, allCards, allDue); filterLibrary(); }
  if (view === 'history') $('#viewRoot').innerHTML = await renderHistory(notebooks, allCards, allDue);
  if (view === 'settings') $('#viewRoot').innerHTML = await renderSettings();
  $$('.nav-item').forEach(item => item.classList.toggle('active', item.dataset.view === view));
  updateSyncIndicator();
}

/* ===================== 今日复习页 ===================== */
async function renderToday(cards, due, notebooks = [], allCards = cards, allDue = due) {
  const settings = (await getSetting()) || {};
  todaySettings = settings;
  const intervals = settings.interval_days || INTERVALS;
  const dailyLimit = Number(settings.daily_review_limit ?? 25);
  const today = localDay();
  const allReviews = await getReviews();
  const done = allReviews.filter(row => localDay(new Date(row.reviewed_at)) === today).length;
  const streakInfo = Domain.computeStreak(allReviews.map(row => localDay(new Date(row.reviewed_at))), today);
  const allFilteredDue = activeBagFilter == null ? due : due.filter(card => bagFor(card) === activeBagFilter);
  /* 队列完整展示全部到期卡片（计划 §4.2「不丢失原则」：优先级只决定出场顺序，卡片不会因排后而消失）。
     每日上限只作为「本轮建议量」提示，不再截断队列。 */
  const items = allFilteredDue;
  /* 队列完整展示全部到期卡片（计划 §4.2「不丢失原则」：优先级只决定出场顺序，卡片不会因排后而消失）。
     每日上限只作为「本轮建议量」提示，不再截断队列。 */
  const suggestedCount = dailyLimit > 0 ? Math.min(items.length, dailyLimit) : items.length;
  const totalTarget = done + items.length;
  const completionPct = totalTarget > 0 ? Math.round((done / totalTarget) * 100) : 0;
  const estMinutes = Math.max(1, Math.round(items.length * 0.8));
  const counts = levelCounts(cards);
  const totalCards = Math.max(1, cards.length);
  const pastDue = due.filter(card => card.due_date < today).length;
  const dateLabel = new Date().toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'short' });
  const noCards = cards.length === 0;
  const nothingDue = due.length === 0;
  const limitReached = dailyLimit > 0 && done >= dailyLimit;

  /* ① 标题行：h1 + 右侧 meta（行高 36，与任务带间距 16） */
  const titleRow = `<div class="today-title-row">
    <h1>今日复习${activeNotebookFilter ? ` · ${escapeHtml(activeNotebookFilter)}` : ''}</h1>
    <div class="today-meta">${dateLabel}${streakInfo.currentStreak > 0 ? ` · 连续第 ${streakInfo.currentStreak} 天` : ''}</div>
  </div>`;
  const nbShelf = notebookShelfHtml(notebooks, allCards.length, allDue.length);

  /* ② 任务带：通栏单卡，内部三区用 1px 竖分隔线分隔（不用阴影分隔） */
  let band;
  if (noCards) {
    band = `<div class="today-band today-band-plain">
      <span class="band-plain-icon">${icon('info', 'icon icon-24')}</span>
      <span class="band-plain-text">还没有任何卡片。支持 Markdown 与 ==挖空== 语法，复习时可辅助检查标记词。</span>
      <div class="band-zone band-zone-actions">
        <button class="button button-primary" data-action="add">创建第一张卡片</button>
        <button class="button button-outline" data-action="seed-demo">${icon('sparkles')}载入示例卡片</button>
      </div>
    </div>`;
  } else if (nothingDue) {
    band = `<div class="today-band today-band-plain">
      <span class="band-plain-icon">${icon('check', 'icon icon-24')}</span>
      <span class="band-plain-text">今天没有到期卡片</span>
      <button type="button" class="text-button" data-action="snooze">明天再看</button>
    </div>`;
  } else {
    /* 每日上限并入中区说明文字（不再是独立 chip），数值本身可就地展开 5 档 */
    const limitText = `<button type="button" class="band-limit" data-action="open-limit" aria-haspopup="true" aria-expanded="false" title="调整每日复习上限">${dailyLimit || '不限'}</button>`;
    const caption = `已完成 <strong>${done}</strong> · 今日上限 ${limitText} · 预估 ${estMinutes} 分钟${suggestedCount < items.length ? ` · 建议先做 ${suggestedCount} 张` : ''}`;
    band = `<div class="today-band">
      <div class="band-zone band-zone-amount">
        <strong>${items.length}</strong><span>张待复习</span>
      </div>
      <div class="band-zone band-zone-progress">
        <div class="linear-progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${completionPct}" aria-valuetext="已完成 ${done} / ${totalTarget} 张"><span style="width:${completionPct}%"></span></div>
        <div class="linear-progress-text">${caption}${limitReached ? `<span class="band-warning">已达今日上限 ${dailyLimit}</span>` : ''}</div>
      </div>
      <div class="band-zone band-zone-actions">
        <button class="button button-primary" data-action="start-today" ${limitReached || !items.length ? 'disabled' : ''}>${icon('play')}开始复习</button>
        <details class="action-menu today-more-menu">
          <summary class="button button-outline">更多复习方式${icon('chevron-down')}</summary>
          <div class="action-menu-panel">
            <button class="action-menu-item" data-action="${limitReached ? 'start-today-all' : 'random-draw'}" type="button">${icon('dice')}<span>${limitReached ? '提前复习全部到期卡' : '随机抽卡自测'}</span></button>
            ${notebooks.length > 1 && activeNotebookFilter == null ? `<button class="action-menu-item" data-action="start-mixed" type="button">${icon('cards')}<span>跨科目混合复习</span></button>` : ''}
            <button class="action-menu-item" data-action="goto-library" type="button">${icon('library')}<span>打开全部卡片</span></button>
          </div>
        </details>
      </div>
    </div>`;
  }

  /* 等级筛选 chips */
  const filterRow = levelFilterRow(cards);

  /* 队列：序号圆 → 8px 等级色点 → 标题+meta → 到期日 → 复习按钮 */
  const queueTitle = activeBagFilter == null ? '今日到期队列' : BAG_ORDER[activeBagFilter + 1]?.name || '待首次复习';
  const queueRows = items.map((card, index) => `<div class="queue-row ${levelClass(bagIndex(card))}">
    <span class="queue-order">${index + 1}</span>
    <span class="bag-dot level-dot" aria-hidden="true"></span>
    <div class="queue-main">
      <div class="queue-title">${escapeHtml(card.title)}</div>
      <div class="queue-meta">${notebookChipHtml(card.notebook, notebooks)}${badgeHtml(card)}<span class="cycle-chip">周期 ${intervalFor(card, intervals)} 天</span>${(card.tags || []).slice(0, 3).map(tag => `<span class="tag">${escapeHtml(tag)}</span>`).join('')}</div>
    </div>
    ${fmtDue(card)}
    <button class="button button-outline queue-open" data-review-card="${escapeHtml(card._id)}">复习${icon('chevron-right')}</button>
  </div>`).join('');
  /* 首次使用（0 卡片）时队列整段不渲染，避免同一个事实重复三遍 */
  const queue = noCards ? '' : items.length
    ? `<div class="review-queue">${queueRows}</div>`
    : `<div class="empty-state">
    <div class="empty-symbol">${icon('check', 'icon icon-24')}</div>
    <h3>${nothingDue ? '今天的复习已完成' : '这个等级今天没有到期卡片'}</h3>
    <p>${nothingDue ? '明天的到期卡片会自动出现在这里，也可以现在提前复习。' : '切换其他等级，或查看全部待复习项目。'}</p>
    <div class="empty-actions">${nothingDue ? `<button class="button button-outline" data-action="random-draw">${icon('dice')}随机抽卡自测</button>` : `<button class="button button-outline" data-action="clear-filter">清除等级筛选</button>`}</div>
  </div>`;

  /* 洞察折叠 */
  const forecastDays = Array.from({ length: 7 }, (_, idx) => {
    const dayStr = addDays(today, idx + 1);
    const count = cards.filter(c => c.due_date === dayStr).length;
    const label = idx === 0 ? '明天' : idx === 1 ? '后天' : fmtDate(dayStr, { weekday: 'short' });
    return { dayStr, label, count };
  });
  const maxForecast = Math.max(1, ...forecastDays.map(d => d.count));
  const forecastHtml = `<div class="forecast-bars">${forecastDays.map(d => `<div class="forecast-col" title="${d.dayStr}：${d.count} 张到期"><span class="forecast-num">${d.count || ''}</span><div class="forecast-track"><div class="forecast-fill" style="height:${d.count ? Math.max(14, Math.round((d.count / maxForecast) * 100)) : 0}%"></div></div><span class="forecast-day">${d.label}</span></div>`).join('')}</div>`;
  const maxHeat = Math.max(1, ...streakInfo.last14Days.map(d => d.count));
  const heatStripHtml = `<div class="activity-strip" title="近 14 天复习活跃度">${streakInfo.last14Days.map(d => { const lvl = d.count === 0 ? 0 : d.count >= maxHeat * 0.75 ? 3 : d.count >= maxHeat * 0.35 ? 2 : 1; return `<span class="heat-cell lvl-${lvl}" title="${d.day}：复习 ${d.count} 次"></span>`; }).join('')}</div>`;
  const ringCircumference = 138.2;
  const ringOffset = +(ringCircumference * (1 - completionPct / 100)).toFixed(1);
  const stackSegments = cards.length
    ? `<div class="mastery-stack" title="卡片池记忆等级占比分布">${BAG_ORDER.map((level, index) => counts[index] ? `<span class="mastery-seg ${levelClass(index)}" style="width:${(counts[index] / totalCards * 100).toFixed(2)}%" title="${level.name}：${counts[index]} 张（${Math.round(counts[index] / totalCards * 100)}%）"></span>` : '').join('')}</div>`
    : '';
  const insights = `<details class="ios-fold-card" data-fold-key="todayInsights" ${uiFolds.todayInsights ? 'open' : ''}>
    <summary class="ios-fold-summary">
      <div class="fold-title-group">
        <span class="fold-icon">${icon('chart')}</span>
        <div><strong>未来 7 天到期分布</strong><small>近 14 天打卡热力图 · 卡片池共 ${cards.length} 张</small></div>
      </div>
      <div class="fold-right-meta">${heatStripHtml}<span class="fold-chevron">${icon('chevron-right')}</span></div>
    </summary>
    <div class="ios-fold-body">
      <div class="split-info">
        <div class="plain-panel"><h3>未来 7 天到期分布</h3>${forecastHtml}</div>
        <div class="plain-panel">
          <h3>今日概览与近 14 天节奏</h3>
          <div class="metric-line"><span>今日待复习</span><strong>${due.length} 张</strong></div>
          <div class="metric-line"><span>逾期积压</span><strong>${pastDue} 张</strong></div>
          <div class="metric-line"><span>卡片池总数</span><strong>${cards.length} 张</strong></div>
          <div class="metric-line"><span>今日完成率</span>
            <span class="progress-ring-card" title="今日复习完成率 ${completionPct}%">
              <svg class="progress-ring" width="48" height="48" viewBox="0 0 54 54" aria-hidden="true" focusable="false">
                <circle class="ring-bg" cx="27" cy="27" r="22" />
                <circle class="ring-fg" cx="27" cy="27" r="22" stroke-dasharray="${ringCircumference}" stroke-dashoffset="${ringOffset}" />
              </svg>
              <span class="ring-meta"><strong>${completionPct}%</strong><span>已完成 ${done} 次</span></span>
            </span>
          </div>
          <div class="metric-line"><span>近 14 天打卡</span>${heatStripHtml}</div>
          <div class="metric-line" style="display:block"><span>卡片池等级分布</span>${stackSegments}</div>
        </div>
      </div>
    </div>
  </details>`;

  /* 超量提示：队列仍完整展示，仅建议分批处理并提供一键顺延入口 */
  const overflowNote = dailyLimit > 0 && items.length > dailyLimit
    ? `<div class="inline-actions" style="justify-content:flex-end;margin-top:var(--sp-3)"><span class="field-hint">今日共 ${items.length} 张到期，超过建议量 ${dailyLimit} 张 · 可分批完成或顺延到明天</span><button class="text-button" data-action="snooze">${icon('waves')}顺延剩余到期卡片</button></div>`
    : '';

  return `<div class="today-head">
    ${titleRow}
    ${nbShelf}
    ${band}
  </div>
  ${noCards ? '' : filterRow}
  <div class="section-heading">
    <div><h2>${queueTitle}</h2><p>${noCards ? '创建卡片后，到期项会按记忆等级排到这里' : `按记忆等级从低到高排序，同等级内逾期更久的优先${dailyLimit > 0 ? `（每日上限 ${dailyLimit} 张）` : ''}`}</p></div>
    <div class="inline-actions">${activeBagFilter != null ? '<button class="text-button" data-action="clear-filter">显示全部等级</button>' : ''}${noCards ? '' : `<div class="queue-summary">本轮待完成 <strong>${items.length}</strong> 张</div>`}</div>
  </div>
  ${queue}
  ${overflowNote}
  ${noCards ? '' : insights}`;
}

/* ===================== 卡片库 ===================== */
async function renderLibrary(cards, notebooks = [], allCards = cards, allDue = []) {
  const archived = (await allDocs()).filter(doc => doc.type === 'card' && doc.archived_at);
  /* 周期天数取用户实际配置的阶梯，否则卡片库显示的「周期 N 天」与复习时的排期不一致 */
  const intervals = (await getSetting())?.interval_days || INTERVALS;
  const allTags = [...new Set(cards.flatMap(card => card.tags || []))].sort((a, b) => a.localeCompare(b, 'zh-CN'));
  const sortMode = libraryFilter.sort || 'due';
  const layoutMode = libraryFilter.layout || 'list';
  if (libraryFilter.tag !== 'all' && !allTags.includes(libraryFilter.tag)) libraryFilter.tag = 'all';
  const activeFilterCount = (activeBagFilter != null ? 1 : 0) + (libraryFilter.tag !== 'all' ? 1 : 0) + (libraryFilter.status !== 'all' ? 1 : 0) + (sortMode !== 'due' ? 1 : 0);
  const filterOpen = uiFolds.libraryFilters || activeFilterCount > 0;
  for (const id of [...selectedCardIds]) {
    if (!cards.some(c => c._id === id)) selectedCardIds.delete(id);
  }
  const nbOptionsHtml = notebooks.map(nb => `<option value="${escapeHtml(nb.name)}" ${activeNotebookFilter === nb.name ? 'selected' : ''}>${escapeHtml(nb.name)}</option>`).join('');
  const batchDockHtml = batchMode
    ? `<div class="ios-batch-dock" id="batchDock"><span class="batch-dock-count">已选 <strong>${selectedCardIds.size}</strong> 张</span><div class="inline-actions">
      <button type="button" class="button button-quiet small-button" data-action="batch-select-all">全选/反选</button>
      <button type="button" class="button button-primary small-button" data-action="batch-review" ${selectedCardIds.size ? '' : 'disabled'}>${icon('play')}集中复习</button>
      <button type="button" class="button button-outline small-button" data-action="batch-due-today" ${selectedCardIds.size ? '' : 'disabled'}>${icon('calendar')}改期至今天</button>
      <select class="select-input small-select" id="batchNotebookSelect" aria-label="选择目标科目笔记本" ${selectedCardIds.size ? '' : 'disabled'}>${nbOptionsHtml}</select>
      <button type="button" class="button button-outline small-button" data-action="batch-move-notebook" ${selectedCardIds.size ? '' : 'disabled'}>${icon('book')}移至科目本</button>
      <button type="button" class="button button-outline small-button" data-action="batch-archive" ${selectedCardIds.size ? '' : 'disabled'}>${icon('archive')}批量归档</button>
      <button type="button" class="text-button" data-action="toggle-batch-mode">完成</button>
    </div></div>`
    : '';

  return `<div class="page-heading">
    <div><h1>全部卡片${activeNotebookFilter ? ` · ${escapeHtml(activeNotebookFilter)}` : ''}</h1><p class="page-subtitle">${cards.length} 张在当前科目复习池中 · ${archived.length} 张已归档 · 点击卡片标题可展开大纲</p></div>
    <div class="inline-actions">
      ${cards.length ? `<details class="action-menu library-more-menu"><summary class="button button-outline">管理与练习${icon('chevron-down')}</summary><div class="action-menu-panel"><button class="action-menu-item" data-action="toggle-batch-mode" type="button">${icon('check-square')}<span>${batchMode ? '退出批量管理' : '批量管理卡片'}</span></button><button class="action-menu-item" data-action="random-draw-library" type="button">${icon('dice')}<span>随机抽卡自测</span></button></div></details>` : ''}
      <button class="button button-primary" data-action="add">${icon('plus')}新增卡片</button>
    </div>
  </div>
  ${notebookShelfHtml(notebooks, allCards.length, allDue.length)}
  ${levelFilterRow(cards)}
  <div class="library-primary-bar">
    <div class="search-box">${icon('search')}<input class="search-input" id="cardSearch" type="search" aria-label="搜索卡片标题、大纲、科目或标签" placeholder="搜索卡片标题、大纲、科目或标签…" value="${escapeHtml(libraryFilter.query)}" /></div>
    <span class="library-result-count" id="libraryResultCount" aria-live="polite">${cards.length} 张</span>
    <button type="button" class="button button-outline filter-drawer-toggle ${filterOpen ? 'active' : ''}" data-action="toggle-lib-filters">${icon('sliders')}筛选 <span class="filter-count-pill ${activeFilterCount ? '' : 'hidden'}" id="libraryFilterCountPill">${activeFilterCount || ''}</span></button>
    <button type="button" class="text-button hidden" id="libraryClearFilters" data-action="clear-filters">清除筛选</button>
    <div class="view-mode-switch" role="group" aria-label="视图切换" ${cards.length >= 24 ? '' : 'hidden'}>
      <button type="button" class="view-mode-btn ${layoutMode === 'list' ? 'active' : ''}" data-lib-layout="list" title="列表视图">${icon('list')}列表</button>
      <button type="button" class="view-mode-btn ${layoutMode === 'grid' ? 'active' : ''}" data-lib-layout="grid" title="卡片网格视图">${icon('grid')}卡片</button>
    </div>
  </div>
  <div class="library-filter-drawer ${filterOpen ? '' : 'hidden'}" id="libraryFilterDrawer">
    <div class="library-toolbar">
      <select class="select-input" id="tagFilter" aria-label="按标签筛选"><option value="all">所有标签</option>${allTags.map(tag => `<option value="${escapeHtml(tag)}" ${libraryFilter.tag === tag ? 'selected' : ''}>${escapeHtml(tag)}</option>`).join('')}</select>
      <select class="select-input" id="statusFilter" aria-label="按日期筛选"><option value="all" ${libraryFilter.status === 'all' ? 'selected' : ''}>所有日期</option><option value="due" ${libraryFilter.status === 'due' ? 'selected' : ''}>今日到期</option><option value="future" ${libraryFilter.status === 'future' ? 'selected' : ''}>未到期</option></select>
      <select class="select-input" id="sortFilter" aria-label="排序方式"><option value="due" ${sortMode === 'due' ? 'selected' : ''}>按到期日排序</option><option value="score" ${sortMode === 'score' ? 'selected' : ''}>按记忆度(低→高)</option><option value="created" ${sortMode === 'created' ? 'selected' : ''}>按最新创建</option><option value="title" ${sortMode === 'title' ? 'selected' : ''}>按标题名称</option></select>
    </div>
  </div>
  <div class="library-list ${layoutMode === 'grid' ? 'grid-mode' : ''} ${batchMode ? 'batch-active' : ''}" id="libraryList">${renderLibraryRows(cards, notebooks, intervals)}</div>
  <div class="empty-filter hidden" id="libraryEmptyResult"></div>
  <details class="ios-fold-card" data-fold-key="batchImporter" ${uiFolds.batchImporter ? 'open' : ''}>
    <summary class="ios-fold-summary">
      <div class="fold-title-group"><span class="fold-icon">${icon('pen-line')}</span><div><strong>Markdown 批量快速制卡</strong><small>粘贴带 # 一级/二级标题的笔记，自动拆分为多张提纲卡片</small></div></div>
      <span class="fold-chevron">${icon('chevron-right')}</span>
    </summary>
    <div class="ios-fold-body">
      <div class="settings-field"><label class="field-label" for="batchMdInput">批量笔记内容 <span class="optional">以 # 或 ## 标题作为每张卡片标题，下方行作为大纲</span></label><textarea class="text-area outline-input" id="batchMdInput" rows="6" placeholder="# 光合作用的光反应&#10;- 场所：**类囊体薄膜**&#10;- 产物：==ATP==、NADPH、O2&#10;&#10;# 光合作用的暗反应&#10;- 场所：**叶绿体基质**&#10;- 核心过程：CO2固定与 ==C3还原=="></textarea></div>
      <div class="library-primary-bar" style="margin-bottom:0"><input class="text-input" id="batchMdNotebook" style="max-width:200px" value="${escapeHtml(activeNotebookFilter || Domain.DEFAULT_NOTEBOOK)}" placeholder="所属科目笔记本" /><input class="text-input" id="batchMdTags" style="max-width:240px" placeholder="统一附加标签（选填，逗号分隔）" /><button type="button" class="button button-primary" data-action="run-batch-import">${icon('sparkles')}一键拆分并创建卡片</button></div>
    </div>
  </details>
  ${archived.length ? `<details class="ios-fold-card" data-fold-key="libraryArchived" ${uiFolds.libraryArchived ? 'open' : ''}>
    <summary class="ios-fold-summary"><div class="fold-title-group"><span class="fold-icon">${icon('archive')}</span><div><strong>已归档卡片</strong><small>共 ${archived.length} 张已移出复习池，可随时恢复</small></div></div><span class="fold-chevron">${icon('chevron-right')}</span></summary>
    <div class="ios-fold-body"><div class="library-list">${archived.map(card => `<div class="library-row archived-row">
      <div class="library-row-main"><div class="library-row-title"><span>${escapeHtml(card.title)}</span></div><div class="library-row-sub">${notebookChipHtml(card.notebook, notebooks)}<span>归档于 ${fmtDate(card.archived_at.slice(0, 10))}</span></div></div>
      <div class="library-due"></div>
      <div class="row-actions">
        <button class="icon-button" data-restore="${escapeHtml(card._id)}" aria-label="恢复卡片" title="恢复">${icon('undo')}</button>
        <button class="icon-button danger" data-delete="${escapeHtml(card._id)}" aria-label="删除卡片" title="彻底删除">${icon('trash')}</button>
      </div>
    </div>`).join('')}</div></div>
  </details>` : ''}
  ${batchDockHtml}`;
}

function renderLibraryRows(cards, notebooks = [], intervals = INTERVALS) {
  if (!cards.length) return `<div class="empty-state">
    <div class="empty-symbol">${icon('cards', 'icon icon-24')}</div>
    <h3>${activeNotebookFilter ? `《${escapeHtml(activeNotebookFilter)}》笔记本还是空的` : '卡片池是空的'}</h3>
    <p>去批量创建（粘贴 Markdown，一次生成多张），或新增第一张卡片。</p>
    <div class="empty-actions"><button class="button button-primary" data-action="add">新增第一张</button><button class="button button-outline" data-action="seed-demo">${icon('sparkles')}载入示例卡片</button></div>
  </div>`;
  return cards.map(card => {
    const isOpen = expandedCardIds.has(card._id);
    const isSelected = selectedCardIds.has(card._id);
    const scoreVal = card.latest_memory_score == null ? -1 : card.latest_memory_score;
    const index = bagIndex(card);
    const plainSnippet = card.outline.replace(/[#*`=]/g, '').replace(/\s+/g, ' ').trim().slice(0, 90);
    const checkBtn = batchMode ? `<button type="button" class="batch-check ${isSelected ? 'checked' : ''}" data-batch-select="${escapeHtml(card._id)}" aria-label="选择卡片" aria-pressed="${isSelected}">${isSelected ? icon('check') : ''}</button>` : '';
    const nbName = cardNotebook(card);
    return `<div class="library-row ${isOpen ? 'expanded' : ''} ${isSelected ? 'batch-selected' : ''} ${levelClass(index)}" data-card-row="${escapeHtml(card._id)}" data-notebook="${escapeHtml(nbName)}" data-bag="${bagFor(card)}" data-score="${scoreVal}" data-due="${card.due_date}" data-created="${escapeHtml(card.created_at || '')}" data-title="${escapeHtml(card.title)}" data-tags="${escapeHtml((card.tags || []).join('|'))}" data-search="${escapeHtml(`${card.title}\n${card.outline}\n${nbName}\n${(card.tags || []).join(' ')}`.toLowerCase())}">
      <div class="library-row-main" data-toggle-card="${escapeHtml(card._id)}">
        <div class="library-row-title">${checkBtn}<button type="button" class="library-title-btn" data-toggle-card="${escapeHtml(card._id)}" aria-expanded="${isOpen}"><span class="expand-caret ${isOpen ? 'open' : ''}" aria-hidden="true">${icon('chevron-right')}</span>${escapeHtml(card.title)}</button></div>
        <div class="library-card-snippet">${escapeHtml(plainSnippet || '点击展开大纲详情')}</div>
        <div class="library-row-sub">${notebookChipHtml(nbName, notebooks)}${badgeHtml(card)}${scoreVal >= 0 ? `<span>记忆度 ${scoreVal}%</span>` : ''}<span>周期 ${intervalFor(card, intervals)} 天</span>${(card.tags || []).length ? card.tags.slice(0, 3).map(t => `<span class="tag">${escapeHtml(t)}</span>`).join('') : '<span>无标签</span>'}</div>
      </div>
      <div class="library-due">${fmtDue(card)}</div>
      <div class="row-actions">
        <button class="button button-outline small-button" data-review-card="${escapeHtml(card._id)}" aria-label="复习这张卡片" title="立即复习">${icon('play')}复习</button>
        <button class="icon-button" data-more-menu="${escapeHtml(card._id)}" data-card-title="${escapeHtml(card.title)}" aria-label="更多操作" title="更多" aria-haspopup="true" aria-expanded="false">${icon('more')}</button>
      </div>
      <div class="library-outline-drawer ${isOpen ? '' : 'hidden'}" id="drawer-${escapeHtml(card._id)}"><div class="markdown-body">${markdownToHtml(card.outline)}</div></div>
    </div>`;
  }).join('');
}

/* ===================== 复习记录（按日期分组） ===================== */
async function renderHistory(notebooks = [], allCards = [], allDue = []) {
  const allReviews = await getReviews();
  const cards = Object.fromEntries((await allDocs()).filter(doc => doc.type === 'card').map(card => [card._id, card]));
  let reviews = activeHistoryCardFilter ? allReviews.filter(r => r.card_id === activeHistoryCardFilter) : allReviews;
  if (!activeHistoryCardFilter && activeNotebookFilter) {
    reviews = reviews.filter(r => cardNotebook(cards[r.card_id]) === activeNotebookFilter);
  }
  const filteredCard = activeHistoryCardFilter ? cards[activeHistoryCardFilter] : null;
  const groups = new Map();
  for (const record of reviews) {
    const day = localDay(new Date(record.reviewed_at));
    if (!groups.has(day)) groups.set(day, []);
    groups.get(day).push(record);
  }
  const groupHtml = [...groups.entries()].map(([day, rows]) => {
    const avg = Math.round(rows.reduce((sum, row) => sum + (Number(row.memory_score) || 0), 0) / rows.length);
    const dayLabel = new Date(`${day}T12:00:00`).toLocaleDateString('zh-CN', { month: 'long', day: 'numeric' });
    const rowsHtml = rows.map(record => {
      const card = cards[record.card_id];
      const tempCard = { ...(card || {}), latest_memory_score: record.memory_score };
      const intervalNote = record.interval_days_before != null && record.interval_days_after != null ? `<span class="cycle-chip">周期 ${record.interval_days_before} 天 → ${record.interval_days_after} 天</span>` : '';
      const durationNote = record.duration_sec ? `<span class="history-dur">用时 ${record.duration_sec} 秒</span>` : '';
      const draftParts = [];
      if (record.recall_draft) draftParts.push(`<div><strong>首次闭卷回忆</strong><pre>${escapeHtml(record.recall_draft)}</pre></div>`);
      if (record.recall_after_feedback) draftParts.push(`<div><strong>看过答案后的补充</strong><pre>${escapeHtml(record.recall_after_feedback)}</pre></div>`);
      if (record.application_attempt) draftParts.push(`<div><strong>应用练习记录</strong><pre>${escapeHtml(record.application_attempt)}</pre></div>`);
      const draft = draftParts.length ? `<details class="history-draft" ${record.memory_score < 60 ? 'open' : ''}><summary>${record.recall_after_feedback ? '查看回忆与反馈后补充' : '查看首次回忆草稿'}</summary>${draftParts.join('')}</details>` : '';
      return `<div class="history-row ${levelClass(bagIndex(tempCard))}">
        <div class="history-main">
          <div class="history-title-line"><span class="timeline-dot"></span><strong>${escapeHtml(card?.title || '已删除卡片')}</strong>${card ? notebookChipHtml(card.notebook, notebooks) : ''}${intervalNote}</div>
          <small class="history-time">${new Date(record.reviewed_at).toLocaleString('zh-CN')} · 下次到期 ${fmtDate(record.next_due_date)} ${durationNote}</small>
          ${record.note ? `<div class="history-note">${icon('lightbulb')}漏点备注：${escapeHtml(record.note)}</div>` : ''}
          ${draft}
        </div>
        <div class="history-bag">${badgeHtml(tempCard)}</div>
        <div class="history-score-pill ${levelClass(bagIndex(tempCard))}"><strong>${record.memory_score}%</strong></div>
      </div>`;
    }).join('');
    return `<section class="history-group">
      <div class="history-group-head"><h2>${dayLabel}</h2><span>${rows.length} 次 · 平均 ${avg}%</span></div>
      <div class="history-group-rows">${rowsHtml}</div>
    </section>`;
  }).join('');

  const body = reviews.length ? `<div class="history-timeline">${groupHtml}</div>` : `<div class="empty-state">
    <div class="empty-symbol">${icon('history', 'icon icon-24')}</div>
    <h3>${filteredCard ? `《${escapeHtml(filteredCard.title)}》还没有复习记录` : '还没有复习记录'}</h3>
    <p>完成第一次评分后，这里会记录自评结果、复习周期变化和当时的回忆草稿。</p>
    <div class="empty-actions">${filteredCard ? `<button class="button button-primary" data-review-card="${escapeHtml(filteredCard._id)}">现在复习这张</button>` : `<button class="button button-primary" data-action="goto-today">开始复习</button>`}</div>
  </div>`;

  return `<div class="page-heading">
    <div><h1>${filteredCard ? `《${escapeHtml(filteredCard.title)}》的复习记录` : `复习记录${activeNotebookFilter ? ` · ${escapeHtml(activeNotebookFilter)}` : ''}`}</h1><p class="page-subtitle">按日期分组展示每次主动回忆的评分、周期演进、专注耗时、默写草稿与漏点备注。</p></div>
    <div class="inline-actions">${activeHistoryCardFilter ? '<button class="button button-outline" data-action="clear-history-filter">查看全部卡片记录</button>' : ''}<div class="queue-summary">共 <strong>${reviews.length}</strong> 条记录</div></div>
  </div>
  ${notebookShelfHtml(notebooks, allCards.length, allDue.length)}
  ${body}`;
}

/* ===================== 设置与同步（4 组 · 渐进披露） ===================== */
async function renderSettings() {
  const saved = (await getSetting()) || {};
  const savedCreds = loadSavedCouchCreds();
  const couch = saved.couch || {};
  const prefillUrl = savedCreds?.url || couch.url || '';
  const prefillDb = savedCreds?.name || couch.name || '';
  const prefillUser = savedCreds?.user || couch.user || '';
  const prefillPass = savedCreds?.password || '';
  const rememberChecked = savedCreds ? Boolean(savedCreds.password) : true;
  const isDark = saved.theme === 'dark';
  const currentDaysStr = (saved.interval_days || INTERVALS).join(', ');
  const passThreshold = Number(saved.hold_interval_below_score ?? 40);
  const lowAction = saved.default_low_action || 'hold';
  const adaptiveLeap = saved.adaptive_leap === true;
  const dailyLimit = Number(saved.daily_review_limit ?? 25);
  const studyMethod = saved.study_method || activeStudyMethod || 'blurting';
  const presets = Object.values(Domain.INTERVAL_PRESETS || {});
  const activePreset = presets.find(p => p.days.join(', ') === currentDaysStr)?.key || 'custom';
  const presetCardsHtml = presets.map(p => `<button type="button" class="preset-curve-card ${activePreset === p.key ? 'active' : ''}" data-interval-preset="${p.key}"><strong>${escapeHtml(p.name)}</strong><span>${p.days.join(' → ')} 天</span><small>${escapeHtml(p.desc)}</small></button>`).join('');
  /* 渐进披露：自定义阶梯仅在预设不匹配当前曲线时展开 */
  const showCustomLadder = uiFolds.customLadder || activePreset === 'custom';
  /* 渐进披露：低于阈值策略仅在阈值为 40% / 50% 时出现，30% 与 60% 隐藏而非置灰 */
  const showLowAction = passThreshold === 40 || passThreshold === 50;

  return `<div class="page-heading">
    <div><h1>设置与同步</h1><p class="page-subtitle">调整复习节奏、每日学习量、外观与多设备同步。当前全部是默认值也可以直接开始复习。</p></div>
    <span class="sync-pill ${syncHandler ? 'connected' : ''}">${syncHandler ? '正在同步' : '本地模式'}</span>
  </div>
  <div class="settings-grid">
    <section class="settings-section">
      <h2>${icon('clock')}复习节奏</h2>
      <p>选择复习间隔起点或自定义递增天数；排期是可调整的产品规则，不代表固定的最佳间隔或 FSRS 算法。</p>
      <div class="preset-curve-grid">${presetCardsHtml}</div>
      <details class="ios-fold-section" data-fold-key="customLadder" ${showCustomLadder ? 'open' : ''}>
        <summary class="ios-fold-summary"><span class="fold-title-group"><span class="fold-icon">${icon('sliders')}</span><span>自定义周期阶梯</span></span><span class="fold-chevron">${icon('chevron-right')}</span></summary>
        <div class="ios-fold-body">
          <label class="field-label" for="intervalDays">周期阶梯（天，首档为 1 且严格递增）</label>
          <input class="text-input" id="intervalDays" value="${escapeHtml(currentDaysStr)}" />
          <div class="field-note">当前曲线：${escapeHtml(currentDaysStr)} 天</div>
        </div>
      </details>
      <div class="settings-subgrid">
        <div>
          <label class="field-label" for="passThresholdSelect">及格推进阈值</label>
          <select class="select-input" id="passThresholdSelect" style="width:100%">
            <option value="30" ${passThreshold === 30 ? 'selected' : ''}>30%（宽松推进）</option>
            <option value="40" ${passThreshold === 40 ? 'selected' : ''}>40%（标准推荐）</option>
            <option value="50" ${passThreshold === 50 ? 'selected' : ''}>50%（稳健巩固）</option>
            <option value="60" ${passThreshold === 60 ? 'selected' : ''}>60%（硬核严格）</option>
          </select>
        </div>
        ${showLowAction ? `<div>
          <label class="field-label" for="lowActionSelect">低于阈值时默认策略</label>
          <select class="select-input" id="lowActionSelect" style="width:100%">
            <option value="hold" ${lowAction === 'hold' ? 'selected' : ''}>保持当前周期档位（Hold）</option>
            <option value="reset" ${lowAction === 'reset' ? 'selected' : ''}>重置回第 1 天重新巩固（Reset）</option>
          </select>
        </div>` : ''}
      </div>
      <label class="ios-check-row" style="margin-top:var(--sp-3)">
        <input type="checkbox" id="adaptiveLeapCheck" ${adaptiveLeap ? 'checked' : ''} />
        <span><strong>${icon('zap')}高分时跨两档：</strong>评分 ≥ 85 时跨越 2 个周期阶梯，作为可选的排期规则</span>
      </label>
      <div class="settings-actions"><button class="button button-primary" data-action="save-intervals">保存调度设置</button></div>
    </section>

    <section class="settings-section">
      <h2>${icon('brain')}每日学习量与方式</h2>
      <p>以主动回忆、核对纠错和分散复习为主；方法提示用于帮助组织答案，不替代独立作答与实际练习。</p>
      <label class="field-label" for="dailyLimitSelect">每日复习上限（防雪崩护盾）</label>
      <select class="select-input" id="dailyLimitSelect" style="width:100%">
        <option value="15" ${dailyLimit === 15 ? 'selected' : ''}>15 张 / 天（轻量无压 · 约 10 分钟）</option>
        <option value="25" ${dailyLimit === 25 ? 'selected' : ''}>25 张 / 天（推荐均衡 · 约 20 分钟）</option>
        <option value="40" ${dailyLimit === 40 ? 'selected' : ''}>40 张 / 天（进阶强化 · 约 30 分钟）</option>
        <option value="60" ${dailyLimit === 60 ? 'selected' : ''}>60 张 / 天（考前冲刺高吞吐）</option>
        <option value="0" ${dailyLimit === 0 ? 'selected' : ''}>不设上限（显示全部到期卡片）</option>
      </select>
      <div class="field-note">也可在今日复习页数据带右侧的「上限」chip 就地调整。</div>
      <label class="field-label" for="defaultStudyMethodSelect">默认回忆提示（复习时可随时切换）</label>
      <select class="select-input" id="defaultStudyMethodSelect" style="width:100%">
        <option value="blurting" ${studyMethod === 'blurting' ? 'selected' : ''}>闭卷主动回忆 — 先独立写出结论、关系、条件与例子</option>
        <option value="feynman" ${studyMethod === 'feynman' ? 'selected' : ''}>解释机制与举例 — 用自己的话解释原因、条件并举新例子</option>
        <option value="cornell" ${studyMethod === 'cornell' ? 'selected' : ''}>可选线索回忆 — 卡住时再展开主干线索作为提示</option>
      </select>
      <div class="settings-actions">
        <button class="button button-primary" data-action="save-intervals">保存学习量设定</button>
        <button class="button button-outline" data-action="balance-overdue">${icon('waves')}智能平滑分流当前积压</button>
      </div>
    </section>

    <section class="settings-section">
      <h2>${icon('palette')}外观与数据</h2>
      <p>当前为 ${isDark ? '深色' : '浅色'}外观 · 存储于 ${pouchMode ? 'IndexedDB' : '本地存储'}。</p>
      <div class="settings-actions">
        <button class="button button-outline small-button" data-action="toggle-theme">${isDark ? icon('sun') : icon('moon')}${isDark ? '切换浅色外观' : '切换深色外观'}</button>
        <button class="button button-outline small-button" data-action="export">${icon('archive')}导出 JSON 备份</button>
      </div>
      <details class="ios-fold-section" data-fold-key="importJson" ${uiFolds.importJson ? 'open' : ''} style="margin-top:var(--sp-3)">
        <summary class="ios-fold-summary"><span class="fold-title-group"><span class="fold-icon">${icon('download')}</span><span>导入 JSON 备份</span></span><span class="fold-chevron">${icon('chevron-right')}</span></summary>
        <div class="ios-fold-body">
          <div class="field-note">导入会覆盖同 ID 的卡片与记录，请先导出一份备份。</div>
          <div class="settings-actions" style="margin-top:var(--sp-2)">
            <button class="button button-outline small-button" data-action="import">${icon('upload')}选择 JSON 文件</button>
            <input type="file" id="importFile" accept="application/json,.json" hidden />
          </div>
        </div>
      </details>
      <details class="ios-fold-section" data-fold-key="pwaInfo" ${uiFolds.pwaInfo || deferredInstallPrompt ? 'open' : ''} style="margin-top:var(--sp-2)">
        <summary class="ios-fold-summary"><span class="fold-title-group"><span class="fold-icon">${icon('cards')}</span><span>安装为应用 (PWA) 与离线使用</span></span><span class="fold-chevron">${icon('chevron-right')}</span></summary>
        <div class="ios-fold-body">
          <div class="field-note">
            ${isStandalonePwa() ? '当前正以独立应用模式运行。' : '可添加到手机主屏幕或桌面像独立 App 一样全屏运行。'}
            ${swRegistration ? '离线外壳已就绪，断网时仍可复习本地卡片。' : (isPwaSecureContext() ? '正在准备离线外壳…' : '当前为非加密 HTTP 地址：iOS Safari「添加到主屏幕」仍可全屏使用；完整离线缓存与一键安装需通过 HTTPS 或 localhost 访问。')}
          </div>
          <div class="settings-actions" style="margin-top:var(--sp-2)">
            ${!isStandalonePwa() && deferredInstallPrompt ? `<button class="button button-primary small-button" data-action="install-pwa">${icon('download')}一键安装应用</button>` : ''}
            <button class="button button-outline small-button" data-action="refresh-pwa-cache">${icon('sync')}更新离线缓存</button>
          </div>
        </div>
      </details>
    </section>

    <section class="settings-section">
      <h2>${icon('sync')}多设备同步</h2>
      <p>连接个人 CouchDB 后可在多设备间双向同步；本地单机使用无需配置。</p>
      <details class="ios-fold-section" data-fold-key="couchSettings" ${uiFolds.couchSettings || syncHandler || prefillUrl ? 'open' : ''}>
        <summary class="ios-fold-summary"><span class="fold-title-group"><span class="fold-icon">${icon('cloud')}</span><span>高级：连接个人 CouchDB</span></span><span class="fold-chevron">${icon('chevron-right')}</span></summary>
        <div class="ios-fold-body">
          <div class="field-note">需要已创建的数据库和有读写权限的专用账号。浏览器直连需要服务器启用 HTTPS 与 CORS。</div>
          <div class="settings-grid" style="grid-template-columns:1fr 1fr;margin-top:var(--sp-2)">
            <div class="settings-field"><label class="field-label" for="couchUrl">HTTPS 服务地址</label><input class="text-input" id="couchUrl" type="url" placeholder="https://db.example.com" value="${escapeHtml(prefillUrl)}" /></div>
            <div class="settings-field"><label class="field-label" for="couchDb">数据库名</label><input class="text-input" id="couchDb" placeholder="studystyle" value="${escapeHtml(prefillDb)}" /></div>
            <div class="settings-field"><label class="field-label" for="couchUser">专用用户名</label><input class="text-input" id="couchUser" autocomplete="username" value="${escapeHtml(prefillUser)}" /></div>
            <div class="settings-field"><label class="field-label" for="couchPass">密码 <span class="optional">不会写入同步库或导出备份</span></label><input class="text-input" id="couchPass" type="password" autocomplete="current-password" value="${escapeHtml(prefillPass)}" /></div>
          </div>
          <label class="ios-check-row" style="margin-top:var(--sp-3)">
            <input type="checkbox" id="couchRememberCheck" ${rememberChecked ? 'checked' : ''} />
            <span><strong>在此已验证浏览器长期保存同步信息：</strong>验证通过后仅保存在本机浏览器，下次打开无需重新填写账号密码并自动连接同步</span>
          </label>
          <div class="settings-actions">
            <button class="button button-outline" data-action="test-couch">测试连接</button>
            <button class="button button-primary" data-action="connect-couch">连接并同步</button>
            ${syncHandler ? '<button class="button button-quiet" data-action="disconnect-couch">断开</button>' : ''}
            ${savedCreds?.password ? '<button class="button button-quiet" data-action="forget-couch">清除已保存凭据</button>' : ''}
          </div>
          <div class="status-box ${escapeHtml(couchStatusState.variant)}" id="couchStatus">${escapeHtml(couchStatusState.text || (syncHandler ? '已连接，正在双向同步。' : (savedCreds?.password ? '已在本浏览器保存通过验证的同步信息，无需重填密码，可直接点击「连接并同步」。' : (pouchMode ? '本地 PouchDB 可用。填入服务器信息后测试连接。' : '按需点击「测试连接」时将自动加载同步组件。'))))}</div>
        </div>
      </details>
    </section>
  </div>`;
}

/* ===================== 卡片编辑弹窗 ===================== */
async function openCardDialog(card = null) {
  const form = $('#cardForm'); form.reset();
  form.elements.id.value = card?._id || '';
  form.elements.title.value = card?.title || '';
  form.elements.outline.value = card?.outline || '';
  form.elements.tags.value = card?.tags?.join(', ') || '';
  const defaultNb = card ? cardNotebook(card) : (activeNotebookFilter || Domain.DEFAULT_NOTEBOOK);
  if (form.elements.notebook) form.elements.notebook.value = defaultNb;
  if ($('#cardNotebook')) $('#cardNotebook').value = defaultNb;
  const settings = await getSetting(); const intervals = settings?.interval_days || INTERVALS;
  const defaultDue = card?.due_date || addDays(localDay(), intervals[0]);
  form.elements.due_date.value = defaultDue;
  if ($('#cardMetaFold')) $('#cardMetaFold').open = Boolean(card?.tags?.length);
  if ($('#cardMetaSummaryHint')) $('#cardMetaSummaryHint').textContent = card?.tags?.length ? `${card.tags.join(' · ')} · ${fmtDate(defaultDue)}` : `选填 · 默认 ${fmtDate(defaultDue)} 复习`;
  const previewEl = $('#cardOutlinePreview');
  if (previewEl) { previewEl.classList.add('hidden'); previewEl.innerHTML = ''; }
  if ($('#toggleOutlinePreview')) $('#toggleOutlinePreview').textContent = '预览效果';
  const allCards = await getCards();
  const notebooks = Domain.collectNotebooks(allCards, settings?.notebooks || [], localDay());
  if ($('#quickNotebookList')) {
    $('#quickNotebookList').innerHTML = notebooks.map(nb => `<button type="button" class="tag-chip ${nb.name === defaultNb ? 'active' : ''}" data-quick-notebook="${escapeHtml(nb.name)}"><i class="nb-dot nb-color-${nb.color}"></i> ${escapeHtml(nb.name)}</button>`).join('');
  }
  const allTags = [...new Set(allCards.flatMap(c => c.tags || []))].sort((a, b) => a.localeCompare(b, 'zh-CN'));
  if ($('#quickTagList')) {
    $('#quickTagList').innerHTML = allTags.length ? allTags.map(t => `<button type="button" class="tag-chip" data-quick-tag="${escapeHtml(t)}">+ ${escapeHtml(t)}</button>`).join('') : '';
  }
  $('#cardDialogTitle').textContent = card ? '编辑卡片' : '新增卡片'; $('#cardDialog').showModal(); $('#cardTitle').focus();
}

async function saveCardFromDialog(event) {
  event.preventDefault();
  const form = $('#cardForm');
  const title = (form.elements.title?.value || $('#cardTitle')?.value || '').trim();
  const outline = (form.elements.outline?.value || $('#cardOutline')?.value || '').trim();
  if (!title || !outline) { showToast('请填写卡片标题与大纲内容'); return; }
  const rawTags = form.elements.tags?.value || $('#cardTags')?.value || '';
  const tags = [...new Set(rawTags.split(/[,，]/).map(t => t.trim()).filter(Boolean))];
  const notebook = Domain.normalizeNotebook(form.elements.notebook?.value || $('#cardNotebook')?.value || activeNotebookFilter || Domain.DEFAULT_NOTEBOOK);
  const dueDate = form.elements.due_date?.value || $('#cardDueDate')?.value || '';
  const id = form.elements.id?.value || '';
  await saveCard({ id, title, outline, tags, notebook, due_date: dueDate });
  $('#cardDialog')?.close();
  showToast(id ? `已更新卡片《${title}》` : `已添加至「${notebook}」`);
  await render();
  if ($('#reviewDialog')?.open && reviewQueue[reviewIndex]?._id === id) {
    await showReviewCard();
  }
}

/* ===================== 科目笔记本管理弹窗 ===================== */
const NOTEBOOK_COLOR_LABELS = {
  indigo: '靛蓝',
  emerald: '翠绿',
  amber: '琥珀',
  rose: '珊瑚',
  sky: '晴空',
  violet: '紫罗兰'
};

function renderNotebookColorSwatches(selected = selectedNotebookColor) {
  selectedNotebookColor = Domain.NOTEBOOK_COLORS.includes(selected) ? selected : 'indigo';
  const picker = $('#notebookColorPicker');
  if (!picker) return;
  picker.innerHTML = Domain.NOTEBOOK_COLORS.map(color => `<button type="button" class="nb-color-swatch nb-color-${color} ${color === selectedNotebookColor ? 'active' : ''}" data-nb-color="${color}" role="radio" aria-checked="${color === selectedNotebookColor}" title="${NOTEBOOK_COLOR_LABELS[color] || color}"><span>${NOTEBOOK_COLOR_LABELS[color] || color}</span></button>`).join('');
}

async function openNotebookDialog(editName = null) {
  const allCards = await getCards();
  const settings = (await getSetting()) || {};
  const notebooks = Domain.collectNotebooks(allCards, settings.notebooks || [], localDay());
  const target = editName ? notebooks.find(n => n.name === editName) : null;
  if ($('#notebookOldName')) $('#notebookOldName').value = target ? target.name : '';
  if ($('#notebookNameInput')) $('#notebookNameInput').value = target ? target.name : '';
  if ($('#notebookDialogTitle')) $('#notebookDialogTitle').textContent = target ? `编辑笔记本「${target.name}」` : '科目笔记本管理';
  if ($('#saveNotebookBtn')) $('#saveNotebookBtn').textContent = target ? '保存修改' : '新建 / 保存笔记本';
  const nextColor = target ? target.color : Domain.NOTEBOOK_COLORS[notebooks.length % Domain.NOTEBOOK_COLORS.length];
  renderNotebookColorSwatches(nextColor);
  const listEl = $('#notebookManageList');
  if (listEl) {
    listEl.innerHTML = `<div class="field-label" style="margin-top:var(--sp-3)">现有科目笔记本（共 ${notebooks.length} 个）</div>` + notebooks.map(nb => `<div class="notebook-manage-row ${editName === nb.name ? 'is-editing' : ''}">
      <div class="notebook-manage-info">
        <i class="nb-dot nb-color-${nb.color}"></i>
        <strong>${escapeHtml(nb.name)}</strong>
        <span class="muted">${nb.total} 张卡片${nb.due ? ` · ${nb.due} 待复习` : ''}</span>
      </div>
      <div class="inline-actions">
        <button type="button" class="button button-quiet small-button" data-edit-notebook="${escapeHtml(nb.name)}">${icon('edit')}改名/配色</button>
        ${nb.name !== Domain.DEFAULT_NOTEBOOK ? `<button type="button" class="button button-quiet small-button danger-text" data-delete-notebook="${escapeHtml(nb.name)}">${icon('trash')}删除</button>` : ''}
      </div>
    </div>`).join('');
  }
  if (!$('#notebookDialog')?.open) $('#notebookDialog')?.showModal();
  $('#notebookNameInput')?.focus();
}

async function saveNotebookFromDialog(event) {
  event.preventDefault();
  const oldName = ($('#notebookOldName')?.value || '').trim();
  const newName = Domain.normalizeNotebook($('#notebookNameInput')?.value || '');
  if (!newName) { showToast('请输入科目笔记本名称'); return; }
  const settings = (await getSetting()) || {};
  const allCards = await getCards();
  const existing = Domain.collectNotebooks(allCards, settings.notebooks || [], localDay());
  const nextSaved = existing.map(nb => ({ name: nb.name, color: nb.color }));
  if (oldName) {
    const idx = nextSaved.findIndex(n => n.name === oldName);
    if (idx >= 0) nextSaved[idx] = { name: newName, color: selectedNotebookColor };
    else nextSaved.push({ name: newName, color: selectedNotebookColor });
    if (oldName !== newName) {
      for (const card of allCards) {
        if (cardNotebook(card) === oldName) {
          await db.put({ ...card, notebook: newName, updated_at: new Date().toISOString() });
        }
      }
      if (activeNotebookFilter === oldName) activeNotebookFilter = newName;
    }
  } else {
    const idx = nextSaved.findIndex(n => n.name === newName);
    if (idx >= 0) nextSaved[idx].color = selectedNotebookColor;
    else nextSaved.push({ name: newName, color: selectedNotebookColor });
    activeNotebookFilter = newName;
  }
  const dedupMap = new Map();
  for (const item of nextSaved) dedupMap.set(item.name, item);
  await saveSetting({ ...settings, notebooks: [...dedupMap.values()] });
  $('#notebookDialog')?.close();
  showToast(oldName ? `已保存笔记本「${newName}」` : `已创建并切换至科目本「${newName}」`);
  await render();
}

async function deleteNotebook(name) {
  if (!name || name === Domain.DEFAULT_NOTEBOOK) return;
  const allCards = await getCards();
  const affected = allCards.filter(c => cardNotebook(c) === name);
  const yes = await askConfirm(
    `删除科目本「${name}」`,
    affected.length
      ? `删除后，该本子下的 ${affected.length} 张卡片不会丢失，将自动移回「${Domain.DEFAULT_NOTEBOOK}」。确定继续？`
      : `确定删除空科目笔记本「${name}」？`,
    '确认删除'
  );
  if (!yes) return;
  for (const card of affected) {
    await db.put({ ...card, notebook: Domain.DEFAULT_NOTEBOOK, updated_at: new Date().toISOString() });
  }
  const settings = (await getSetting()) || {};
  const nextNbs = (settings.notebooks || []).filter(item => (typeof item === 'string' ? item : item?.name) !== name);
  await saveSetting({ ...settings, notebooks: nextNbs });
  if (activeNotebookFilter === name) activeNotebookFilter = null;
  if ($('#notebookDialog')?.open) await openNotebookDialog();
  showToast(`已删除「${name}」，卡片已归入${Domain.DEFAULT_NOTEBOOK}`);
  await render();
}

/* ===================== 复习流程 ===================== */
async function beginReview(cards = null) {
  reviewMode = 'due'; randomPool = []; randomDrawCount = 0; finishAfterSave = false;
  reviewQueue = cards || await dueCards(); reviewIndex = 0; if (!reviewQueue.length) return showToast('当前没有到期卡片'); await showReviewCard(); if (!$('#reviewDialog').open) $('#reviewDialog').showModal(); focusReviewStep();
}
async function beginMixedReview() {
  const due = await dueCards(false);
  const mixed = Domain.interleaveByNotebook(due);
  if (!mixed.length) return showToast('当前没有到期卡片');
  await beginReview(mixed);
}
async function beginRandomReview(pool = null) {
  const allCards = filterByNotebook(await getCards());
  if (!allCards.length) return showToast(activeNotebookFilter ? `科目「${activeNotebookFilter}」下还没有卡片` : '还没有卡片，请先新增卡片');
  let candidates = pool;
  if (!candidates) {
    if (view === 'library') {
      const visibleIds = new Set($$('.library-row[data-card-row]').filter(row => !row.hidden).map(row => row.dataset.cardRow));
      candidates = visibleIds.size ? allCards.filter(card => visibleIds.has(card._id)) : (activeBagFilter == null ? allCards : allCards.filter(card => bagFor(card) === activeBagFilter));
    } else {
      candidates = activeBagFilter == null ? allCards : allCards.filter(card => bagFor(card) === activeBagFilter);
    }
  }
  if (!candidates.length) return showToast('当前筛选范围内没有可抽取的卡片');
  reviewMode = 'random'; randomPool = candidates; randomDrawCount = 1; finishAfterSave = false;
  const picked = Domain.pickRandomCard(randomPool, reviewQueue[reviewIndex]?._id);
  reviewQueue = [picked]; reviewIndex = 0;
  await showReviewCard();
  if (!$('#reviewDialog').open) $('#reviewDialog').showModal();
  focusReviewStep();
}
async function rerollRandomCard() {
  if (reviewMode !== 'random' || !randomPool.length) return;
  if (randomPool.length <= 1) return showToast('当前范围内只有 1 张卡片');
  const currentId = reviewQueue[reviewIndex]?._id;
  const nextCard = Domain.pickRandomCard(randomPool, currentId);
  reviewQueue = [nextCard]; reviewIndex = 0; randomDrawCount++;
  await showReviewCard();
}
function updateKeyTermCheck() {
  const bar = $('#keyTermCheckBar');
  if (!bar) return;
  const card = reviewQueue[reviewIndex];
  const recallText = $('#reviewForm')?.elements?.recall?.value || '';
  if (!card || !recallText.trim()) {
    bar.innerHTML = '';
    bar.classList.add('hidden');
    return;
  }
  const result = Domain.checkKeyTermHits(card.outline, recallText);
  if (!result.total) {
    bar.innerHTML = '';
    bar.classList.add('hidden');
    return;
  }
  const hitBadges = result.hits.map(t => `<span class="term-pill hit">${icon('check')} ${escapeHtml(t)}</span>`).join('');
  const missedBadges = result.missed.map(t => `<span class="term-pill missed">${icon('close')} ${escapeHtml(t)}</span>`).join('');
  const fillBtn = result.missed.length ? `<button type="button" class="text-button" data-action="fill-missed-note">将漏词填入备注</button>` : '';
  bar.innerHTML = `<div class="keyterm-head"><span>标记词查漏（不作为掌握度评分）：命中 <strong>${result.hitCount} / ${result.total}</strong></span><div class="inline-actions">${fillBtn}</div></div><div class="keyterm-pills">${hitBadges}${missedBadges}</div>`;
  bar.classList.remove('hidden');
}

function startCardTimer() {
  cardReviewStartedAt = Date.now();
  clearInterval(reviewTimerInterval);
  const text = $('#reviewTimerText');
  if (text) text.textContent = '00:00';
  reviewTimerInterval = setInterval(() => {
    if (!$('#reviewDialog')?.open) { clearInterval(reviewTimerInterval); return; }
    const elapsed = Math.max(0, Math.floor((Date.now() - cardReviewStartedAt) / 1000));
    const mm = String(Math.floor(elapsed / 60)).padStart(2, '0');
    const ss = String(elapsed % 60).padStart(2, '0');
    if ($('#reviewTimerText')) $('#reviewTimerText').textContent = `${mm}:${ss}`;
  }, 1000);
}

async function batchCreateFromMarkdown() {
  const raw = $('#batchMdInput')?.value || '';
  const tagStr = $('#batchMdTags')?.value || '';
  const nb = Domain.normalizeNotebook($('#batchMdNotebook')?.value || activeNotebookFilter || Domain.DEFAULT_NOTEBOOK);
  const defaultTags = tagStr.split(',').map(t => t.trim()).filter(Boolean);
  const parsed = Domain.parseBatchMarkdownCards(raw, defaultTags, nb);
  if (!parsed.length) {
    showToast('请以 # 或 ## 标题开头输入至少一张卡片及大纲');
    return;
  }
  for (const item of parsed) {
    await saveCard({ id: '', title: item.title, outline: item.outline, tags: item.tags, notebook: item.notebook });
  }
  if ($('#batchMdInput')) $('#batchMdInput').value = '';
  showToast(`已成功拆分并创建 ${parsed.length} 张卡片至「${nb}」`);
  await render();
}

function insertMarkdownFormat(mode) {
  const ta = $('#cardOutline');
  if (!ta) return;
  const start = ta.selectionStart ?? ta.value.length;
  const end = ta.selectionEnd ?? ta.value.length;
  const selected = ta.value.slice(start, end);
  let replacement = '';
  let cursorOffset = 0;
  if (mode === 'list') {
    const prefix = start > 0 && ta.value[start - 1] !== '\n' ? '\n- ' : '- ';
    replacement = `${prefix}${selected || '要点内容'}`;
    cursorOffset = replacement.length;
  } else if (mode === 'bold') {
    replacement = `**${selected || '重点词'}**`;
    cursorOffset = selected ? replacement.length : 2;
  } else if (mode === 'cloze') {
    replacement = `==${selected || '挖空内容'}==`;
    cursorOffset = selected ? replacement.length : 2;
  } else if (mode === 'code') {
    replacement = `\`${selected || 'code'}\``;
    cursorOffset = selected ? replacement.length : 1;
  }
  ta.value = ta.value.slice(0, start) + replacement + ta.value.slice(end);
  ta.focus();
  ta.setSelectionRange(start + cursorOffset, start + (selected ? replacement.length : replacement.length - cursorOffset));
  const preview = $('#cardOutlinePreview');
  if (preview && !preview.classList.contains('hidden')) {
    preview.innerHTML = `<div class="recall-label">大纲预览（点击挖空块可测试显隐）</div><div class="markdown-body">${markdownToHtml(ta.value)}</div>`;
  }
}

function insertNoteTemplate(tplKey) {
  const ta = $('#cardOutline');
  const tpl = Domain.NOTE_TEMPLATES?.[tplKey];
  if (!ta || !tpl) return;
  const current = ta.value.trim();
  ta.value = current ? `${current}\n\n${tpl}` : tpl;
  ta.focus();
  const preview = $('#cardOutlinePreview');
  if (preview && !preview.classList.contains('hidden')) {
    preview.innerHTML = `<div class="recall-label">大纲预览（点击挖空块可测试显隐）</div><div class="markdown-body">${markdownToHtml(ta.value)}</div>`;
  }
  showToast('已插入笔记大纲模板');
}

function applyStudyMethodUI(methodKey, card = reviewQueue[reviewIndex]) {
  const method = Domain.STUDY_METHODS?.[methodKey] || Domain.STUDY_METHODS?.blurting;
  if (!method) return;
  activeStudyMethod = method.key;
  $$('[data-study-method]').forEach(btn => btn.classList.toggle('active', btn.dataset.studyMethod === method.key));
  const promptEl = $('#recallPromptLabel');
  if (promptEl) promptEl.innerHTML = `${icon('pen-line')}${method.name}`;
  const inputEl = $('#recallInput') || $('#reviewForm')?.elements?.recall;
  if (inputEl) inputEl.placeholder = method.prompt;
  const cuesBox = $('#cornellCuesBox');
  if (!cuesBox) return;
  if (method.key === 'cornell' && card) {
    const cues = Domain.extractCornellCues(card.outline);
    if (cues.length) {
      cuesBox.innerHTML = `<details><summary class="cornell-cues-title">${icon('layout-grid')}自由回忆卡住时再展开线索</summary><p class="field-note">线索会降低回忆难度；用它回忆后，记录遗漏并按答案质量自评。</p><ul class="cornell-cues-list">${cues.map(c => `<li>${escapeHtml(c)}</li>`).join('')}</ul></details>`;
      cuesBox.classList.remove('hidden');
      return;
    }
  }
  if (method.key === 'feynman') {
      cuesBox.innerHTML = `<div class="cornell-cues-title">${icon('lightbulb')}解释与举例：试着说明问题、机制、条件和例子 <button type="button" class="text-button" data-action="fill-feynman-scaffold">插入解释提纲</button></div>`;
    cuesBox.classList.remove('hidden');
    return;
  }
  cuesBox.innerHTML = '';
  cuesBox.classList.add('hidden');
}

/* ===================== 复习弹窗：三步化 ===================== */
function setReviewStep(step) {
  reviewStep = step;
  const recallPanel = $('#recallPanel');
  const answerPanel = $('#answerPanel');
  const scoreSection = $('#scoreSection');
  const recallInput = $('#recallInput');

  $$('#stepper .stepper-item').forEach(item => {
    const itemStep = Number(item.dataset.step);
    item.classList.toggle('is-current', itemStep === step);
    item.classList.toggle('is-done', itemStep < step);
    if (itemStep === step) item.setAttribute?.('aria-current', 'step');
    else item.removeAttribute?.('aria-current');
  });

  if (answerPanel) answerPanel.classList.toggle('hidden', step < 2);
  if (recallPanel) recallPanel.classList.toggle('hidden', feedbackRecallMode);
  $('#reviewAnswerContent')?.classList.toggle('hidden', feedbackRecallMode);
  $('#feedbackRecallPanel')?.classList.toggle('hidden', !feedbackRecallMode);
  if (scoreSection) scoreSection.classList.toggle('hidden', step < 3);
  if (recallPanel) recallPanel.classList.toggle('readonly-summary', step === 3 || (step === 1 && firstRecallDraft != null));
  if (recallInput) recallInput.readOnly = step !== 1 || firstRecallDraft != null;

  const reveal = $('#revealOutline');
  if (reveal) {
    reveal.disabled = step !== 1;
    reveal.innerHTML = step === 1 ? '查看大纲 <kbd>Space</kbd>' : step === 2 ? '大纲已展开' : '大纲已展开';
  }
  const cantRecall = $('#cantRecall');
  if (cantRecall) cantRecall.classList.toggle('hidden', step !== 1);
  const backToRecall = $('#backToRecall');
  if (backToRecall) backToRecall.classList.toggle('hidden', step !== 2);
  const goToScore = $('#goToScore');
  if (goToScore) goToScore.classList.toggle('hidden', step !== 2);
  const skip = $('#skipCard');
  if (skip) skip.classList.toggle('hidden', step !== 2);
  const undo = $('#undoReviewButton');
  if (undo) undo.classList.toggle('hidden', !lastReviewSnapshot);

  focusReviewStep();
}

/* 焦点落点：第 1 步 → 回忆输入框；第 2 步 → 核对区；第 3 步 → 第 1 个评分按钮（绝不聚焦提交键） */
function focusReviewStep() {
  if (reviewStep === 1) $('#recallInput')?.focus();
  else if (reviewStep === 2) $('#answerPanel')?.focus();
  else $('#scoreButtons')?.querySelector('.score-button')?.focus();
}

function goToStepTwo(preselect) {
  if (firstRecallDraft == null) firstRecallDraft = $('#reviewForm')?.elements?.recall?.value || '';
  if (preselect != null) preselectPending = preselect;
  setReviewStep(2);
  updateKeyTermCheck();
}

function beginFeedbackRecall() {
  feedbackRecallMode = true;
  feedbackRecallDraft = null;
  const input = $('#feedbackRecallInput');
  if (input) input.value = '';
  setReviewStep(2);
  input?.focus();
}

function finishFeedbackRecall() {
  feedbackRecallDraft = $('#feedbackRecallInput')?.value?.trim() || null;
  feedbackRecallMode = false;
  setReviewStep(2);
}

function cancelFeedbackRecall() {
  feedbackRecallDraft = null;
  feedbackRecallMode = false;
  setReviewStep(2);
}

function goToStepThree() {
  setReviewStep(3);
  if (preselectPending != null) {
    selectScore(preselectPending, 0);
    const hint = $('#scorePreselectHint');
    if (hint) {
      hint.textContent = `已按“想不起来”预选 ${preselectPending}%，可直接调整`;
      hint.classList.remove('hidden');
    }
    preselectPending = null;
  }
}

async function showReviewCard() {
  if (reviewIndex >= reviewQueue.length) { $('#reviewDialog').close(); showToast('今天的复习完成'); await render(); return; }
  const card = reviewQueue[reviewIndex]; const fresh = await db.get(card._id); reviewQueue[reviewIndex] = fresh;
  const settings = await getSetting(); const intervals = settings?.interval_days || INTERVALS;
  currentReviewSettings = settings;
  const lastNoteRecord = (await getReviews()).find(r => r.card_id === fresh._id && r.note);
  const lastNoteEl = $('#lastNoteAlert');
  if (lastNoteRecord) { lastNoteEl.innerHTML = `<strong>上次漏点提醒：</strong>${escapeHtml(lastNoteRecord.note)}`; lastNoteEl.classList.remove('hidden'); }
  else { lastNoteEl.innerHTML = ''; lastNoteEl.classList.add('hidden'); }
  if ($('#keyTermCheckBar')) { $('#keyTermCheckBar').innerHTML = ''; $('#keyTermCheckBar').classList.add('hidden'); }
  $('#reviewTitle').textContent = fresh.title;
  const isRandom = reviewMode === 'random';
  $('#reviewPosition').textContent = isRandom ? `随机抽卡 · 第 ${randomDrawCount} 张（池中共 ${randomPool.length} 张）` : `${reviewIndex + 1} / ${reviewQueue.length}`;
  const progressPct = isRandom ? 100 : Math.round(((reviewIndex + 1) / Math.max(1, reviewQueue.length)) * 100);
  if ($('#reviewProgressBar')) $('#reviewProgressBar').style.width = `${progressPct}%`;
  const track = $('#reviewProgressTrack');
  if (track) {
    track.setAttribute?.('aria-valuenow', String(progressPct));
    track.setAttribute?.('aria-valuetext', isRandom ? `随机第 ${randomDrawCount} 张` : `第 ${reviewIndex + 1} / ${reviewQueue.length} 张`);
  }
  $('#undoReviewButton')?.classList.toggle('hidden', !lastReviewSnapshot);
  $('#rerollRandomCard')?.classList.toggle('hidden', !isRandom || randomPool.length <= 1);
  $('#saveAndFinishRandom')?.classList.toggle('hidden', !isRandom);
  if ($('#saveAndFinishRandom')) $('#saveAndFinishRandom').disabled = true;
  $('#saveReview').innerHTML = isRandom ? `保存并再抽一张 ${icon('dice')}` : '保存并继续 <span>→</span>';
  const nbBadge = $('#reviewNotebookBadge');
  if (nbBadge) {
    const nbName = cardNotebook(fresh);
    const nbs = Domain.collectNotebooks(await getCards(), settings?.notebooks || [], localDay());
    const nbObj = nbs.find(n => n.name === nbName);
    nbBadge.className = `notebook-chip nb-color-${nbObj?.color || 'indigo'}`;
    nbBadge.innerHTML = `${icon('book')}<span>${escapeHtml(nbName)}</span>`;
  }
  const bagBadge = $('#reviewBagBadge');
  if (bagBadge) { bagBadge.className = `badge ${levelClass(bagIndex(fresh))}`; bagBadge.textContent = bagInfo(fresh).name; }
  $('#reviewInterval').textContent = `当前周期 ${intervalFor(fresh, intervals)} 天 · 下次到期 ${fmtDate(fresh.due_date)}`;
  $('#reviewOutline').innerHTML = markdownToHtml(fresh.outline);
  const hasCloze = Boolean($('#reviewOutline').querySelector('.cloze-mask'));
  $('#toggleAllCloze')?.classList.toggle('hidden', !hasCloze);
  $('#reviewForm').elements.recall.value = ''; $('#reviewForm').elements.note.value = '';
  if ($('#applicationAttempt')) $('#applicationAttempt').value = '';
  $('#scoreRange').value = 50; $('#scoreOutput').value = '50%';
  selectedScore = null; selectedPreset = null; lowCycleChoice = null; $('#saveReview').disabled = true;
  preselectPending = null;
  firstRecallDraft = null;
  feedbackRecallMode = false;
  feedbackRecallDraft = null;
  const preselectHint = $('#scorePreselectHint');
  if (preselectHint) { preselectHint.textContent = ''; preselectHint.classList.add('hidden'); }
  applyStudyMethodUI(settings?.study_method || activeStudyMethod || 'blurting', fresh);
  startCardTimer();
  drawScoreButtons(settings, fresh);
  setReviewStep(1);
}

/* 5 档评分按钮：靛蓝单色相梯度，格内「等级名 + 下次间隔 + 数值」 */
function drawScoreButtons(settings, card) {
  const intervals = settings?.interval_days || INTERVALS;
  const passThreshold = Number(settings?.hold_interval_below_score ?? 40);
  const defaultLow = settings?.default_low_action || 'hold';
  const adaptiveLeap = settings?.adaptive_leap === true;
  const today = localDay();
  const buttons = SCORE_PRESETS.map((score, index) => {
    const mode = score < passThreshold ? defaultLow : 'advance';
    let days = intervals[0];
    if (card) {
      try { days = Domain.nextSchedule(card.interval_index, score, mode, today, intervals, { passThreshold, adaptiveLeap }).days; }
      catch { days = intervals[0]; }
    }
    const selected = selectedPreset === index;
    return `<button type="button" role="radio" aria-checked="${selected}" class="score-button ${selected ? 'selected' : ''}" data-score-preset="${index}" aria-label="${score}% ${SCORE_GRADES[index]}，下次 ${days} 天">
      <kbd class="score-kbd">${index + 1}</kbd>
      <span class="score-grade"><span class="bag-dot" style="--bag-dot: var(--score-${index + 1})"></span>${SCORE_GRADES[index]}</span>
      <span class="score-percent">${score}%</span>
      <span class="score-interval">下次 ${days} 天</span>
    </button>`;
  }).join('');
  const holder = $('#scoreButtons');
  if (holder) holder.innerHTML = buttons;
}
function selectScore(score, preset = null) {
  selectedScore = score; selectedPreset = preset;
  const range = $('#scoreRange'); if (range) range.value = score;
  const output = $('#scoreOutput'); if (output) output.value = `${score}%`;
  const save = $('#saveReview'); if (save) save.disabled = false;
  const saveFinish = $('#saveAndFinishRandom'); if (saveFinish) saveFinish.disabled = false;
  drawScoreButtons(currentReviewSettings, reviewQueue[reviewIndex]);
  return updateSchedulePreview();
}

async function updateSchedulePreview() {
  if (selectedScore == null) return;
  const card = reviewQueue[reviewIndex];
  if (!card) return;
  const settings = await getSetting();
  currentReviewSettings = settings;
  const intervals = settings?.interval_days || INTERVALS;
  const passThreshold = Number(settings?.hold_interval_below_score ?? 40);
  const defaultLow = settings?.default_low_action || 'hold';
  const adaptiveLeap = settings?.adaptive_leap === true;
  const low = selectedScore < passThreshold;
  /* 低分策略是「每张卡」的决策：用户手动选过就沿用，否则回落到全局默认。
     直接读 radio 的 checked 会把上一张卡的选择带到下一张，必须由显式状态驱动。 */
  const mode = (low && lowCycleChoice) || (low ? defaultLow : 'advance');
  const schedule = Domain.nextSchedule(card.interval_index, selectedScore, mode, localDay(), intervals, { passThreshold, adaptiveLeap });
  const keepCheckbox = $('input[name="keepRandomDue"]');
  const keepDue = reviewMode === 'random' ? (keepCheckbox ? keepCheckbox.checked : card.due_date > localDay()) : false;
  const leaped = !low && adaptiveLeap && selectedScore >= 85 && schedule.intervalIndex - card.interval_index >= 2;
  const action = mode === 'hold' ? '保持当前档位' : mode === 'reset' ? '重置至 1 天' : leaped ? '高分跳级至下两档' : '升至下一档';
  $('#scoreNextHint').textContent = `${BAG_NAMES[schedule.bag]} · ${selectedScore}%`;
  const summaryText = keepDue
    ? `保存后进入 <strong>${BAG_NAMES[schedule.bag]}</strong>，仅自测巩固，保持原到期日 <strong>${fmtDate(card.due_date, { year: 'numeric', month: 'long', day: 'numeric' })}</strong>`
    : `保存后进入 <strong>${BAG_NAMES[schedule.bag]}</strong>，${action}（${schedule.days} 天），下次复习 <strong>${fmtDate(schedule.dueDate, { year: 'numeric', month: 'long', day: 'numeric' })}</strong>`;
  const lowOptionsHtml = (!keepDue && low) ? `<div class="schedule-options">
    <label class="schedule-option"><input type="radio" name="lowCycle" value="hold" ${mode === 'hold' ? 'checked' : ''} /><span><strong>保持当前周期</strong><small>不再往后延，下次仍按当前档位复习</small></span></label>
    <label class="schedule-option"><input type="radio" name="lowCycle" value="reset" ${mode === 'reset' ? 'checked' : ''} /><span><strong>重置为 1 天</strong><small>明天就再来一次，重新巩固这一张</small></span></label>
    <label class="schedule-option"><input type="radio" name="lowCycle" value="advance" ${mode === 'advance' ? 'checked' : ''} /><span><strong>照常升档</strong><small>即使没过线也照常往后延一档</small></span></label>
  </div>` : '';
  const randomOptionHtml = reviewMode === 'random' ? `<div class="schedule-options"><label class="schedule-option"><input type="checkbox" name="keepRandomDue" value="1" ${keepDue ? 'checked' : ''} /><span><strong>仅更新记忆等级，保持原定到期日（${fmtDate(card.due_date)}）</strong><small>随机抽卡只做自测，不改变排期</small></span></label></div>` : '';
  $('#schedulePreview').innerHTML = `${summaryText}${lowOptionsHtml}${randomOptionHtml}`;
}

async function saveReview(event) {
  event.preventDefault();
  if (selectedScore == null) return;
  const card = await db.get(reviewQueue[reviewIndex]._id);
  const cardBefore = { ...card };
  const settings = await getSetting();
  const intervals = settings?.interval_days || INTERVALS;
  const passThreshold = Number(settings?.hold_interval_below_score ?? 40);
  const defaultLow = settings?.default_low_action || 'hold';
  const adaptiveLeap = settings?.adaptive_leap === true;
  const reviewedAt = new Date().toISOString();
  const keepDue = reviewMode === 'random' && Boolean($('input[name="keepRandomDue"]')?.checked);
  const isLowScore = selectedScore < passThreshold;
  const mode = (isLowScore && lowCycleChoice) || (isLowScore ? defaultLow : 'advance');
  const schedule = Domain.nextSchedule(card.interval_index, selectedScore, mode, localDay(new Date(reviewedAt)), intervals, { passThreshold, adaptiveLeap });
  const nextIntervalIndex = keepDue ? card.interval_index : schedule.intervalIndex;
  const nextDays = keepDue ? intervalFor(card, intervals) : schedule.days;
  const nextDueDate = keepDue ? card.due_date : schedule.dueDate;
  const durationSec = cardReviewStartedAt ? Math.max(1, Math.round((Date.now() - cardReviewStartedAt) / 1000)) : null;
  const recallValue = $('#reviewForm').elements.recall.value;
  const review = { _id: `review:${uuid()}`, type: 'review', card_id: card._id, reviewed_at: reviewedAt, memory_score: selectedScore, bag_after: schedule.bag + 1, interval_days_before: intervalFor(card, intervals), interval_days_after: nextDays, next_due_date: nextDueDate, duration_sec: durationSec, recall_draft: firstRecallDraft ?? recallValue, recall_after_feedback: feedbackRecallDraft, note: $('#reviewForm').elements.note.value.trim(), application_attempt: $('#applicationAttempt')?.value.trim() || '' };
  card.latest_memory_score = selectedScore; card.interval_index = nextIntervalIndex; card.due_date = nextDueDate; card.last_reviewed_at = reviewedAt;
  await db.put(card); await db.put(review);
  lastReviewSnapshot = { cardBefore, reviewId: review._id, mode: reviewMode };
  if (reviewMode === 'random') {
    const freshPool = await getCards();
    const poolIds = new Set(randomPool.map(item => item._id));
    randomPool = freshPool.filter(item => poolIds.has(item._id));
    if (finishAfterSave || !randomPool.length) {
      finishAfterSave = false; $('#reviewDialog').close(); showToast('随机抽卡已保存', true); await render(); return;
    }
    const nextCard = Domain.pickRandomCard(randomPool, card._id);
    reviewQueue = [nextCard]; reviewIndex = 0; randomDrawCount++;
    showToast('已保存，为您抽出下一张', true);
    await showReviewCard(); await render(); return;
  }
  reviewIndex++;
  if (reviewIndex >= reviewQueue.length) { $('#reviewDialog').close(); showToast('今天的复习完成', true); await render(); return; }
  await showReviewCard();
}

/* 第 2 步「跳过这张」：记 10% 并把到期日设为明天 */
async function skipCurrentCard() {
  const card = await db.get(reviewQueue[reviewIndex]._id);
  const cardBefore = { ...card };
  const settings = await getSetting();
  const intervals = settings?.interval_days || INTERVALS;
  const passThreshold = Number(settings?.hold_interval_below_score ?? 40);
  const adaptiveLeap = settings?.adaptive_leap === true;
  const reviewedAt = new Date().toISOString();
  const schedule = Domain.nextSchedule(card.interval_index, 10, 'reset', localDay(new Date(reviewedAt)), intervals, { passThreshold, adaptiveLeap });
  const review = {
    _id: `review:${uuid()}`, type: 'review', card_id: card._id, reviewed_at: reviewedAt, memory_score: 10,
    bag_after: schedule.bag + 1, interval_days_before: intervalFor(card, intervals), interval_days_after: schedule.days,
    next_due_date: schedule.dueDate, duration_sec: cardReviewStartedAt ? Math.max(1, Math.round((Date.now() - cardReviewStartedAt) / 1000)) : null,
    recall_draft: firstRecallDraft ?? $('#reviewForm').elements.recall.value, recall_after_feedback: feedbackRecallDraft, note: '跳过本张，明天再复习'
  };
  card.latest_memory_score = 10; card.interval_index = schedule.intervalIndex; card.due_date = schedule.dueDate; card.last_reviewed_at = reviewedAt;
  await db.put(card); await db.put(review);
  lastReviewSnapshot = { cardBefore, reviewId: review._id, mode: reviewMode };
  showToast(`已跳过《${card.title}》，明天再复习`, true);
  reviewIndex++;
  if (reviewIndex >= reviewQueue.length) { $('#reviewDialog').close(); showToast('今天的复习完成', true); await render(); return; }
  await showReviewCard();
}

async function undoLastReview() {
  if (!lastReviewSnapshot) return;
  const { cardBefore, reviewId } = lastReviewSnapshot;
  lastReviewSnapshot = null;
  const currentCard = await db.get(cardBefore._id).catch(() => null);
  await db.put({ ...cardBefore, ...(currentCard ? { _rev: currentCard._rev } : {}) });
  const revDoc = await db.get(reviewId).catch(() => null);
  if (revDoc) await db.remove(revDoc);
  showToast(`已撤销《${cardBefore.title}》的打分`);
  await render();
  if ($('#reviewDialog').open) {
    reviewQueue = [await db.get(cardBefore._id)];
    reviewIndex = 0;
    await showReviewCard();
  }
}

async function snoozeDue() { const due = await dueCards(); if (!due.length) return; const answer = await askConfirm('顺延未完成卡片', `将 ${due.length} 张今日到期或逾期卡片顺延到明天？`, '顺延到明天'); if (!answer) return; const tomorrow = addDays(localDay(), 1); for (const card of due) { card.due_date = tomorrow; await db.put(card); } showToast(`${due.length} 张卡片已顺延至明天`); await render(); }
function askConfirm(title, message, action) { return new Promise(resolve => { const dialog = $('#confirmDialog'); $('#confirmTitle').textContent = title; $('#confirmMessage').textContent = message; $('#confirmAction').textContent = action; dialog.returnValue = ''; dialog.showModal(); dialog.addEventListener('close', () => resolve(dialog.returnValue === 'confirm'), { once: true }); }); }
async function exportData() { const docs = (await allDocs()).map(({ _rev, ...doc }) => { if (doc.type === 'settings') delete doc.couch; return doc; }); const payload = { app: 'StudyStyle', version: 1, exported_at: new Date().toISOString(), docs }; const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }); const link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = `studystyle-backup-${localDay()}.json`; link.click(); URL.revokeObjectURL(link.href); showToast('JSON 备份已导出'); }
async function importData(file) {
  try {
    const payload = JSON.parse(await file.text());
    const docs = Array.isArray(payload) ? payload : payload.docs;
    if (!Array.isArray(docs)) throw new Error('文件格式无效');
    /* 逐条校验并修复：缺标题/大纲的卡片直接丢弃，脏分数归零，避免导入后卡片在库中「凭空消失」 */
    const importDocs = [];
    let skipped = 0;
    let repaired = 0;
    for (const doc of docs) {
      if (!doc || !['card', 'review', 'settings'].includes(doc.type)) { skipped++; continue; }
      if (!doc._id) { skipped++; continue; }
      /* _id 会进入 HTML 属性，限定字符集杜绝属性注入（与服务端校验保持一致） */
      if (!/^[A-Za-z0-9:._-]{1,128}$/.test(String(doc._id))) { skipped++; continue; }
      const { _rev, ...clean } = doc;
      if (clean.type === 'card') {
        if (typeof clean.title !== 'string' || !clean.title.trim() || typeof clean.outline !== 'string' || !clean.outline.trim()) { skipped++; continue; }
        clean.title = clean.title.trim();
        clean.outline = clean.outline.trim();
        if (clean.latest_memory_score != null) {
          const score = Number(clean.latest_memory_score);
          if (!Number.isFinite(score) || score < 0 || score > 100) { clean.latest_memory_score = null; repaired++; }
        }
        if (!/^\d{4}-\d{2}-\d{2}$/.test(String(clean.due_date || ''))) clean.due_date = addDays(localDay(), 1);
      } else if (clean.type === 'review') {
        if (typeof clean.card_id !== 'string' || !clean.card_id || !Number.isFinite(Date.parse(clean.reviewed_at || ''))) { skipped++; continue; }
        const score = Number(clean.memory_score);
        if (!Number.isFinite(score) || score < 0 || score > 100) { clean.memory_score = null; repaired++; }
        else clean.memory_score = score;
      }
      const old = await db.get(clean._id).catch(() => null);
      importDocs.push({ ...clean, ...(old ? { _rev: old._rev } : {}) });
    }
    if (importDocs.length) {
      const results = await db.bulkDocs(importDocs);
      const failure = Array.isArray(results) && results.find(result => result?.error);
      if (failure) throw new Error(failure.message || '部分数据写入失败');
    }
    const count = importDocs.length;
    flushServerStore();
    const notes = [`已导入 ${count} 条数据`];
    if (skipped) notes.push(`跳过 ${skipped} 条无效记录`);
    if (repaired) notes.push(`修复 ${repaired} 条异常分数`);
    showToast(notes.join('，'));
    await render();
  } catch (error) { showToast(`导入失败：${error.message}`); }
}

function loadSavedCouchCreds() {
  try {
    const raw = localStorage.getItem(COUCH_LOCAL_CREDS_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (!data || typeof data.url !== 'string' || typeof data.name !== 'string' || typeof data.user !== 'string' || typeof data.password !== 'string') {
      return null;
    }
    return data;
  } catch {
    return null;
  }
}

function saveVerifiedCouchCreds(creds) {
  try {
    localStorage.setItem(COUCH_LOCAL_CREDS_KEY, JSON.stringify({
      url: creds.url,
      name: creds.name,
      user: creds.user,
      password: creds.password,
      autoConnect: Boolean(creds.autoConnect),
      verifiedAt: creds.verifiedAt || new Date().toISOString()
    }));
  } catch { /* 浏览器存储不可用或配额满时不阻断同步 */ }
}

function clearSavedCouchCreds() {
  try { localStorage.removeItem(COUCH_LOCAL_CREDS_KEY); } catch {}
}

function setCouchStatus(text, variant = '') {
  couchStatusState = { text, variant };
  const status = $('#couchStatus');
  if (!status) return;
  status.className = variant ? `status-box ${variant}` : 'status-box';
  status.textContent = text;
}

function updateSyncIndicator(customLabel = null) {
  const sync = syncHandler != null || serverStoreActive;
  const dot = $('#syncDot'); if (dot) dot.classList.toggle('connected', sync);
  const label = $('#syncLabel');
  if (label) {
    label.textContent = customLabel || (syncHandler != null ? 'CouchDB 同步中' : (serverStoreActive ? '服务端已持久化' : '仅本机保存'));
  }
}

function validateCouchConfig(raw) {
  const url = String(raw?.url || '').trim().replace(/\/$/, '');
  const name = String(raw?.name || '').trim();
  const user = String(raw?.user || '').trim();
  const password = String(raw?.password ?? '');
  if (!url.startsWith('https://')) throw new Error('服务地址必须使用 HTTPS');
  const parsed = new URL(url);
  if (parsed.username || parsed.password) throw new Error('请勿把账号或密码写进服务地址');
  if (!name || !user || !password) throw new Error('请填写数据库名、用户名和密码');
  return { url, name, user, password };
}

function couchInput() {
  return validateCouchConfig({
    url: $('#couchUrl')?.value,
    name: $('#couchDb')?.value,
    user: $('#couchUser')?.value,
    password: $('#couchPass')?.value
  });
}

async function migrateLocalDocsToPouch() {
  if (pouchMode) return;
  const pouch = new window.PouchDB('studystyle');
  const fallbackDocs = JSON.parse(localStorage.getItem(LOCAL_KEY) || '[]');
  for (const { _rev, ...doc } of fallbackDocs) {
    const existing = await pouch.get(doc._id).catch(() => null);
    if (!existing) {
      await pouch.put(doc);
    } else if (Domain.pickNewerDoc(doc, existing) === doc) {
      await pouch.put({ ...doc, _rev: existing._rev });
    }
  }
  db = pouch;
  pouchMode = true;
}

async function connectCouch(testOnly = false, overrideCreds = null) {
  if (couchConnectPromise) return couchConnectPromise;
  couchConnectPromise = (async () => {
    const isSilent = Boolean(overrideCreds);
    try {
      const info = overrideCreds ? validateCouchConfig(overrideCreds) : couchInput();
      const remember = overrideCreds ? true : Boolean($('#couchRememberCheck') ? $('#couchRememberCheck').checked : true);
      const existingSaved = loadSavedCouchCreds();

      await ensurePouchDB();
      await migrateLocalDocsToPouch();
      const remote = new window.PouchDB(`${info.url}/${encodeURIComponent(info.name)}`, {
        auth: { username: info.user, password: info.password },
        skip_setup: true
      });
      setCouchStatus(isSilent ? '正在使用本机已保存的凭据恢复同步…' : '正在验证数据库连接与读写权限…');
      await remote.info();
      const probe = `studystyle:probe:${uuid()}`;
      const inserted = await remote.put({ _id: probe, type: 'probe', at: new Date().toISOString() });
      await remote.remove({ _id: probe, _rev: inserted.rev });

      const settings = await getSetting();
      await saveSetting({ ...(settings || {}), couch: { url: info.url, name: info.name, user: info.user } });

      if (remember) {
        saveVerifiedCouchCreds({
          ...info,
          autoConnect: testOnly ? Boolean(existingSaved?.autoConnect) : true
        });
      } else {
        clearSavedCouchCreds();
      }

      if (testOnly) {
        setCouchStatus(
          remember
            ? '连接成功，数据库读写权限正常。已在本机浏览器保存通过验证的同步信息（尚未开始同步）。'
            : '连接成功，数据库读写权限正常。尚未开始同步。',
          'success'
        );
        if (!isSilent && view === 'settings') await render();
        return;
      }

      if (syncHandler) syncHandler.cancel();
      syncHandler = db.sync(remote, { live: true, retry: true })
        .on('change', async () => { await render(); })
        .on('paused', () => {
          setCouchStatus(remember ? '已同步，正在监听远端变更（已保存本机免重填凭据）。' : '已同步，正在监听变更。', 'success');
          updateSyncIndicator('CouchDB 已同步');
        })
        .on('active', () => {
          setCouchStatus('同步中…');
          updateSyncIndicator('CouchDB 同步中');
        })
        .on('denied', error => { setCouchStatus(`权限不足：${error.message}`, 'error'); })
        .on('error', error => { setCouchStatus(`同步错误：${error.message}`, 'error'); });

      setCouchStatus(
        remember
          ? '连接成功，双向同步已启动并长期保存于本机浏览器。'
          : '连接成功，首次双向同步已启动。首次同步期间请保持此页面打开。',
        'success'
      );
      await render();
    } catch (error) {
      const msg = error?.message || '连接失败，请检查地址、认证、CORS 和数据库权限。';
      setCouchStatus(isSilent ? `自动恢复同步失败：${msg}` : msg, 'error');
    } finally {
      couchConnectPromise = null;
    }
  })();
  return couchConnectPromise;
}

async function resumeSavedCouchSync() {
  if (syncHandler || couchConnectPromise) return;
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
  const saved = loadSavedCouchCreds();
  if (!saved?.autoConnect || !saved.password) return;
  await connectCouch(false, saved);
}

async function disconnectCouch() {
  if (syncHandler) { syncHandler.cancel(); syncHandler = null; }
  const saved = loadSavedCouchCreds();
  if (saved) saveVerifiedCouchCreds({ ...saved, autoConnect: false });
  setCouchStatus(saved
    ? '已断开远端同步（本机已保存的连接信息仍保留，可随时重新连接或清除）。'
    : '已断开远端同步。');
  await render();
  showToast('已断开远端同步，本地数据保留');
}

async function forgetSavedCouch() {
  if (syncHandler) { syncHandler.cancel(); syncHandler = null; }
  clearSavedCouchCreds();
  const settings = await getSetting();
  if (settings?.couch) {
    const { couch, ...rest } = settings;
    await saveSetting(rest);
  }
  setCouchStatus('已清除本浏览器保存的同步服务器信息与密码。');
  await render();
  showToast('已清除本机保存的同步凭据');
}

/* ===================== 每日上限就地选择 ===================== */
const DAILY_LIMIT_OPTIONS = [
  { value: 15, label: '15 张 / 天', note: '轻量无压 · 约 10 分钟' },
  { value: 25, label: '25 张 / 天', note: '推荐均衡 · 约 20 分钟' },
  { value: 40, label: '40 张 / 天', note: '进阶强化 · 约 30 分钟' },
  { value: 60, label: '60 张 / 天', note: '考前冲刺高吞吐' },
  { value: 0, label: '不设上限', note: '显示全部到期卡片' }
];
function toggleLimitPopover() {
  const existing = $('.limit-popover');
  if (existing) { existing.remove(); return; }
  const anchor = $('.band-zone-progress');
  if (!anchor) return;
  const current = Number(todaySettings?.daily_review_limit ?? 25);
  const popover = document.createElement('div');
  popover.className = 'limit-popover';
  popover.setAttribute('role', 'menu');
  popover.innerHTML = DAILY_LIMIT_OPTIONS.map(option => `<button type="button" class="limit-option ${option.value === current ? 'active' : ''}" role="menuitem" data-limit-value="${option.value}"><span>${option.label}</span><small class="muted">${option.note}</small></button>`).join('');
  anchor.appendChild(popover);
}

/** Close the body-level floating row menu and reset trigger states. */
function closeAllRowMenus() {
  activeRowMenuCardId = null;
  const layer = $('#floatingRowMenuLayer');
  const menu = $('#floatingRowMenu');
  if (layer) {
    layer.classList.add('hidden');
    layer.setAttribute?.('aria-hidden', 'true');
  }
  if (menu) {
    menu.innerHTML = '';
    if (menu.style) {
      menu.style.top = '';
      menu.style.left = '';
      menu.style.transformOrigin = '';
    }
  }
  $$('[data-more-menu]').forEach(btn => btn.setAttribute?.('aria-expanded', 'false'));
}

/** Open the row overflow menu as a top-level fixed floating module above the base UI. */
function openFloatingRowMenu(moreBtn) {
  const cardId = moreBtn.dataset.moreMenu;
  if (!cardId) return;
  if (activeRowMenuCardId === cardId) {
    closeAllRowMenus();
    return;
  }
  closeAllRowMenus();
  const layer = $('#floatingRowMenuLayer');
  const menu = $('#floatingRowMenu');
  if (!layer || !menu) return;
  const cardTitle = moreBtn.dataset.cardTitle || '';
  const safeId = escapeHtml(cardId);
  menu.innerHTML = `${cardTitle ? `<div class="row-menu-header">${escapeHtml(cardTitle)}</div>` : ''}
    <button type="button" class="row-menu-item" data-edit="${safeId}" role="menuitem">${icon('edit')}编辑卡片</button>
    <button type="button" class="row-menu-item" data-card-history="${safeId}" role="menuitem">${icon('history')}查看记录</button>
    <button type="button" class="row-menu-item" data-archive="${safeId}" role="menuitem">${icon('archive')}归档卡片</button>
    <button type="button" class="row-menu-item danger" data-delete="${safeId}" role="menuitem">${icon('trash')}删除卡片</button>`;
  activeRowMenuCardId = cardId;
  moreBtn.setAttribute?.('aria-expanded', 'true');
  layer.classList.remove('hidden');
  layer.setAttribute?.('aria-hidden', 'false');

  if (typeof moreBtn.getBoundingClientRect === 'function' && menu.style) {
    const btnRect = moreBtn.getBoundingClientRect();
    const menuW = menu.offsetWidth || 196;
    const menuH = menu.offsetHeight || 190;
    const winW = typeof window !== 'undefined' ? (window.innerWidth || 375) : 375;
    const winH = typeof window !== 'undefined' ? (window.innerHeight || 667) : 667;
    const pad = 12;
    const bottomReserve = winW <= 640 ? 72 : pad;
    const left = Math.max(pad, Math.min(btnRect.right - menuW, winW - menuW - pad));
    const canOpenDown = btnRect.bottom + 6 + menuH <= winH - bottomReserve;
    const canOpenUp = btnRect.top - 6 - menuH >= pad;
    let top;
    if (canOpenDown || !canOpenUp) {
      top = Math.max(pad, Math.min(btnRect.bottom + 6, winH - bottomReserve - menuH));
      menu.style.transformOrigin = 'top right';
    } else {
      top = Math.max(pad, btnRect.top - 6 - menuH);
      menu.style.transformOrigin = 'bottom right';
    }
    menu.style.left = `${Math.round(left)}px`;
    menu.style.top = `${Math.round(top)}px`;
  }
}

/* ===================== 事件委托 ===================== */
document.addEventListener('click', async event => {
  try {
    const target = event.target instanceof Element ? event.target : event.target.parentElement; if (!target) return;
    const actionMenuItem = target.closest('.action-menu-item');
    if (actionMenuItem) actionMenuItem.closest('details')?.removeAttribute('open');
    const cloze = target.closest('.cloze-mask'); if (cloze) { const revealed = cloze.classList.toggle('revealed'); cloze.setAttribute('aria-expanded', String(revealed)); return; }
    /* 上限 popover：点外部即关闭 */
    const openPopover = $('.limit-popover');
    if (openPopover && !target.closest('.limit-popover') && !target.closest('[data-action="open-limit"]')) openPopover.remove();
    if (target.closest('#toggleAllCloze')) { const masks = $$('#reviewOutline .cloze-mask'); const anyHidden = masks.some(m => !m.classList.contains('revealed')); masks.forEach(m => { m.classList.toggle('revealed', anyHidden); m.setAttribute('aria-expanded', String(anyHidden)); }); return; }
    const mdWrap = target.closest('[data-md-wrap]'); if (mdWrap) { insertMarkdownFormat(mdWrap.dataset.mdWrap); return; }
    const noteTpl = target.closest('[data-note-template]'); if (noteTpl) { insertNoteTemplate(noteTpl.dataset.noteTemplate); return; }
    const methodBtn = target.closest('[data-study-method]'); if (methodBtn) {
      const mKey = methodBtn.dataset.studyMethod;
      applyStudyMethodUI(mKey, reviewQueue[reviewIndex]);
      const s = await getSetting(); if (s) await saveSetting({ ...s, study_method: mKey });
      return;
    }
    const curveBtn = target.closest('[data-interval-preset]'); if (curveBtn) {
      const pKey = curveBtn.dataset.intervalPreset;
      const preset = Domain.INTERVAL_PRESETS?.[pKey];
      if (preset && $('#intervalDays')) {
        $('#intervalDays').value = preset.days.join(', ');
        $$('[data-interval-preset]').forEach(el => el.classList.toggle('active', el.dataset.intervalPreset === pKey));
      }
      return;
    }
    if (target.closest('#themeToggleButton,[data-action="toggle-theme"]')) { await toggleTheme(); return; }
    if (target.closest('#helpDialogButton')) { if ($('#helpDialog')) $('#helpDialog').showModal(); return; }
    if (target.closest('#undoReviewButton,[data-action="undo-review"]')) { await undoLastReview(); return; }

    /* 卡片更多操作：在 body 顶层作为独立悬浮模块展开，彻底脱离底层容器与玻璃层级遮挡 */
    if (target.closest('[data-close-floating-menu]')) { closeAllRowMenus(); return; }
    const moreBtn = target.closest('[data-more-menu]');
    if (moreBtn) { openFloatingRowMenu(moreBtn); return; }
    if (activeRowMenuCardId && !target.closest('#floatingRowMenu')) closeAllRowMenus();

    const nav = target.closest('[data-view]'); if (nav) { if (nav.tagName === 'A') event.preventDefault(); view = nav.dataset.view; activeBagFilter = null; activeHistoryCardFilter = null; await render(); return; }
    const nbFilter = target.closest('[data-notebook-filter]');
    if (nbFilter) {
      const val = nbFilter.dataset.notebookFilter;
      activeNotebookFilter = val === 'all' ? null : (activeNotebookFilter === val ? null : val);
      await render(); if (view === 'library') filterLibrary();
      return;
    }
    const quickNb = target.closest('[data-quick-notebook]');
    if (quickNb) {
      const nb = quickNb.dataset.quickNotebook;
      if ($('#cardNotebook')) $('#cardNotebook').value = nb;
      $$('[data-quick-notebook]').forEach(el => el.classList.toggle('active', el.dataset.quickNotebook === nb));
      return;
    }
    const nbColorBtn = target.closest('[data-nb-color]');
    if (nbColorBtn) {
      renderNotebookColorSwatches(nbColorBtn.dataset.nbColor);
      return;
    }
    const editNbBtn = target.closest('[data-edit-notebook]');
    if (editNbBtn) {
      await openNotebookDialog(editNbBtn.dataset.editNotebook);
      return;
    }
    const delNbBtn = target.closest('[data-delete-notebook]');
    if (delNbBtn) {
      await deleteNotebook(delNbBtn.dataset.deleteNotebook);
      return;
    }
    const bag = target.closest('[data-bag-filter]');
    if (bag) {
      const raw = bag.dataset.bagFilter;
      const targetBag = raw === 'all' ? null : Number(raw);
      activeBagFilter = targetBag == null ? null : (activeBagFilter === targetBag ? null : targetBag);
      if (view !== 'library' && view !== 'today') view = 'today';
      await render(); if (view === 'library') filterLibrary();
      return;
    }
    const libLayout = target.closest('[data-lib-layout]'); if (libLayout) { libraryFilter.layout = libLayout.dataset.libLayout; $$('[data-lib-layout]').forEach(btn => btn.classList.toggle('active', btn.dataset.libLayout === libraryFilter.layout)); $('#libraryList')?.classList.toggle('grid-mode', libraryFilter.layout === 'grid'); return; }
    const toggleCard = target.closest('[data-toggle-card]');
    if (toggleCard) {
      const id = toggleCard.dataset.toggleCard;
      const row = toggleCard.closest('.library-row');
      const drawer = row?.querySelector('.library-outline-drawer');
      const caret = row?.querySelector('.expand-caret');
      const titleBtn = row?.querySelector('.library-title-btn');
      if (expandedCardIds.has(id)) { expandedCardIds.delete(id); row?.classList.remove('expanded'); drawer?.classList.add('hidden'); caret?.classList.remove('open'); titleBtn?.setAttribute?.('aria-expanded', 'false'); }
      else { expandedCardIds.add(id); row?.classList.add('expanded'); drawer?.classList.remove('hidden'); caret?.classList.add('open'); titleBtn?.setAttribute?.('aria-expanded', 'true'); }
      return;
    }
    const quickTag = target.closest('[data-quick-tag]'); if (quickTag) { const t = quickTag.dataset.quickTag; const input = $('#cardTags'); const current = input.value.split(',').map(s => s.trim()).filter(Boolean); if (current.includes(t)) input.value = current.filter(x => x !== t).join(', '); else input.value = [...current, t].join(', '); return; }
    if (target.closest('#toggleOutlinePreview')) { const preview = $('#cardOutlinePreview'); const btn = $('#toggleOutlinePreview'); const hidden = preview.classList.toggle('hidden'); if (!hidden) preview.innerHTML = `<div class="recall-label">大纲预览（点击挖空块可测试显隐）</div><div class="markdown-body">${markdownToHtml($('#cardOutline').value)}</div>`; btn.textContent = hidden ? '预览效果' : '收起预览'; return; }
    if (target.closest('#editInReviewButton')) { const cur = reviewQueue[reviewIndex]; if (cur) await openCardDialog(await db.get(cur._id)); return; }
    const batchChk = target.closest('[data-batch-select]'); if (batchChk) { const id = batchChk.dataset.batchSelect; if (selectedCardIds.has(id)) selectedCardIds.delete(id); else selectedCardIds.add(id); await render(); filterLibrary(); return; }
    const add = target.closest('#addCardButton,[data-action="add"]'); if (add) { await openCardDialog(); return; }
    const randomBtn = target.closest('#randomCardButton,[data-action="random-draw"],[data-action="random-draw-library"]'); if (randomBtn) { await beginRandomReview(); return; }
    if (target.closest('#rerollRandomCard')) { await rerollRandomCard(); return; }
    if (target.closest('#saveAndFinishRandom')) { finishAfterSave = true; await saveReview({ preventDefault() { } }); return; }
    const close = target.closest('[data-close-dialog]'); if (close) { close.closest('dialog').close(); return; }

    /* 复习弹窗三步按钮 */
    if (target.closest('#revealOutline')) { goToStepTwo(null); return; }
    if (target.closest('#cantRecall')) { goToStepTwo(10); return; }
    if (target.closest('#backToRecall')) { setReviewStep(1); return; }
    if (target.closest('#startFeedbackRecall')) { beginFeedbackRecall(); return; }
    if (target.closest('#finishFeedbackRecall')) { finishFeedbackRecall(); return; }
    if (target.closest('#cancelFeedbackRecall')) { cancelFeedbackRecall(); return; }
    if (target.closest('#goToScore')) { goToStepThree(); return; }
    if (target.closest('#skipCard')) { await skipCurrentCard(); return; }
    if (target.closest('#clearRecall')) { $('#reviewForm').elements.recall.value = ''; updateKeyTermCheck(); return; }

    /* 每日上限就地选择 */
    if (target.closest('[data-action="open-limit"]')) { toggleLimitPopover(); return; }
    const limitOption = target.closest('[data-limit-value]');
    if (limitOption) {
      const value = Number(limitOption.dataset.limitValue);
      const settings = await getSetting();
      await saveSetting({ ...(settings || {}), daily_review_limit: value });
      $('.limit-popover')?.remove();
      showToast(value ? `每日复习上限已改为 ${value} 张` : '每日复习上限已取消');
      await render();
      return;
    }

    const review = target.closest('[data-review-card]'); if (review) { const card = await db.get(review.dataset.reviewCard); await beginReview([card]); return; }
    const cardHistory = target.closest('[data-card-history]'); if (cardHistory) { activeHistoryCardFilter = cardHistory.dataset.cardHistory; view = 'history'; await render(); return; }
    const action = target.closest('[data-action]')?.dataset.action;
    if (action === 'reload') { location.reload(); return; }
    if (action === 'install-pwa') { await installPwaApp(); return; }
    if (action === 'refresh-pwa-cache') { await refreshPwaOfflineCache(); return; }
    if (action === 'open-notebook-dialog') { await openNotebookDialog(); return; }
    if (action === 'run-batch-import') { await batchCreateFromMarkdown(); return; }
    if (action === 'toggle-batch-mode') { batchMode = !batchMode; if (!batchMode) selectedCardIds.clear(); await render(); filterLibrary(); return; }
    if (action === 'batch-select-all') {
      const visibleIds = $$('.library-row[data-card-row]').filter(r => !r.hidden).map(r => r.dataset.cardRow);
      const allSel = visibleIds.length > 0 && visibleIds.every(id => selectedCardIds.has(id));
      visibleIds.forEach(id => { if (allSel) selectedCardIds.delete(id); else selectedCardIds.add(id); });
      await render(); filterLibrary(); return;
    }
    if (action === 'batch-move-notebook') {
      if (!selectedCardIds.size) return;
      const targetNb = Domain.normalizeNotebook($('#batchNotebookSelect')?.value || Domain.DEFAULT_NOTEBOOK);
      for (const id of selectedCardIds) {
        const c = await db.get(id).catch(() => null);
        if (c) await db.put({ ...c, notebook: targetNb, updated_at: new Date().toISOString() });
      }
      showToast(`已将 ${selectedCardIds.size} 张卡片移入「${targetNb}」`);
      selectedCardIds.clear(); batchMode = false; await render(); return;
    }
    if (action === 'batch-review') {
      if (!selectedCardIds.size) return;
      const cards = (await getCards()).filter(c => selectedCardIds.has(c._id));
      batchMode = false; selectedCardIds.clear();
      await render(); await beginReview(cards); return;
    }
    if (action === 'batch-due-today') {
      if (!selectedCardIds.size) return;
      const today = localDay();
      for (const id of selectedCardIds) { const c = await db.get(id).catch(() => null); if (c) await db.put({ ...c, due_date: today, updated_at: new Date().toISOString() }); }
      showToast(`已将 ${selectedCardIds.size} 张卡片设为今日到期`);
      selectedCardIds.clear(); batchMode = false; await render(); return;
    }
    if (action === 'batch-archive') {
      if (!selectedCardIds.size) return;
      const yes = await askConfirm('批量归档卡片', `确定将选中的 ${selectedCardIds.size} 张卡片移入归档区？`, '批量归档');
      if (yes) {
        const count = selectedCardIds.size;
        for (const id of selectedCardIds) await archiveCard(id);
        selectedCardIds.clear(); batchMode = false; await render(); showToast(`已批量归档 ${count} 张卡片`);
      }
      return;
    }
    if (action === 'toggle-lib-filters') {
      uiFolds.libraryFilters = !uiFolds.libraryFilters;
      const drawer = $('#libraryFilterDrawer');
      if (drawer) drawer.classList.toggle('hidden', !uiFolds.libraryFilters);
      target.closest('.filter-drawer-toggle')?.classList.toggle('active', uiFolds.libraryFilters);
      return;
    }
    if (action === 'goto-library') { view = 'library'; activeBagFilter = null; activeHistoryCardFilter = null; await render(); return; }
    if (action === 'goto-today') { view = 'today'; activeBagFilter = null; activeHistoryCardFilter = null; await render(); return; }
    if (action === 'seed-demo') { await seedDemoCards(); return; }
    if (action === 'fill-feynman-scaffold') {
      const recallEl = $('#reviewForm')?.elements?.recall;
      if (recallEl) {
        recallEl.value = `1. 它解决什么问题？\n2. 关键机制、条件和因果关系是什么？\n3. 举一个新例子或反例：`;
        recallEl.focus();
      }
      return;
    }
    if (action === 'balance-overdue') { await balanceOverdueNow(); return; }
    if (action === 'fill-missed-note') {
      const card = reviewQueue[reviewIndex];
      const res = Domain.checkKeyTermHits(card?.outline || '', $('#reviewForm')?.elements?.recall?.value || '');
      if (res.missed.length) {
        const noteEl = $('#reviewNote');
        const prefix = noteEl.value.trim() ? `${noteEl.value.trim()}；` : '';
        noteEl.value = `${prefix}漏记关键词：${res.missed.join('、')}`;
        showToast('已将漏词填入备注');
      }
      return;
    }
    if (action === 'clear-filter') { activeBagFilter = null; await render(); }
    if (action === 'clear-filters') { libraryFilter = { ...libraryFilter, query: '', tag: 'all', status: 'all', sort: 'due' }; activeBagFilter = null; await render(); return; }
    if (action === 'clear-history-filter') { activeHistoryCardFilter = null; await render(); }
    if (action === 'start-today') {
      const list = await dueCards().then(l => activeBagFilter == null ? l : l.filter(card => bagFor(card) === activeBagFilter));
      /* 队列完整参与复习（计划 §4.2 不丢失原则）；每日上限改为「先做前 N 张」的软建议，不再截断 */
      const settings = (await getSetting()) || {};
      const dailyLimit = Number(settings.daily_review_limit ?? 25);
      await beginReview(dailyLimit > 0 && list.length > dailyLimit ? list.slice(0, dailyLimit) : list);
      return;
    }
    if (action === 'start-today-all') {
      const list = await dueCards().then(l => activeBagFilter == null ? l : l.filter(card => bagFor(card) === activeBagFilter));
      await beginReview(list);
      return;
    }
    if (action === 'start-mixed') { await beginMixedReview(); return; }
    if (action === 'snooze') await snoozeDue();
    if (action === 'export') await exportData();
    if (action === 'import') $('#importFile').click();
    if (action === 'test-couch') await connectCouch(true);
    if (action === 'connect-couch') await connectCouch(false);
    if (action === 'disconnect-couch') await disconnectCouch();
    if (action === 'forget-couch') await forgetSavedCouch();
    if (action === 'save-intervals') {
      const daysInput = $('#intervalDays');
      const fallback = daysInput ? [] : ((await getSetting())?.interval_days || INTERVALS);
      const values = daysInput ? daysInput.value.split(',').map(value => value.trim()).filter(Boolean).map(Number) : fallback;
      const valid = values.length > 0 && values[0] === 1 && values.every((value, index) => Number.isInteger(value) && value > 0 && value <= 365 && (index === 0 || value > values[index - 1]));
      if (!valid) { showToast('周期需从 1 天开始，之后使用严格递增的 1–365 天整数'); return; }
      const passThreshold = Number($('#passThresholdSelect')?.value ?? 40);
      const defaultLowAction = $('#lowActionSelect')?.value || 'hold';
      const adaptiveLeap = $('#adaptiveLeapCheck') ? Boolean($('#adaptiveLeapCheck').checked) : false;
      const dailyLimit = Number($('#dailyLimitSelect')?.value ?? 25);
      const studyMethod = $('#defaultStudyMethodSelect')?.value || 'blurting';
      activeStudyMethod = studyMethod;
      const settings = await getSetting();
      await saveSetting({
        ...settings,
        interval_days: values,
        hold_interval_below_score: passThreshold,
        default_low_action: defaultLowAction,
        adaptive_leap: adaptiveLeap,
        daily_review_limit: dailyLimit,
        study_method: studyMethod
      });
      showToast('基础调度规则与学习方法设定已保存');
      await render();
    }
    const edit = target.closest('[data-edit]'); if (edit) { closeAllRowMenus(); await openCardDialog(await db.get(edit.dataset.edit)); }
    const archive = target.closest('[data-archive]'); if (archive) { closeAllRowMenus(); const yes = await askConfirm('归档卡片', '归档后卡片会从复习池移出，可在卡片库底部恢复。', '归档'); if (yes) { await archiveCard(archive.dataset.archive); await render(); showToast('卡片已归档'); } }
    const restore = target.closest('[data-restore]'); if (restore) { await archiveCard(restore.dataset.restore, true); await render(); showToast('卡片已恢复'); }
    const del = target.closest('[data-delete]'); if (del) { closeAllRowMenus(); const yes = await askConfirm('彻底删除卡片', '删除后卡片及其所有复习历史记录将被永久移除，确定继续？', '彻底删除'); if (yes) { await deleteCard(del.dataset.delete); await render(); showToast('卡片已删除'); } }
    const preset = target.closest('[data-score-preset]'); if (preset) { const i = Number(preset.dataset.scorePreset); selectScore(SCORE_PRESETS[i], i); }
  } catch (err) { console.error(err); showToast(`操作出错：${err.message || err}`); }
});

/* 卡片编辑、笔记本管理与复习弹窗内的表单提交 */
$('#cardForm')?.addEventListener('submit', saveCardFromDialog);
$('#notebookForm')?.addEventListener('submit', saveNotebookFromDialog);
$('#reviewForm').addEventListener('submit', saveReview);
$('#reviewForm').addEventListener('input', event => { if (event.target.name === 'recall' && reviewStep >= 2) updateKeyTermCheck(); });
$('#scoreRange').addEventListener('input', event => selectScore(Number(event.target.value), null));
$('#reviewDialog').addEventListener('change', event => {
  /* 用户手动选择低分策略后写入显式状态，避免沿用上一张卡的选择 */
  if (event.target.name === 'lowCycle') { lowCycleChoice = event.target.value; updateSchedulePreview(); return; }
  if (event.target.name === 'keepRandomDue') updateSchedulePreview();
});
$('#reviewDialog').addEventListener('close', () => { clearInterval(reviewTimerInterval); if (pendingDayRefresh) { pendingDayRefresh = false; render(); } });
$('#viewRoot').addEventListener('toggle', event => { const key = event.target?.dataset?.foldKey; if (key) uiFolds[key] = Boolean(event.target.open); }, true);
$('#viewRoot').addEventListener('input', event => { if (['cardSearch', 'tagFilter', 'statusFilter', 'sortFilter'].includes(event.target.id)) filterLibrary(); });
$('#viewRoot').addEventListener('change', async event => {
  if (event.target.id === 'importFile') { const file = event.target.files?.[0]; if (file) await importData(file); event.target.value = ''; return; }
  if (['tagFilter', 'statusFilter', 'sortFilter'].includes(event.target.id)) filterLibrary();
});

/* 移动端长按标题 500ms 进入批量多选 */
$('#viewRoot').addEventListener('pointerdown', event => {
  const title = event.target instanceof Element ? event.target.closest('.library-row-title') : null;
  if (!title || batchMode) return;
  clearTimeout(longPressTimer);
  longPressTimer = setTimeout(async () => {
    const row = title.closest('.library-row');
    const id = row?.dataset.cardRow;
    if (!id) return;
    batchMode = true;
    if (!selectedCardIds.has(id)) selectedCardIds.add(id);
    await render(); filterLibrary();
    showToast('已进入批量模式，点选卡片后可集中复习或归档');
  }, 500);
});
$('#viewRoot').addEventListener('pointerup', () => clearTimeout(longPressTimer));
$('#viewRoot').addEventListener('pointercancel', () => clearTimeout(longPressTimer));

function filterLibrary() {
  const query = ($('#cardSearch')?.value || '').toLowerCase().trim();
  const bag = activeBagFilter == null ? 'all' : String(activeBagFilter);
  const tag = $('#tagFilter')?.value ?? 'all';
  const status = $('#statusFilter')?.value ?? 'all';
  const sort = $('#sortFilter')?.value ?? (libraryFilter.sort || 'due');
  libraryFilter = { ...libraryFilter, query: $('#cardSearch')?.value || '', tag, status, sort };
  const listEl = $('#libraryList');
  const rows = $$('.library-row[data-card-row]');
  let visible = 0;
  for (const row of rows) {
    const searchSource = row.dataset.search || row.textContent.toLowerCase();
    const rowTags = row.dataset.tags ? row.dataset.tags.split('|') : [];
    const matches = (!query || searchSource.includes(query)) && (bag === 'all' || row.dataset.bag === bag) && (tag === 'all' || rowTags.includes(tag)) && (status === 'all' || (status === 'due' ? row.dataset.due <= localDay() : row.dataset.due > localDay()));
    row.hidden = !matches;
    if (matches) visible++;
  }
  /* 第 1 层常驻：结果计数 + 清除筛选；无匹配时给出可执行的空状态（§10.6 / §10.10） */
  const counter = $('#libraryResultCount');
  if (counter) counter.textContent = `${visible} 张`;
  const hasFilter = Boolean(query) || bag !== 'all' || tag !== 'all' || status !== 'all' || sort !== 'due';
  const drawerFilterCount = (tag !== 'all' ? 1 : 0) + (status !== 'all' ? 1 : 0) + (sort !== 'due' ? 1 : 0);
  const filterPill = $('#libraryFilterCountPill');
  if (filterPill) {
    filterPill.textContent = drawerFilterCount ? String(drawerFilterCount) : '';
    filterPill.classList.toggle('hidden', !drawerFilterCount);
  }
  const clearBtn = $('#libraryClearFilters');
  if (clearBtn) clearBtn.classList.toggle('hidden', !hasFilter);
  const emptyEl = $('#libraryEmptyResult');
  if (emptyEl) {
    const noHit = visible === 0 && rows.length > 0;
    emptyEl.classList.toggle('hidden', !noHit);
    if (noHit) {
      const parts = [];
      if (bag !== 'all') parts.push(`等级：${BAG_ORDER[Number(bag) + 1]?.name || '—'}`);
      if (tag !== 'all') parts.push(`标签：${tag}`);
      if (status !== 'all') parts.push(status === 'due' ? '日期：今日到期' : '日期：未到期');
      if (query) parts.push(`关键词：${query}`);
      emptyEl.innerHTML = `没有符合条件的卡片。清除筛选（${parts.map(escapeHtml).join(' · ')}）后可看到全部 <strong>${rows.length}</strong> 张。`;
    }
  }
  if (listEl && rows.length > 1) {
    const sorted = [...rows].sort((a, b) => {
      if (sort === 'score') return Number(a.dataset.score ?? -1) - Number(b.dataset.score ?? -1) || String(a.dataset.due).localeCompare(String(b.dataset.due));
      if (sort === 'created') return String(b.dataset.created).localeCompare(String(a.dataset.created));
      if (sort === 'title') return String(a.dataset.title).localeCompare(String(b.dataset.title), 'zh-CN');
      return String(a.dataset.due).localeCompare(String(b.dataset.due)) || Number(a.dataset.score ?? -1) - Number(b.dataset.score ?? -1);
    });
    sorted.forEach(r => listEl.appendChild(r));
  }
}

/* ===================== 键盘流 ===================== */
const isTypingTarget = target => Boolean(target && target.matches && target.matches('input, textarea, select, [contenteditable="true"]'));

document.addEventListener('keydown', async event => {
  if (event.isComposing) return;
  const cardDialog = $('#cardDialog');
  const typing = isTypingTarget(event.target);

  if (cardDialog.open) {
    if (event.target.id === 'cardOutline') {
      if (event.key === 'Tab') {
        event.preventDefault();
        const ta = event.target;
        const start = ta.selectionStart ?? 0;
        if (event.shiftKey) {
          const lineStart = ta.value.lastIndexOf('\n', start - 1) + 1;
          if (ta.value.slice(lineStart, lineStart + 2) === '  ') {
            ta.value = ta.value.slice(0, lineStart) + ta.value.slice(lineStart + 2);
            ta.selectionStart = ta.selectionEnd = Math.max(lineStart, start - 2);
          }
        } else {
          ta.value = ta.value.slice(0, start) + '  ' + ta.value.slice(ta.selectionEnd ?? start);
          ta.selectionStart = ta.selectionEnd = start + 2;
        }
        return;
      }
      if ((event.ctrlKey || event.metaKey) && (event.key === 'b' || event.key === 'B')) { event.preventDefault(); insertMarkdownFormat('bold'); return; }
      if ((event.ctrlKey || event.metaKey) && (event.key === 'm' || event.key === 'M')) { event.preventDefault(); insertMarkdownFormat('cloze'); return; }
    }
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); $('#cardForm').requestSubmit(); return; }
    if (event.key === 'Enter' && !typing && event.target.tagName !== 'BUTTON') { event.preventDefault(); return; }
    return;
  }

  const dialog = $('#reviewDialog');
  if (dialog.open) {
    /* 裸 Enter 不提交（只保留 Ctrl/⌘+Enter），避免与按钮激活双触发 */
    if (event.key === 'Enter' && !event.ctrlKey && !event.metaKey && event.target.tagName !== 'BUTTON') { event.preventDefault(); return; }
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      if (reviewStep === 1) { goToStepTwo(null); return; }
      if (reviewStep === 2) { goToStepThree(); return; }
      if (!$('#saveReview').disabled) { $('#reviewForm').requestSubmit(); }
      return;
    }
    if (typing) return;

    if (event.code === 'Space') {
      event.preventDefault();
      if (event.shiftKey) { if (reviewStep > 1) setReviewStep(reviewStep - 1); return; }
      if (reviewStep === 1) goToStepTwo(null);
      else if (reviewStep === 2) goToStepThree();
      return;
    }
    if (/^[1-5]$/.test(event.key) && reviewStep === 3) {
      const index = Number(event.key) - 1;
      selectScore(SCORE_PRESETS[index], index);
      return;
    }
    if ((event.key === 'ArrowLeft' || event.key === 'ArrowRight') && reviewStep === 3) {
      event.preventDefault();
      const delta = event.key === 'ArrowRight' ? 5 : -5;
      const next = Math.max(0, Math.min(100, (selectedScore == null ? 50 : selectedScore) + delta));
      selectScore(next, null);
      return;
    }
    if ((event.key === 'f' || event.key === 'F')) { event.preventDefault(); $('#toggleAllCloze')?.click(); return; }
    if ((event.key === 'm' || event.key === 'M')) { event.preventDefault(); cycleStudyMethod(); return; }
    if ((event.key === 'e' || event.key === 'E')) { event.preventDefault(); const cur = reviewQueue[reviewIndex]; if (cur) await openCardDialog(await db.get(cur._id)); return; }
    if ((event.key === 'u' || event.key === 'U')) { event.preventDefault(); await undoLastReview(); return; }
    if ((event.key === 'r' || event.key === 'R') && reviewMode === 'random' && !$('#rerollRandomCard')?.classList.contains('hidden')) { event.preventDefault(); rerollRandomCard(); return; }
    if (event.key === 'Escape') { event.preventDefault(); dialog.close(); return; }
    return;
  }

  /* 弹窗之外：Esc 退出批量 / 收起抽屉 */
  if (event.key === 'Escape') {
    if (batchMode) { batchMode = false; selectedCardIds.clear(); render(); return; }
    if (uiFolds.libraryFilters) { uiFolds.libraryFilters = false; const drawer = $('#libraryFilterDrawer'); drawer?.classList.add('hidden'); return; }
  }

  if ($('#confirmDialog').open || $('#helpDialog')?.open || $('#notebookDialog')?.open) return;

  /* Alt+1..4 切换视图 */
  if (event.altKey && /^[1-4]$/.test(event.key)) {
    event.preventDefault();
    const target = { '1': 'today', '2': 'library', '3': 'history', '4': 'settings' }[event.key];
    view = target; activeBagFilter = null; activeHistoryCardFilter = null; render();
    return;
  }
  /* 搜索框内 Enter：跳到第一条结果 */
  if (event.target.id === 'cardSearch' && event.key === 'Enter') {
    event.preventDefault();
    const first = $$('.library-row[data-card-row]').find(row => !row.hidden);
    first?.querySelector('.library-title-btn')?.focus();
    return;
  }
  if (typing || event.ctrlKey || event.metaKey || event.altKey) return;

  if (event.key === 'n') { event.preventDefault(); openCardDialog(); return; }
  if (event.key === 'r') { event.preventDefault(); beginRandomReview(); return; }
  if (event.key === '?') { event.preventDefault(); $('#helpDialog')?.showModal(); return; }
  if (event.key === 'g' || event.key === '/') {
    event.preventDefault();
    if (view !== 'library') { view = 'library'; activeBagFilter = null; activeHistoryCardFilter = null; await render(); }
    $('#cardSearch')?.focus();
    return;
  }
});

/* 学习法轮换（M 键） */
function cycleStudyMethod() {
  const keys = Object.keys(Domain.STUDY_METHODS || {});
  if (!keys.length) return;
  const index = keys.indexOf(activeStudyMethod);
  const next = keys[(index + 1) % keys.length];
  applyStudyMethodUI(next, reviewQueue[reviewIndex]);
  getSetting().then(s => { if (s) saveSetting({ ...s, study_method: next }); });
}

async function balanceOverdueNow() {
  const due = await dueCards();
  const settings = (await getSetting()) || {};
  const cap = Number(settings.daily_review_limit || 15) || 15;
  if (due.length <= cap) {
    showToast(`当前待复习 ${due.length} 张，未超过单日上限（${cap} 张），无需分流`);
    return;
  }
  const plan = Domain.balanceOverdueCards(due, localDay(), cap);
  if (!plan.length) return;
  for (const item of plan) {
    const doc = await db.get(item.id).catch(() => null);
    if (doc) await db.put({ ...doc, due_date: item.due_date, updated_at: new Date().toISOString() });
  }
  showToast(`已将超额的 ${plan.length} 张卡片平滑分流至未来数日`);
  await render();
}

async function seedDemoCards() {
  const today = localDay();
  const demos = [
    {
      title: '光合作用的两个阶段与核心场所',
      outline: '### 1. 光反应阶段\n- 场所：叶绿体 **类囊体薄膜**\n- 物质变化：水的光解产生 ==O2== 与 NADPH；合成 ==ATP==\n### 2. 暗反应阶段（卡尔文循环）\n- 场所：**叶绿体基质**\n- 过程：CO2 的固定 → ==C3的还原==（消耗 ATP 和 NADPH）',
      notebook: '生物',
      tags: ['生物', '示例卡片'],
      due_date: today,
      interval_index: 1,
      latest_memory_score: 35
    },
    {
      title: 'TCP 三次握手与四次挥手核心要点',
      outline: '### 三次握手（建立连接）\n- 第一次：客户端发送 **SYN=1**, seq=x\n- 第二次：服务端回复 ==SYN=1, ACK=1==, ack=x+1\n- 第三次：客户端发送 **ACK=1**, 进入 ==ESTABLISHED== 状态\n### 为什么需要三次而非两次？\n- 防止已失效的连接请求报文段突然又传送到了服务端，产生错误连接',
      notebook: '计算机网络',
      tags: ['计算机网络', '示例卡片'],
      due_date: today,
      interval_index: 0,
      latest_memory_score: null
    },
    {
      title: '间隔复习与主动回忆',
      outline: '- 核心理念：**先回忆（Active Recall）**，再看答案核对\n- 6 级记忆梯度：待首次复习 / 待加强 / 较弱 / 一般 / 较好 / 熟悉\n- 低于 ==40%== 时默认保持当前复习周期，避免盲目拉长间隔',
      notebook: '学习方法',
      tags: ['学习方法', '示例卡片'],
      due_date: addDays(today, 2),
      interval_index: 2,
      latest_memory_score: 75
    }
  ];
  const settings = (await getSetting()) || {};
  const savedNbs = Array.isArray(settings.notebooks) ? [...settings.notebooks] : [];
  for (const item of demos) {
    if (!savedNbs.some(n => (typeof n === 'string' ? n : n?.name) === item.notebook)) {
      savedNbs.push({ name: item.notebook, color: Domain.NOTEBOOK_COLORS[savedNbs.length % Domain.NOTEBOOK_COLORS.length] });
    }
    const doc = {
      _id: `card:${uuid()}`,
      type: 'card',
      title: item.title,
      outline: item.outline,
      notebook: item.notebook,
      tags: item.tags,
      created_at: new Date().toISOString(),
      archived_at: null,
      interval_index: item.interval_index,
      due_date: item.due_date,
      last_reviewed_at: null,
      latest_memory_score: item.latest_memory_score
    };
    await db.put(doc);
  }
  await saveSetting({ ...settings, notebooks: savedNbs });
  showToast('已载入 3 个科目笔记本与示例卡片，可立即体验科目切换与复习');
  await render();
}

/* 兜底：自定义阶梯折叠时仍能保存当前曲线 */
window.addEventListener('storage', event => { if (event.key === LOCAL_KEY && !pouchMode) render(); });
window.addEventListener('beforeinstallprompt', event => {
  event.preventDefault?.();
  deferredInstallPrompt = event;
  updateInstallControls();
  if (view === 'settings') render();
});
window.addEventListener('appinstalled', () => {
  deferredInstallPrompt = null;
  updateInstallControls();
  showToast('StudyStyle 已安装，可从桌面或主屏幕直接启动');
  if (view === 'settings') render();
});
window.addEventListener('online', async () => {
  showToast('网络已恢复，正在同步服务端数据');
  await hydrateFromServerStore();
  flushServerStore();
  void resumeSavedCouchSync();
  await render();
});
window.addEventListener('offline', () => {
  showToast('当前处于离线模式，复习与编辑操作已暂存本地');
});
window.addEventListener('resize', () => { if (activeRowMenuCardId) closeAllRowMenus(); });
window.addEventListener('scroll', () => { if (activeRowMenuCardId) closeAllRowMenus(); }, { passive: true });
document.addEventListener('keydown', event => { if (event.key === 'Escape' && activeRowMenuCardId) closeAllRowMenus(); });
/* 页面隐藏/关闭前立即冲刷待推送数据，避免防抖窗口内关页导致本次改动未同步 */
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushServerStore(); });
window.addEventListener('beforeunload', () => flushServerStore());
setInterval(() => { const currentDay = localDay(); if (currentDay === observedDay) return; observedDay = currentDay; if ($('#reviewDialog').open) pendingDayRefresh = true; else render(); }, 60000);
initStore().catch(error => { console.error(error); $('#viewRoot').innerHTML = `<div class="empty-state"><div class="empty-symbol">${icon('warning', 'icon icon-24')}</div><h3>应用启动失败</h3><p>${escapeHtml(error.message || '未知错误')}</p><div class="empty-actions"><button class="button button-primary" data-action="reload">重新加载</button></div></div>`; });
