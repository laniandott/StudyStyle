(function (root, factory) {
  const domain = factory();
  if (typeof module === 'object' && module.exports) module.exports = domain;
  if (root) root.StudyStyleDomain = domain;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  const DEFAULT_INTERVALS = [1, 3, 7, 14, 30, 60];

  const INTERVAL_PRESETS = {
    ebbinghaus: { key: 'ebbinghaus', name: '短期强化', days: [1, 2, 4, 7, 15, 30], desc: '较密集的前期安排（1/2/4/7/15/30天），适合短期集中复习；按实际表现调整' },
    balanced: { key: 'balanced', name: '均衡长周期', days: [1, 3, 7, 14, 30, 60], desc: '中长间隔起点（1/3/7/14/30/60天），根据答案表现和目标保持时长调整' },
    cram: { key: 'cram', name: '考前高频冲刺', days: [1, 2, 3, 5, 8, 14], desc: '压缩长周期（最高14天），适合考前 1–2 周高频滚动突击' },
    deep: { key: 'deep', name: '长线深度掌握', days: [1, 4, 10, 25, 60, 120], desc: '大跨度递进（最高120天），适合已理解透彻的底层原理与框架' }
  };

  const STUDY_METHODS = {
    blurting: {
      key: 'blurting',
      name: '闭卷主动回忆',
      badge: '主动回忆',
      prompt: '先不看大纲或提示，写下核心结论、关键关系、条件与一个例子。尽量用完整答案说明思路，再展开大纲核对。'
    },
    feynman: {
      key: 'feynman',
      name: '解释机制与举例',
      badge: '机制解释',
      prompt: '合上材料，用自己的话说明：\n1. 这个概念解决什么问题？\n2. 关键机制、条件和因果关系是什么？\n3. 举一个新例子或反例，说明它何时适用。'
    },
    cornell: {
      key: 'cornell',
      name: '可选线索回忆',
      badge: '线索回忆',
      prompt: '如果自由回忆卡住，可展开少量主干线索，再合上材料逐条回忆关键细节；记录哪些线索仍想不起答案。'
    }
  };

  const NOTE_TEMPLATES = {
    cornell: `- 核心问题 / 线索 1：==关键结论==\n  - 展开细节：**核心机制**\n- 核心问题 / 线索 2：==关键条件==\n  - 展开细节：推导或步骤\n- 一句话总结（Summary）：**本质规律概括**`,
    feynman: `- 一句话直白定义：这个概念本质上是 ==用简单的话概括==\n- 为什么需要它（痛点）：解决 **核心问题**\n- 底层原理拆解：\n  - 第一步：==关键动作==\n  - 第二步：**结果反馈**\n- 具象类比 / 现实例子：就像生活中的…`,
    compare: `- 核心定位对比：**概念A** 侧重 ==特性1==，而 **概念B** 侧重 ==特性2==\n- 共同点：都基于 **底层基础**\n- 关键差异：\n  - 机制差异：==差异点==\n  - 性能/代价：==权衡点==\n- 适用场景选择：当遇到 **场景条件** 时优先选…`
  };

  function scoreToBag(score) {
    if (score == null) return -1;
    const value = Number(score);
    if (!Number.isFinite(value) || value < 0 || value > 100) throw new RangeError('Memory score must be between 0 and 100');
    return Math.min(4, Math.floor(value / 20));
  }

  /* 宽容版：用于读取历史数据。脏分数（越界/NaN/字符串）不应让整个页面崩溃，
     而是归入「待首次复习」并由调用方决定是否提示用户修复。 */
  function scoreToBagSafe(score) {
    if (score == null) return -1;
    const value = Number(score);
    if (!Number.isFinite(value) || value < 0 || value > 100) return -1;
    return Math.min(4, Math.floor(value / 20));
  }

  function pickNewerDoc(localDoc, remoteDoc) {
    if (!localDoc) return remoteDoc;
    if (!remoteDoc) return localDoc;
    if (localDoc._deleted) return localDoc;
    if (remoteDoc._deleted) return remoteDoc;

    const localTime = typeof localDoc.updated_at === 'string' ? localDoc.updated_at : '';
    const remoteTime = typeof remoteDoc.updated_at === 'string' ? remoteDoc.updated_at : '';
    if (!localTime && !remoteTime) return localDoc;
    if (!localTime) return remoteDoc;
    if (!remoteTime) return localDoc;
    return localTime > remoteTime ? localDoc : remoteDoc;
  }

  function reconcileDocSets(localDocs = [], remoteDocs = []) {
    const merged = new Map();
    for (const doc of localDocs) if (doc?._id) merged.set(doc._id, doc);
    let needsPush = false;
    for (const doc of remoteDocs) {
      if (!doc?._id) continue;
      const local = merged.get(doc._id);
      if (!local) { merged.set(doc._id, doc); continue; }
      const winner = pickNewerDoc(local, doc);
      merged.set(doc._id, winner);
      if (winner === local && JSON.stringify(local) !== JSON.stringify(doc)) needsPush = true;
    }
    const docs = [...merged.values()];
    if (docs.length !== remoteDocs.length) needsPush = true;
    return { docs, needsPush };
  }

  function intervalDays(index, intervals = DEFAULT_INTERVALS) {
    const safeIndex = Math.max(0, Math.min(Math.trunc(index || 0), intervals.length - 1));
    return intervals[safeIndex];
  }

  function addLocalDays(day, amount) {
    const date = new Date(`${day}T12:00:00`);
    date.setDate(date.getDate() + amount);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  }

  function nextSchedule(intervalIndex, score, mode, reviewedDay, intervals = DEFAULT_INTERVALS, options = {}) {
    if (!Array.isArray(intervals) || intervals.length === 0 || intervals.some(day => !Number.isInteger(day) || day < 1)) {
      throw new TypeError('Intervals must be a non-empty array of positive whole days');
    }
    scoreToBag(score);
    const passThreshold = Number.isFinite(options?.passThreshold) ? options.passThreshold : 40;
    const adaptiveLeap = Boolean(options?.adaptiveLeap);
    let index = Math.max(0, Math.min(Math.trunc(intervalIndex || 0), intervals.length - 1));
    if (score < passThreshold && mode === 'reset') index = 0;
    else if (score < passThreshold && mode === 'hold') index = Math.max(0, index);
    else {
      const step = adaptiveLeap && score >= 85 ? 2 : 1;
      index = Math.min(index + step, intervals.length - 1);
    }
    const days = intervals[index];
    return { intervalIndex: index, days, dueDate: addLocalDays(reviewedDay, days), bag: scoreToBag(score) };
  }

  function sortDueCards(cards) {
    return [...cards].sort((a, b) => {
      /* 用宽容版取袋：脏分数不应让整个队列排序抛错导致整页白屏 */
      const aBag = scoreToBagSafe(a.latest_memory_score);
      const bBag = scoreToBagSafe(b.latest_memory_score);
      return aBag - bBag || a.due_date.localeCompare(b.due_date) || a.created_at.localeCompare(b.created_at);
    });
  }

  // 按笔记本轮换，保留每个笔记本内部原有的优先级。
  // 这只是队列组织策略，不改变卡片的到期日或评分。
  function interleaveByNotebook(cards, notebookOf = card => normalizeNotebook(card?.notebook)) {
    const groups = new Map();
    for (const card of cards || []) {
      const key = notebookOf(card);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(card);
    }
    const result = [];
    let remaining = true;
    while (remaining) {
      remaining = false;
      for (const group of groups.values()) {
        if (group.length) { result.push(group.shift()); remaining = true; }
      }
    }
    return result;
  }

  function pickRandomCard(cards, excludeId = null, rng = Math.random, weighted = true) {
    if (!Array.isArray(cards) || cards.length === 0) return null;
    const pool = excludeId && cards.length > 1
      ? cards.filter(card => (card._id || card.id) !== excludeId)
      : cards;
    const activePool = pool.length > 0 ? pool : cards;
    if (!weighted) {
      const index = Math.min(activePool.length - 1, Math.max(0, Math.floor(rng() * activePool.length)));
      return activePool[index];
    }
    const weights = activePool.map(card => {
      const bag = scoreToBag(card.latest_memory_score);
      return bag < 0 ? 5 : (5 - bag);
    });
    const totalWeight = weights.reduce((sum, w) => sum + w, 0);
    let threshold = rng() * totalWeight;
    for (let i = 0; i < activePool.length; i++) {
      threshold -= weights[i];
      if (threshold <= 0) return activePool[i];
    }
    return activePool[activePool.length - 1];
  }

  function extractKeyTerms(outline) {
    if (!outline || typeof outline !== 'string') return [];
    const terms = new Set();
    for (const match of outline.matchAll(/\*\*([^*]+)\*\*|==([^=]+)==/g)) {
      const term = (match[1] || match[2] || '').trim();
      if (term) terms.add(term);
    }
    return [...terms];
  }

  function checkKeyTermHits(outline, recallText) {
    const terms = extractKeyTerms(outline);
    const normalized = String(recallText || '').toLowerCase();
    const hits = [];
    const missed = [];
    for (const term of terms) {
      if (normalized && normalized.includes(term.toLowerCase())) hits.push(term);
      else missed.push(term);
    }
    return { total: terms.length, hitCount: hits.length, hits, missed };
  }

  function computeStreak(reviewDayStrings, today) {
    const daySet = new Set(reviewDayStrings || []);
    const activeToday = daySet.has(today);
    let currentStreak = 0;
    let cursor = activeToday ? today : addLocalDays(today, -1);
    while (daySet.has(cursor)) {
      currentStreak++;
      cursor = addLocalDays(cursor, -1);
    }
    const last14Days = Array.from({ length: 14 }, (_, i) => {
      const day = addLocalDays(today, -(13 - i));
      return { day, count: (reviewDayStrings || []).filter(d => d === day).length };
    });
    return { currentStreak, activeToday, last14Days };
  }

  function parseBatchMarkdownCards(rawText, defaultTags = [], defaultNotebook = DEFAULT_NOTEBOOK) {
    const lines = String(rawText || '').split(/\r?\n/);
    const cards = [];
    const nb = normalizeNotebook(defaultNotebook);
    let current = null;
    for (const line of lines) {
      const heading = line.match(/^(#{1,2})\s+(.+)$/);
      if (heading) {
        if (current && current.title && current.outlineLines.length) {
          cards.push({ title: current.title, outline: current.outlineLines.join('\n').trim(), tags: [...defaultTags], notebook: nb });
        }
        current = { title: heading[2].trim(), outlineLines: [] };
      } else if (current) {
        if (line.trim() || current.outlineLines.length) current.outlineLines.push(line);
      }
    }
    if (current && current.title && current.outlineLines.length) {
      cards.push({ title: current.title, outline: current.outlineLines.join('\n').trim(), tags: [...defaultTags], notebook: nb });
    }
    return cards.filter(c => c.title && c.outline);
  }

  const DEFAULT_NOTEBOOK = '默认笔记本';
  const NOTEBOOK_COLORS = ['indigo', 'emerald', 'amber', 'rose', 'sky', 'violet'];

  function normalizeNotebook(name) {
    const trimmed = String(name ?? '').trim();
    return trimmed || DEFAULT_NOTEBOOK;
  }

  function collectNotebooks(cards = [], savedNotebooks = [], today = '') {
    const map = new Map();
    const assignColor = (idx) => NOTEBOOK_COLORS[idx % NOTEBOOK_COLORS.length];

    for (const item of savedNotebooks || []) {
      const name = typeof item === 'string' ? normalizeNotebook(item) : normalizeNotebook(item?.name);
      const color = (typeof item === 'object' && item?.color && NOTEBOOK_COLORS.includes(item.color))
        ? item.color
        : assignColor(map.size);
      if (!map.has(name)) map.set(name, { name, color, total: 0, due: 0 });
    }

    for (const card of cards || []) {
      if (card?.archived_at) continue;
      const name = normalizeNotebook(card?.notebook);
      if (!map.has(name)) {
        map.set(name, { name, color: assignColor(map.size), total: 0, due: 0 });
      }
      const entry = map.get(name);
      entry.total++;
      if (today && card.due_date && card.due_date <= today) entry.due++;
    }

    if (!map.size) {
      map.set(DEFAULT_NOTEBOOK, { name: DEFAULT_NOTEBOOK, color: 'indigo', total: 0, due: 0 });
    }
    return [...map.values()];
  }

  function extractCornellCues(outline) {
    if (!outline || typeof outline !== 'string') return [];
    const lines = outline.split(/\r?\n/);
    const cues = [];
    for (const raw of lines) {
      const topMatch = raw.match(/^(?:[-*]|\d+\.)\s+(.+)$/);
      if (topMatch) {
        const masked = topMatch[1]
          .replace(/==([^=]+)==/g, '[ ___ ]')
          .replace(/\*\*([^*]+)\*\*/g, '[ 重点 ]')
          .trim();
        if (masked) cues.push(masked);
      }
    }
    if (cues.length === 0) {
      for (const raw of lines.slice(0, 4)) {
        const cleaned = raw.trim().replace(/^[-*\d.]+\s*/, '').replace(/==([^=]+)==/g, '[ ___ ]').replace(/\*\*([^*]+)\*\*/g, '[ 重点 ]');
        if (cleaned) cues.push(cleaned);
      }
    }
    return cues.slice(0, 6);
  }

  function balanceOverdueCards(dueCardList, today, dailyCap = 10) {
    const cap = Math.max(1, Math.trunc(Number(dailyCap) || 10));
    const sorted = sortDueCards(dueCardList || []);
    const updates = [];
    for (let i = cap; i < sorted.length; i++) {
      const dayOffset = Math.floor((i - cap) / cap) + 1;
      const targetDue = addLocalDays(today, dayOffset);
      updates.push({ id: sorted[i]._id || sorted[i].id, due_date: targetDue, dayOffset });
    }
    return updates;
  }

  return {
    DEFAULT_INTERVALS,
    INTERVAL_PRESETS,
    STUDY_METHODS,
    NOTE_TEMPLATES,
    DEFAULT_NOTEBOOK,
    NOTEBOOK_COLORS,
    normalizeNotebook,
    collectNotebooks,
    scoreToBag,
    scoreToBagSafe,
    pickNewerDoc,
    reconcileDocSets,
    intervalDays,
    addLocalDays,
    nextSchedule,
    sortDueCards,
    interleaveByNotebook,
    pickRandomCard,
    extractKeyTerms,
    checkKeyTermHits,
    computeStreak,
    parseBatchMarkdownCards,
    extractCornellCues,
    balanceOverdueCards
  };
});
