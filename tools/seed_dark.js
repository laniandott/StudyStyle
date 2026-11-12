(() => {
  const day = (off) => { const d = new Date(); d.setDate(d.getDate() + off); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
  const iso = (off, h = 9, m = 20) => { const d = new Date(); d.setDate(d.getDate() + off); d.setHours(h, m, 0, 0); return d.toISOString(); };
  const raw = [
    ['光合作用的两大阶段', '### 1. 光反应阶段\n- 场所：叶绿体 **类囊体薄膜**\n- 物质变化：水的光解产生 ==O2== 与 NADPH；合成 ==ATP==\n### 2. 暗反应阶段（卡尔文循环）\n- 过程：CO2 的固定 → ==C3的还原==', ['生物', '高中'], 70, 3, -3],
    ['艾宾浩斯遗忘曲线的三个阶段', '遗忘速率**先快后慢**。\n- 20 分钟内遗忘约 25%\n- 1 天后保留约 33%\n- 复习是唯一对抗手段', ['心理学'], 50, 2, -1],
    ['机会成本与沉没成本', '机会成本是**做出选择时放弃的最高价值选项**。沉没成本属于**历史成本**，不应影响未来决策。', ['经济学'], 30, 1, 0],
    ['TCP 三次握手的必要性', '三次握手用于**同步双方的初始序列号**并确认双向通道可用。', ['编程', '网络'], 90, 4, -2],
    ['格式塔心理学的接近性原则', '距离相近的元素会被视为一组。设计中用**间距**而非线条分隔信息块。', ['心理学', '设计'], 10, 0, 0]
  ];
  const cards = raw.map((r, i) => ({
    _id: `card:seed-${String(i + 1).padStart(2, '0')}`, type: 'card', title: r[0], outline: r[1], tags: r[2],
    created_at: iso(-30 + i, 10, 0), archived_at: null, interval_index: r[3], due_date: day(r[4]),
    last_reviewed_at: r[3] === 0 ? null : iso(r[4] - 3, 20, 10), latest_memory_score: [10, 30, 50, 70, 90][r[3]],
    _rev: String(1000 + i)
  }));
  const settings = { _id: 'settings:main', type: 'settings', interval_days: [1, 3, 7, 14, 30, 60], interval_preset: 'balanced', hold_interval_below_score: 40, default_low_action: 'hold', adaptive_leap: true, daily_review_limit: 25, study_method: 'blurting', theme: 'dark', _rev: '2000' };
  localStorage.setItem('studystyle-fallback-v1', JSON.stringify([...cards, settings]));
  return 'dark seeded';
})()
