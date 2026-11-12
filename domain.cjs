(function (root, factory) {
  const domain = factory();
  if (typeof module === 'object' && module.exports) module.exports = domain;
  if (root) root.StudyStyleDomain = domain;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  const DEFAULT_INTERVALS = [1, 3, 7, 14, 30, 60];

  const INTERVAL_PRESETS = {
    ebbinghaus: { key: 'ebbinghaus', name: '经典艾宾浩斯', days: [1, 2, 4, 7, 15, 30], desc: '前密后疏（1/2/4/7/15/30天），适合短期密集攻克新概念' },
    balanced: { key: 'balanced', name: '均衡长效记忆', days: [1, 3, 7, 14, 30, 60], desc: '经典稳健节奏（1/3/7/14/30/60天），兼顾日常负担与长期留存' },
    cram: { key: 'cram', name: '考前高频冲刺', days: [1, 2, 3, 5, 8, 14], desc: '压缩长周期（最高14天），适合考前 1–2 周高频滚动突击' },
    deep: { key: 'deep', name: '长线深度掌握', days: [1, 4, 10, 25, 60, 120], desc: '大跨度递进（最高120天），适合已理解透彻的底层原理与框架' }
  };

  const STUDY_METHODS = {
    blurting: {
      key: 'blurting',
      name: '空白主动默写 (Blurting)',
      badge: '空白默写',
      prompt: '闭卷在下方快速默写你能想起的大纲主干、关键词与推导细节，写完后展开大纲比对命中率…'
    },
    feynman: {
      key: 'feynman',
      name: '费曼讲授法 (Feynman)',
      badge: '费曼讲授',
      prompt: '假装向零基础新手解释这个概念：\n1. 它到底解决什么核心问题？\n2. 它的底层运转逻辑是什么（拒绝死记术语）？\n3. 举一个生活类比或反例：'
    },
    cornell: {
      key: 'cornell',
      name: '康奈尔线索法 (Cornell Cues)',
      badge: '康奈尔线索',
      prompt: '参考上方提取的「康奈尔主干线索与提问」，逐条向下还原隐去的关键细节与空缺内容…'
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
      const aBag = scoreToBag(a.latest_memory_score);
      const bBag = scoreToBag(b.latest_memory_score);
      return aBag - bBag || a.due_date.localeCompare(b.due_date) || a.created_at.localeCompare(b.created_at);
    });
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

  function recommendScoreFromHits(hitResult) {
    if (!hitResult || !hitResult.total) return null;
    const ratio = hitResult.hitCount / hitResult.total;
    if (ratio >= 0.9) return { score: 90, preset: 4, label: '熟悉' };
    if (ratio >= 0.7) return { score: 70, preset: 3, label: '较好' };
    if (ratio >= 0.45) return { score: 50, preset: 2, label: '一般' };
    if (ratio >= 0.2) return { score: 30, preset: 1, label: '较弱' };
    return { score: 10, preset: 0, label: '待加强' };
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
    intervalDays,
    addLocalDays,
    nextSchedule,
    sortDueCards,
    pickRandomCard,
    extractKeyTerms,
    checkKeyTermHits,
    computeStreak,
    recommendScoreFromHits,
    parseBatchMarkdownCards,
    extractCornellCues,
    balanceOverdueCards
  };
});
