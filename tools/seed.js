(() => {
  const day = (off) => {
    const d = new Date(); d.setDate(d.getDate() + off);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };
  const iso = (off, h = 9, m = 20) => {
    const d = new Date(); d.setDate(d.getDate() + off); d.setHours(h, m, 0, 0);
    return d.toISOString();
  };

  const raw = [
    ['光合作用的两大阶段', '### 1. 光反应阶段\n- 场所：叶绿体 **类囊体薄膜**\n- 物质变化：水的光解产生 ==O2== 与 NADPH；合成 ==ATP==\n### 2. 暗反应阶段（卡尔文循环）\n- 场所：**叶绿体基质**\n- 过程：CO2 的固定 → ==C3的还原==（消耗 ATP 和 NADPH）', ['生物', '高中'], 10, 0, -3],
    ['艾宾浩斯遗忘曲线的三个阶段', '遗忘速率**先快后慢**。\n- 遗忘先陡降：20 分钟内遗忘约 25%\n- 之后趋于平缓：1 天后保留约 33%\n- 复习是唯一对抗手段', ['心理学'], 30, 1, -1],
    ['机会成本与沉没成本', '机会成本是**做出选择时放弃的最高价值选项**，不是已支付且不可收回的支出。沉没成本属于**历史成本**，不应影响未来决策。', ['经济学'], 50, 2, 0],
    ['TCP 三次握手的必要性', '三次握手用于**同步双方的初始序列号**并确认双向通道可用；两次握手无法让服务端确认客户端的接收能力，可能因历史连接残留报文而错建连接。', ['编程', '网络'], 70, 3, 1],
    ['认知负荷的三种类型', '认知负荷分三种：\n- **内在负荷**：材料本身的复杂度\n- **外在负荷**：教学呈现方式带来的额外负担\n- **关联负荷**：已有图式与新知识的联系', ['心理学', '教育'], 90, 4, 3],
    ['DNA 半保留复制的实验证据', 'Meselson-Stahl 密度梯度离心实验：\n1. 15N 标记的大肠杆菌在 15N 培养基中培养一代\n2. 转入 14N 培养基\n3. 一代后出现**一条中间密度带**，二代后出现两条带', ['生物'], null, 0, 0],
    ['边际效用递减规律', '连续消费某物品时，每增加一单位带来的**额外满足感递减**。需求曲线因此向右下倾斜。', ['经济学'], 30, 1, 0],
    ['哈希表冲突解决：链地址法', '链地址法把冲突键挂到同一桶的链表上。\n- 平均查找 O(1)，最坏 O(n)\n- 扩容需 **rehash** 全部键\n- Java 8 后链表长度 > 8 且表长 >= 64 时转红黑树', ['编程'], 50, 2, -1],
    ['格式塔心理学的接近性原则', '距离相近的元素会被视为一组。设计中用**间距**而非线条分隔信息块，比分割线更轻量。', ['心理学', '设计'], 70, 3, 0],
    ['康奈尔笔记法的分区', '康奈尔笔记法把页面分为：\n- **线索栏**（左，约 1/4）：关键词、问题\n- **笔记区**（右上）：课堂内容\n- **总结区**（右下）：用自己的话总结', ['学习方法'], 90, 4, 6],
    ['供给曲线的移动与需求量', '供给曲线移动（成本或技术变化）改变均衡数量与价格；需求曲线移动（收入、偏好、替代品价格）同样如此。**区分曲线移动与沿曲线移动**是常见混淆点。', ['经济学'], 10, 0, 0],
    ['Vue 3 的响应式原理', 'Vue 3 用 **Proxy** 替代 Vue 2 的 `Object.defineProperty`：\n- 可直接拦截新增与删除属性\n- 数组方法通过重写拦截\n- 依赖收集用 `track`，触发用 `trigger`', ['编程', '前端'], 50, 2, 0],
    ['间隔重复的最优复习点', '最优复习点 ≈ **记忆衰减到阈值所需时间的 10%** 间隔。间隔过短收益递减，过长则遗忘。遗忘曲线指数衰减假设下，最优间隔随每次成功检索而递增。', ['心理学', '学习方法'], 70, 3, 2],
    ['明朝的九边与互市', '明朝在长城沿线设 **九边** 重镇，隶属五军都督府。俺答汗俺答汗与明廷建立 **马市**，以互市换取边境和平，形成「**修贡守边**」的政策传统。', ['历史'], 30, 1, 0],
    ['费曼学习法的四步', '费曼学习法：\n1. 写下要学的概念\n2. 用**大白话**讲给别人听\n3. 卡壳就回看资料\n4. 简化与类比，去掉术语', ['学习方法'], 90, 4, 4],
    ['SQL 索引失效的常见场景', '常见失效：\n- 对索引列做函数运算或隐式类型转换\n- `LIKE \'%x\'` 前置通配\n- 联合索引不满足最左前缀\n- 优化器判断走索引的区分度太低', ['编程', '数据库'], 10, 0, 0]
  ];

  const cards = raw.map((r, i) => ({
    _id: `card:seed-${String(i + 1).padStart(2, '0')}`,
    type: 'card',
    title: r[0],
    outline: r[1],
    tags: r[2],
    created_at: iso(-30 + i, 10, 0),
    archived_at: null,
    interval_index: r[4],
    due_date: day(r[5]),
    last_reviewed_at: r[4] === 0 ? null : iso(r[5] - 3, 20, 10),
    latest_memory_score: r[3],
    _rev: String(1000 + i)
  }));

  const scores = [90, 70, 50, 30, 10, 90, 70];
  const reviews = [];
  for (let d = 1; d <= 21; d++) {
    const n = (d % 4) + 1;
    for (let k = 0; k < n; k++) {
      const card = cards[(d * 3 + k * 5) % cards.length];
      const sc = scores[(d + k) % scores.length];
      reviews.push({
        _id: `review:seed-${d}-${k}`,
        type: 'review',
        card_id: card._id,
        reviewed_at: iso(-d, 8 + (k % 10), (k * 13) % 60),
        memory_score: sc,
        bag_after: Math.min(4, Math.floor(sc / 20)) + 1,
        interval_days_before: 1,
        interval_days_after: [1, 3, 7, 14, 30, 60][Math.min(5, Math.floor(sc / 20))],
        next_due_date: day(-d + 3),
        duration_sec: 12 + ((d * 7 + k * 11) % 55),
        recall_draft: '',
        note: ''
      });
    }
  }

  const settings = {
    _id: 'settings:main',
    type: 'settings',
    interval_days: [1, 3, 7, 14, 30, 60],
    interval_preset: 'balanced',
    hold_interval_below_score: 40,
    default_low_action: 'hold',
    adaptive_leap: true,
    daily_review_limit: 25,
    study_method: 'blurting',
    theme: 'light',
    _rev: '2000'
  };

  localStorage.setItem('studystyle-fallback-v1', JSON.stringify([...cards, ...reviews, settings]));
  return `seeded ${cards.length} cards / ${reviews.length} reviews`;
})()
