const test = require('node:test');
const assert = require('node:assert/strict');
const Domain = require('../domain.cjs');

test('memory scores map to five 20-point bags with an exclusive upper bound', () => {
  assert.equal(Domain.scoreToBag(null), -1);
  assert.equal(Domain.scoreToBag(0), 0);
  assert.equal(Domain.scoreToBag(19), 0);
  assert.equal(Domain.scoreToBag(20), 1);
  assert.equal(Domain.scoreToBag(39), 1);
  assert.equal(Domain.scoreToBag(40), 2);
  assert.equal(Domain.scoreToBag(59), 2);
  assert.equal(Domain.scoreToBag(60), 3);
  assert.equal(Domain.scoreToBag(79), 3);
  assert.equal(Domain.scoreToBag(80), 4);
  assert.equal(Domain.scoreToBag(100), 4);
});

test('scores below 40 can hold or reset the interval; 40 advances', () => {
  const base = ['2026-11-11', [1, 3, 7, 14, 30, 60]];
  assert.deepEqual(Domain.nextSchedule(4, 10, 'hold', ...base), { intervalIndex: 4, days: 30, dueDate: '2026-12-11', bag: 0 });
  assert.deepEqual(Domain.nextSchedule(4, 10, 'reset', ...base), { intervalIndex: 0, days: 1, dueDate: '2026-11-12', bag: 0 });
  assert.deepEqual(Domain.nextSchedule(4, 39, 'advance', ...base), { intervalIndex: 5, days: 60, dueDate: '2027-01-10', bag: 1 });
  assert.deepEqual(Domain.nextSchedule(4, 40, 'hold', ...base), { intervalIndex: 5, days: 60, dueDate: '2027-01-10', bag: 2 });
});

test('schedule caps at the longest interval and counts local calendar days', () => {
  assert.deepEqual(Domain.nextSchedule(5, 80, 'advance', '2026-12-30'), { intervalIndex: 5, days: 60, dueDate: '2027-02-28', bag: 4 });
});

test('due queue orders first reviews, then lower memory bags, then older due dates', () => {
  const cards = [
    { id: 'later', latest_memory_score: 10, due_date: '2026-11-10', created_at: '2026-11-01' },
    { id: 'familiar', latest_memory_score: 90, due_date: '2026-11-01', created_at: '2026-11-01' },
    { id: 'new', latest_memory_score: null, due_date: '2026-11-11', created_at: '2026-11-11' },
    { id: 'old', latest_memory_score: 10, due_date: '2026-11-08', created_at: '2026-11-01' }
  ];
  assert.deepEqual(Domain.sortDueCards(cards).map(card => card.id), ['new', 'old', 'later', 'familiar']);
});

test('invalid scores and interval configurations are rejected', () => {
  assert.throws(() => Domain.scoreToBag(101), RangeError);
  assert.throws(() => Domain.nextSchedule(0, -1, 'hold', '2026-11-11'), RangeError);
  assert.throws(() => Domain.nextSchedule(0, 50, 'advance', '2026-11-11', []), TypeError);
});

test('pickRandomCard picks from pool, avoids immediate repeat, and weights lower bags higher', () => {
  assert.equal(Domain.pickRandomCard([]), null);
  const single = [{ _id: 'c1', title: 'Only' }];
  assert.equal(Domain.pickRandomCard(single, 'c1')._id, 'c1');
  const pool = [
    { _id: 'c1', latest_memory_score: 90 }, // bag 4 -> weight 1
    { _id: 'c2', latest_memory_score: 10 }, // bag 0 -> weight 5
    { _id: 'c3', latest_memory_score: 90 }  // bag 4 -> weight 1
  ];
  assert.equal(Domain.pickRandomCard(pool, 'c1', () => 0)._id, 'c2');
  assert.equal(Domain.pickRandomCard(pool, 'c1', () => 0.8)._id, 'c2');
  assert.equal(Domain.pickRandomCard(pool, 'c1', () => 0.99)._id, 'c3');
});

test('extractKeyTerms and checkKeyTermHits extract bold/cloze terms and compare against recall draft', () => {
  const outline = '- 第一阶段：**光反应**\n  - 场所：==类囊体薄膜==\n  - 产物：**ATP** 与 ==O2==';
  assert.deepEqual(Domain.extractKeyTerms(outline), ['光反应', '类囊体薄膜', 'ATP', 'O2']);
  const check = Domain.checkKeyTermHits(outline, '光反应在类囊体薄膜进行，产生atp');
  assert.equal(check.total, 4);
  assert.equal(check.hitCount, 3);
  assert.deepEqual(check.hits, ['光反应', '类囊体薄膜', 'ATP']);
  assert.deepEqual(check.missed, ['O2']);
});

test('computeStreak calculates consecutive review days and 14-day activity strip', () => {
  const days = ['2026-11-11', '2026-11-11', '2026-11-10', '2026-11-09', '2026-11-06'];
  const info = Domain.computeStreak(days, '2026-11-11');
  assert.equal(info.currentStreak, 3);
  assert.equal(info.activeToday, true);
  assert.equal(info.last14Days.length, 14);
  assert.equal(info.last14Days[13].day, '2026-11-11');
  assert.equal(info.last14Days[13].count, 2);
});

