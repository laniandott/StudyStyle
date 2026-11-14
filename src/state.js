/* StudyStyle 模块：src/state.js */

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
const STORE_LOCAL_TOKEN_KEY = 'studystyle-store-token-v1';
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const uuid = () => crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
const localDay = (date = new Date()) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
const addDays = (day, amount) => Domain.addLocalDays(day, amount);
const fmtDate = (day, opts = { month: 'short', day: 'numeric' }) => {
  if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(String(day))) return '未安排';
  const date = new Date(`${day}T12:00:00`);
  return Number.isFinite(date.getTime()) ? date.toLocaleDateString('zh-CN', opts) : '未安排';
};
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const schedulerModeFor = settings => (settings?.scheduler_mode === 'ladder' ? 'ladder' : 'adaptive');
const passThresholdFor = settings => Number(settings?.hold_interval_below_score ?? (schedulerModeFor(settings) === 'adaptive' ? 60 : 40));
const intervalFor = (card, intervals = INTERVALS, settings = null) => (
  Domain.computeCardInterval
    ? Domain.computeCardInterval(card, intervals, schedulerModeFor(settings))
    : Domain.intervalDays(card.interval_index, intervals)
);
function computeReviewSchedule(card, score, mode, reviewedDay, intervals, settings) {
  const passThreshold = passThresholdFor(settings);
  const adaptiveLeap = settings?.adaptive_leap === true;
  if (schedulerModeFor(settings) === 'adaptive' && Domain.nextAdaptiveSchedule) {
    const fuzzSeed = card?._id ? `${card._id}:${card.reps || 0}` : undefined;
    return Domain.nextAdaptiveSchedule(card || {}, score, mode, reviewedDay, intervals, { passThreshold, adaptiveLeap, fuzzSeed });
  }
  return Domain.nextSchedule(card?.interval_index, score, mode, reviewedDay, intervals, { passThreshold, adaptiveLeap });
}
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
let historyVisibleLimit = 120;
let libraryFilter = { query: '', tag: 'all', status: 'all', sort: 'due', layout: 'list' };
let uiFolds = { todayInsights: false, libraryFilters: false, libraryArchived: false, couchSettings: false, batchImporter: false, customLadder: false, importJson: false, pwaInfo: false };
let expandedCardIds = new Set();
let batchMode = false;
let selectedCardIds = new Set();
let activeRowMenuCardId = null;
let deferredInstallPrompt = null;
let swRegistration = null;
let couchStatusState = { text: '', variant: '' };
let couchSyncPhase = 'idle';
let couchProxyState = { checked: false, enabled: false, db: 'studystyle' };
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
/* 本轮同会话错题回炉：低于及格线时可选保存后追加到本轮队列末尾再抽查 */
let requeueSameSession = false;
let toastTimer;
let observedDay = localDay();
let pendingDayRefresh = false;
let longPressTimer = null;

function markdownToHtml(markdown) {
  let html = escapeHtml(markdown)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/==([^=]+)==/g, (match, word) => {
      const plainLabel = word.replace(/<[^>]+>/g, '');
      return `<button type="button" class="cloze-mask" aria-expanded="false" aria-label="挖空：${plainLabel}，点击显示答案" title="点击显示答案">${word}</button>`;
    });
  const lines = html.split(/\r?\n/); let out = ''; let listTag = '';
  for (const raw of lines) {
    const headingMatch = raw.match(/^(#{1,4})\s+(.*)$/);
    const orderedMatch = raw.match(/^(\s*)\d+\.\s+(.*)$/);
    const bulletMatch = orderedMatch ? null : raw.match(/^(\s*)[-*+]\s+(.*)$/);
    const listMatch = orderedMatch || bulletMatch;
    if (headingMatch) {
      if (listTag) { out += `</${listTag}>`; listTag = ''; }
      out += `<h4 class="md-heading">${headingMatch[2]}</h4>`;
    } else if (listMatch) {
      const nextTag = orderedMatch ? 'ol' : 'ul';
      if (listTag && listTag !== nextTag) { out += `</${listTag}>`; listTag = ''; }
      if (!listTag) { out += `<${nextTag}>`; listTag = nextTag; }
      const indentStep = Math.min(8, Math.floor(listMatch[1].replace(/\t/g, '  ').length / 2));
      out += `<li${indentStep ? ` class="md-indent-${indentStep}"` : ''}>${listMatch[2]}</li>`;
    } else {
      if (listTag) { out += `</${listTag}>`; listTag = ''; }
      if (raw.trim()) out += `<p>${raw}</p>`;
    }
  }
  if (listTag) out += `</${listTag}>`;
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
function fmtDue(card) {
  if (!card?.due_date || !/^\d{4}-\d{2}-\d{2}$/.test(String(card.due_date))) return '<span class="due-label">未安排</span>';
  const today = localDay();
  const diff = Math.round((new Date(`${today}T12:00:00`) - new Date(`${card.due_date}T12:00:00`)) / 86400000);
  if (!Number.isFinite(diff)) return '<span class="due-label">未安排</span>';
  if (diff > 0) return `<span class="due-label overdue">逾期 ${diff} 天</span>`;
  return `<span class="due-label">${card.due_date === today ? '今天到期' : fmtDate(card.due_date)}</span>`;
}
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