test('recommendScoreFromHits maps keyword hit ratio to score presets', () => {
  assert.equal(Domain.recommendScoreFromHits({ total: 0, hitCount: 0 }), null);
  assert.deepEqual(Domain.recommendScoreFromHits({ total: 4, hitCount: 4 }), { score: 90, preset: 4, label: '熟悉' });
  assert.deepEqual(Domain.recommendScoreFromHits({ total: 4, hitCount: 3 }), { score: 70, preset: 3, label: '较好' });
  assert.deepEqual(Domain.recommendScoreFromHits({ total: 4, hitCount: 2 }), { score: 50, preset: 2, label: '一般' });
  assert.deepEqual(Domain.recommendScoreFromHits({ total: 4, hitCount: 1 }), { score: 30, preset: 1, label: '较弱' });
  assert.deepEqual(Domain.recommendScoreFromHits({ total: 4, hitCount: 0 }), { score: 10, preset: 0, label: '待加强' });
});

test('parseBatchMarkdownCards splits # and ## headings into cards with tags', () => {
  const md = `# TCP 三次握手
- 第一次：SYN=1
- 第二次：SYN=1, ACK=1

## DNS 解析流程
- 浏览器缓存 -> 本地 Host -> 根域名服务器`;
  const cards = Domain.parseBatchMarkdownCards(md, ['计网', '面试']);
  assert.equal(cards.length, 2);
  assert.equal(cards[0].title, 'TCP 三次握手');
  assert.equal(cards[0].outline, '- 第一次：SYN=1\n- 第二次：SYN=1, ACK=1');
  assert.deepEqual(cards[0].tags, ['计网', '面试']);
  assert.equal(cards[1].title, 'DNS 解析流程');
});

test('nextSchedule supports custom passThreshold and FSRS-inspired adaptiveLeap (+2 steps on >=85%)', () => {
  const intervals = Domain.INTERVAL_PRESETS.ebbinghaus.days; // [1, 2, 4, 7, 15, 30]
  assert.deepEqual(
    Domain.nextSchedule(1, 90, 'advance', '2026-11-11', intervals, { passThreshold: 50, adaptiveLeap: true }),
    { intervalIndex: 3, days: 7, dueDate: '2026-11-18', bag: 4 }
  );
  assert.deepEqual(
    Domain.nextSchedule(2, 45, 'reset', '2026-11-11', intervals, { passThreshold: 50, adaptiveLeap: true }),
    { intervalIndex: 0, days: 1, dueDate: '2026-11-12', bag: 2 }
  );
});

test('extractCornellCues masks cloze and bold terms from top-level bullets and balanceOverdueCards spreads overflow', () => {
  const cues = Domain.extractCornellCues('- 第一阶段：==类囊体薄膜== 进行 **光反应**\n  - 子细节\n- 第二阶段：==叶绿体基质==');
  assert.deepEqual(cues, ['第一阶段：[ ___ ] 进行 [ 重点 ]', '第二阶段：[ ___ ]']);

  const dueList = [
    { _id: 'c1', latest_memory_score: 10, due_date: '2026-11-10', created_at: '2026-11-01' },
    { _id: 'c2', latest_memory_score: 30, due_date: '2026-11-10', created_at: '2026-11-01' },
    { _id: 'c3', latest_memory_score: 50, due_date: '2026-11-10', created_at: '2026-11-01' },
    { _id: 'c4', latest_memory_score: 70, due_date: '2026-11-10', created_at: '2026-11-01' },
    { _id: 'c5', latest_memory_score: 90, due_date: '2026-11-10', created_at: '2026-11-01' }
  ];
  const plan = Domain.balanceOverdueCards(dueList, '2026-11-11', 2);
  assert.equal(plan.length, 3);
  assert.deepEqual(plan.map(p => ({ id: p.id, due: p.due_date })), [
    { id: 'c3', due: '2026-11-12' },
    { id: 'c4', due: '2026-11-12' },
    { id: 'c5', due: '2026-11-13' }
  ]);
});

test('normalizeNotebook and collectNotebooks group cards by subject and count due items', () => {
  assert.equal(Domain.normalizeNotebook(''), '默认笔记本');
  assert.equal(Domain.normalizeNotebook('  高等数学  '), '高等数学');
  const cards = [
    { _id: '1', notebook: '高等数学', due_date: '2026-11-10' },
    { _id: '2', notebook: '高等数学', due_date: '2026-11-15' },
    { _id: '3', notebook: '计算机网络', due_date: '2026-11-11' }
  ];
  const saved = [{ name: '高等数学', color: 'emerald' }, { name: '英语词汇', color: 'rose' }];
  const list = Domain.collectNotebooks(cards, saved, '2026-11-11');
  const math = list.find(n => n.name === '高等数学');
  const net = list.find(n => n.name === '计算机网络');
  const eng = list.find(n => n.name === '英语词汇');
  assert.deepEqual({ total: math.total, due: math.due, color: math.color }, { total: 2, due: 1, color: 'emerald' });
  assert.deepEqual({ total: net.total, due: net.due }, { total: 1, due: 1 });
  assert.deepEqual({ total: eng.total, due: eng.due, color: eng.color }, { total: 0, due: 0, color: 'rose' });
});
