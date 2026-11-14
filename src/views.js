/* StudyStyle 模块：src/views.js */


async function render() {
  closeAllRowMenus();
  const allCards = await getCards();
  const allDue = await dueCards(false);
  const settings = (await getSetting()) || {};
  applyTheme(settings.theme || 'light');
  if (!$('#reviewDialog')?.open && settings.study_method) activeStudyMethod = settings.study_method;
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
  if (view === 'settings') {
    if (!couchProxyState.checked && typeof refreshCouchProxyStatus === 'function') await refreshCouchProxyStatus();
    $('#viewRoot').innerHTML = await renderSettings();
  }
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
  const validReviews = allReviews.filter(row => row?.reviewed_at && Number.isFinite(Date.parse(row.reviewed_at)));
  const done = validReviews.filter(row => localDay(new Date(row.reviewed_at)) === today).length;
  const streakInfo = Domain.computeStreak(validReviews.map(row => localDay(new Date(row.reviewed_at))), today);
  const allFilteredDue = activeBagFilter == null ? due : due.filter(card => bagFor(card) === activeBagFilter);
  /* 队列完整展示全部到期卡片（计划 §4.2「不丢失原则」：优先级只决定出场顺序，卡片不会因排后而消失）。
     每日上限只作为「本轮建议量」提示，不再截断队列。 */
  const items = allFilteredDue;
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
        ${limitReached && items.length ? `<button class="button button-outline" data-action="start-today-all">${icon('play')}继续加练全部（已达上限）</button>` : `<button class="button button-primary" data-action="start-today" ${!items.length ? 'disabled' : ''}>${icon('play')}开始复习</button>`}
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
      <div class="queue-meta">${notebookChipHtml(card.notebook, notebooks)}${badgeHtml(card)}<span class="cycle-chip">周期 ${intervalFor(card, intervals, settings)} 天</span>${cardTags(card).slice(0, 3).map(tag => `<span class="tag">${escapeHtml(tag)}</span>`).join('')}</div>
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
          <div class="metric-line d-block"><span>卡片池等级分布</span>${stackSegments}</div>
        </div>
      </div>
    </div>
  </details>`;

  /* 超量提示：队列仍完整展示，仅建议分批处理并提供一键顺延入口 */
  const overflowNote = dailyLimit > 0 && items.length > dailyLimit
    ? `<div class="inline-actions justify-end mt-3"><span class="field-hint">今日共 ${items.length} 张到期，超过建议量 ${dailyLimit} 张 · 可分批完成或顺延到明天</span><button class="text-button" data-action="snooze">${icon('waves')}顺延剩余到期卡片</button></div>`
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
  /* 周期天数与排期引擎取用户实际配置，确保队列、列表与复习预览展示一致 */
  const settings = (await getSetting()) || {};
  const intervals = settings.interval_days || INTERVALS;
  const allTags = [...new Set(cards.flatMap(cardTags))].sort((a, b) => a.localeCompare(b, 'zh-CN'));
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
  <div class="library-list ${layoutMode === 'grid' ? 'grid-mode' : ''} ${batchMode ? 'batch-active' : ''}" id="libraryList">${renderLibraryRows(cards, notebooks, intervals, settings)}</div>
  <div class="empty-filter hidden" id="libraryEmptyResult"></div>
  <details class="ios-fold-card" data-fold-key="batchImporter" ${uiFolds.batchImporter ? 'open' : ''}>
    <summary class="ios-fold-summary">
      <div class="fold-title-group"><span class="fold-icon">${icon('pen-line')}</span><div><strong>Markdown 批量快速制卡</strong><small>粘贴带 # 一级/二级标题的笔记，自动拆分为多张提纲卡片</small></div></div>
      <span class="fold-chevron">${icon('chevron-right')}</span>
    </summary>
    <div class="ios-fold-body">
      <div class="settings-field"><label class="field-label" for="batchMdInput">批量笔记内容 <span class="optional">以 # 或 ## 标题作为每张卡片标题，下方行作为大纲</span></label><textarea class="text-area outline-input" id="batchMdInput" rows="6" placeholder="# 光合作用的光反应&#10;- 场所：**类囊体薄膜**&#10;- 产物：==ATP==、NADPH、O2&#10;&#10;# 光合作用的暗反应&#10;- 场所：**叶绿体基质**&#10;- 核心过程：CO2固定与 ==C3还原=="></textarea></div>
      <div class="library-primary-bar mb-0"><input class="text-input batch-input-nb" id="batchMdNotebook" value="${escapeHtml(activeNotebookFilter || Domain.DEFAULT_NOTEBOOK)}" placeholder="所属科目笔记本" /><input class="text-input batch-input-tags" id="batchMdTags" placeholder="统一附加标签（选填，逗号分隔）" /><button type="button" class="button button-primary" id="runBatchImportBtn" data-action="run-batch-import">${icon('sparkles')}一键拆分并创建卡片</button></div>
    </div>
  </details>
  ${archived.length ? `<details class="ios-fold-card" data-fold-key="libraryArchived" ${uiFolds.libraryArchived ? 'open' : ''}>
    <summary class="ios-fold-summary"><div class="fold-title-group"><span class="fold-icon">${icon('archive')}</span><div><strong>已归档卡片</strong><small>共 ${archived.length} 张已移出复习池，可随时恢复</small></div></div><span class="fold-chevron">${icon('chevron-right')}</span></summary>
    <div class="ios-fold-body"><div class="library-list">${archived.map(card => {
      const archivedTime = typeof card.archived_at === 'string' ? Date.parse(card.archived_at) : NaN;
      const archivedLabel = Number.isFinite(archivedTime) ? fmtDate(localDay(new Date(archivedTime))) : '未知日期';
      return `<div class="library-row archived-row">
      <div class="library-row-main"><div class="library-row-title"><span>${escapeHtml(card.title)}</span></div><div class="library-row-sub">${notebookChipHtml(card.notebook, notebooks)}<span>归档于 ${archivedLabel}</span></div></div>
      <div class="library-due"></div>
      <div class="row-actions">
        <button class="icon-button" data-restore="${escapeHtml(card._id)}" aria-label="恢复卡片" title="恢复">${icon('undo')}</button>
        <button class="icon-button danger" data-delete="${escapeHtml(card._id)}" aria-label="删除卡片" title="彻底删除">${icon('trash')}</button>
      </div>
    </div>`;}).join('')}</div></div>
  </details>` : ''}
  ${batchDockHtml}`;
}

function renderLibraryRows(cards, notebooks = [], intervals = INTERVALS, settings = null) {
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
    const tags = cardTags(card);
    return `<div class="library-row ${isOpen ? 'expanded' : ''} ${isSelected ? 'batch-selected' : ''} ${levelClass(index)}" data-card-row="${escapeHtml(card._id)}" data-notebook="${escapeHtml(nbName)}" data-bag="${bagFor(card)}" data-score="${scoreVal}" data-due="${card.due_date}" data-created="${escapeHtml(card.created_at || '')}" data-title="${escapeHtml(card.title)}" data-tags="${escapeHtml(tags.join('|'))}" data-search="${escapeHtml(`${card.title}\n${card.outline}\n${nbName}\n${tags.join(' ')}`.toLowerCase())}">
      <div class="library-row-main" data-toggle-card="${escapeHtml(card._id)}">
        <div class="library-row-title">${checkBtn}<button type="button" class="library-title-btn" data-toggle-card="${escapeHtml(card._id)}" aria-expanded="${isOpen}"><span class="expand-caret ${isOpen ? 'open' : ''}" aria-hidden="true">${icon('chevron-right')}</span>${escapeHtml(card.title)}</button></div>
        <div class="library-card-snippet">${escapeHtml(plainSnippet || '点击展开大纲详情')}</div>
        <div class="library-row-sub">${notebookChipHtml(nbName, notebooks)}${badgeHtml(card)}${scoreVal >= 0 ? `<span>记忆度 ${scoreVal}%</span>` : ''}<span>周期 ${intervalFor(card, intervals, settings)} 天</span>${tags.length ? tags.slice(0, 3).map(t => `<span class="tag">${escapeHtml(t)}</span>`).join('') : '<span>无标签</span>'}</div>
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
    reviews = reviews.filter(r => cards[r.card_id] && cardNotebook(cards[r.card_id]) === activeNotebookFilter);
  }
  const filteredCard = activeHistoryCardFilter ? cards[activeHistoryCardFilter] : null;
  const visibleReviews = reviews.slice(0, historyVisibleLimit);
  const remainingHistoryCount = Math.max(0, reviews.length - visibleReviews.length);
  const groups = new Map();
  for (const record of visibleReviews) {
    const parsedTime = record?.reviewed_at ? Date.parse(record.reviewed_at) : NaN;
    const day = Number.isFinite(parsedTime) ? localDay(new Date(parsedTime)) : '未知日期';
    if (!groups.has(day)) groups.set(day, []);
    groups.get(day).push(record);
  }
  const groupHtml = [...groups.entries()].map(([day, rows]) => {
    const validScores = rows
      .map(row => (row.memory_score !== '' && row.memory_score != null ? Number(row.memory_score) : NaN))
      .filter(Number.isFinite);
    const avgLabel = validScores.length
      ? ` · 平均 ${Math.round(validScores.reduce((sum, score) => sum + score, 0) / validScores.length)}%`
      : '';
    const dayLabel = day === '未知日期'
      ? '未知日期'
      : new Date(`${day}T12:00:00`).toLocaleDateString('zh-CN', { month: 'long', day: 'numeric' });
    const rowsHtml = rows.map(record => {
      const card = cards[record.card_id];
      const parsedScore = record.memory_score !== '' && record.memory_score != null ? Number(record.memory_score) : NaN;
      const scoreVal = Number.isFinite(parsedScore) ? Math.max(0, Math.min(100, Math.round(parsedScore))) : null;
      const tempCard = { ...(card || {}), latest_memory_score: scoreVal };
      const parsedReviewedAt = record?.reviewed_at ? Date.parse(record.reviewed_at) : NaN;
      const reviewedAtLabel = Number.isFinite(parsedReviewedAt) ? new Date(parsedReviewedAt).toLocaleString('zh-CN') : '时间未记录';
      const nextDueLabel = record.next_due_date ? fmtDate(record.next_due_date) : '待定';
      const intervalNote = record.interval_days_before != null && record.interval_days_after != null ? `<span class="cycle-chip">周期 ${record.interval_days_before} 天 → ${record.interval_days_after} 天</span>` : '';
      const durationNote = record.duration_sec ? `<span class="history-dur">用时 ${record.duration_sec} 秒</span>` : '';
      const draftParts = [];
      if (record.recall_draft) draftParts.push(`<div><strong>首次闭卷回忆</strong><pre>${escapeHtml(record.recall_draft)}</pre></div>`);
      if (record.recall_after_feedback) draftParts.push(`<div><strong>看过答案后的补充</strong><pre>${escapeHtml(record.recall_after_feedback)}</pre></div>`);
      if (record.application_attempt) draftParts.push(`<div><strong>应用练习记录</strong><pre>${escapeHtml(record.application_attempt)}</pre></div>`);
      const draft = draftParts.length ? `<details class="history-draft" ${scoreVal != null && scoreVal < 60 ? 'open' : ''}><summary>${record.recall_after_feedback ? '查看回忆与反馈后补充' : '查看首次回忆草稿'}</summary>${draftParts.join('')}</details>` : '';
      return `<div class="history-row ${levelClass(bagIndex(tempCard))}">
        <div class="history-main">
          <div class="history-title-line"><span class="timeline-dot"></span><strong>${escapeHtml(card?.title || '已删除卡片')}</strong>${card ? notebookChipHtml(card.notebook, notebooks) : ''}${intervalNote}</div>
          <small class="history-time">${reviewedAtLabel} · 下次到期 ${nextDueLabel} ${durationNote}</small>
          ${record.note ? `<div class="history-note">${icon('lightbulb')}漏点备注：${escapeHtml(record.note)}</div>` : ''}
          ${draft}
        </div>
        <div class="history-bag">${badgeHtml(tempCard)}</div>
        <div class="history-score-pill ${levelClass(bagIndex(tempCard))}"><strong>${scoreVal != null ? `${scoreVal}%` : '未评分'}</strong></div>
      </div>`;
    }).join('');
    return `<section class="history-group">
      <div class="history-group-head"><h2>${dayLabel}</h2><span>${rows.length} 次${avgLabel}</span></div>
      <div class="history-group-rows">${rowsHtml}</div>
    </section>`;
  }).join('');

  const body = reviews.length ? `<div class="history-timeline">${groupHtml}${remainingHistoryCount ? `<div class="inline-actions justify-center mt-3"><button type="button" class="button button-outline" data-action="load-more-history">显示更早历史记录（还有 ${remainingHistoryCount} 条）</button></div>` : ''}</div>` : `<div class="empty-state">
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
  const savedStoreToken = loadStoreToken();
  const schedulerMode = schedulerModeFor(saved);
  const currentDaysStr = (saved.interval_days || INTERVALS).join(', ');
  const passThreshold = passThresholdFor(saved);
  const lowAction = saved.default_low_action || 'hold';
  const adaptiveLeap = saved.adaptive_leap === true;
  const dailyLimit = Number(saved.daily_review_limit ?? 25);
  const studyMethod = saved.study_method || activeStudyMethod || 'blurting';
  const presets = Object.values(Domain.INTERVAL_PRESETS || {});
  const activePreset = presets.find(p => p.days.join(', ') === currentDaysStr)?.key || 'custom';
  const presetCardsHtml = presets.map(p => `<button type="button" class="preset-curve-card ${activePreset === p.key ? 'active' : ''}" data-interval-preset="${p.key}"><strong>${escapeHtml(p.name)}</strong><span>${p.days.join(' → ')} 天</span><small>${escapeHtml(p.desc)}</small></button>`).join('');
  /* 渐进披露：自定义阶梯仅在预设不匹配当前曲线时展开 */
  const showCustomLadder = uiFolds.customLadder || activePreset === 'custom';
  /* 渐进披露：40% / 50% / 60% 下展示低于阈值策略；仅 30% 宽松档隐藏 */
  const showLowAction = passThreshold >= 40;

  return `<div class="page-heading">
    <div><h1>设置与同步</h1><p class="page-subtitle">调整复习节奏、每日学习量、外观与多设备同步。当前全部是默认值也可以直接开始复习。</p></div>
    <span class="sync-pill ${syncHandler && couchSyncPhase !== 'reconnecting' ? 'connected' : ''}">${syncHandler ? (couchSyncPhase === 'reconnecting' ? '重连中' : '正在同步') : '本地模式'}</span>
  </div>
  <div class="settings-grid">
    <section class="settings-section">
      <h2>${icon('clock')}复习节奏</h2>
      <p>默认启用自适应稳定度引擎（结合回忆成绩、已过间隔、连续成功与遗忘衰减动态算天数）；也可随时切回经典固定阶梯。</p>
      <label class="field-label" for="schedulerModeSelect">排期算法引擎</label>
      <select class="select-input w-full mb-3" id="schedulerModeSelect">
        <option value="adaptive" ${schedulerMode === 'adaptive' ? 'selected' : ''}>自适应稳定度引擎（推荐 · 连续 Stability / Difficulty + 软回退）</option>
        <option value="ladder" ${schedulerMode === 'ladder' ? 'selected' : ''}>经典固定阶梯（按预设天数逐档递增）</option>
      </select>
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
          <select class="select-input w-full" id="passThresholdSelect">
            <option value="30" ${passThreshold === 30 ? 'selected' : ''}>30%（宽松推进）</option>
            <option value="40" ${passThreshold === 40 ? 'selected' : ''}>40%（经典宽松）</option>
            <option value="50" ${passThreshold === 50 ? 'selected' : ''}>50%（稳健巩固）</option>
            <option value="60" ${passThreshold === 60 ? 'selected' : ''}>60%（硬核推荐 · 防虚高）</option>
          </select>
        </div>
        ${showLowAction ? `<div>
          <label class="field-label" for="lowActionSelect">低于阈值时默认策略</label>
          <select class="select-input w-full" id="lowActionSelect">
            <option value="hold" ${lowAction === 'hold' ? 'selected' : ''}>保持当前周期档位（Hold）</option>
            <option value="reset" ${lowAction === 'reset' ? 'selected' : ''}>重置回第 1 天重新巩固（Reset）</option>
          </select>
        </div>` : ''}
      </div>
      <label class="ios-check-row mt-3">
        <input type="checkbox" id="adaptiveLeapCheck" ${adaptiveLeap ? 'checked' : ''} />
        <span><strong>${icon('zap')}高分时跨两档：</strong>评分 ≥ 85 时跨越 2 个周期阶梯，作为可选的排期规则</span>
      </label>
      <div class="settings-actions"><button class="button button-primary" data-action="save-intervals">保存调度设置</button></div>
    </section>

    <section class="settings-section">
      <h2>${icon('brain')}每日学习量与方式</h2>
      <p>以主动回忆、核对纠错和分散复习为主；方法提示用于帮助组织答案，不替代独立作答与实际练习。</p>
      <label class="field-label" for="dailyLimitSelect">每日复习上限（防雪崩护盾）</label>
      <select class="select-input w-full" id="dailyLimitSelect">
        <option value="15" ${dailyLimit === 15 ? 'selected' : ''}>15 张 / 天（轻量无压 · 约 10 分钟）</option>
        <option value="25" ${dailyLimit === 25 ? 'selected' : ''}>25 张 / 天（推荐均衡 · 约 20 分钟）</option>
        <option value="40" ${dailyLimit === 40 ? 'selected' : ''}>40 张 / 天（进阶强化 · 约 30 分钟）</option>
        <option value="60" ${dailyLimit === 60 ? 'selected' : ''}>60 张 / 天（考前冲刺高吞吐）</option>
        <option value="0" ${dailyLimit === 0 ? 'selected' : ''}>不设上限（显示全部到期卡片）</option>
      </select>
      <div class="field-note">也可在今日复习页数据带右侧的「上限」chip 就地调整。</div>
      <label class="field-label" for="defaultStudyMethodSelect">默认回忆提示（复习时可随时切换）</label>
      <select class="select-input w-full" id="defaultStudyMethodSelect">
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
      <p>当前为 ${isDark ? '深色' : '浅色'}外观 · 存储于 ${pouchMode ? 'PouchDB (IndexedDB)' : (getLocalStorageBackendName() === 'indexeddb' ? 'IndexedDB（本机持久化）' : 'localStorage 兼容模式')}。</p>
      <div class="settings-actions">
        <button class="button button-outline small-button" data-action="toggle-theme">${isDark ? icon('sun') : icon('moon')}${isDark ? '切换浅色外观' : '切换深色外观'}</button>
        <button class="button button-outline small-button" data-action="export">${icon('archive')}导出 JSON 备份</button>
      </div>
      <details class="ios-fold-section mt-3" data-fold-key="importJson" ${uiFolds.importJson ? 'open' : ''}>
        <summary class="ios-fold-summary"><span class="fold-title-group"><span class="fold-icon">${icon('download')}</span><span>导入 JSON 备份</span></span><span class="fold-chevron">${icon('chevron-right')}</span></summary>
        <div class="ios-fold-body">
          <div class="field-note">导入会覆盖同 ID 的卡片与记录，请先导出一份备份。</div>
          <div class="settings-actions mt-2">
            <button class="button button-outline small-button" data-action="import">${icon('upload')}选择 JSON 文件</button>
            <input type="file" id="importFile" accept="application/json,.json" hidden />
          </div>
        </div>
      </details>
      <details class="ios-fold-section mt-2" data-fold-key="pwaInfo" ${uiFolds.pwaInfo || deferredInstallPrompt ? 'open' : ''}>
        <summary class="ios-fold-summary"><span class="fold-title-group"><span class="fold-icon">${icon('cards')}</span><span>安装为应用 (PWA) 与离线使用</span></span><span class="fold-chevron">${icon('chevron-right')}</span></summary>
        <div class="ios-fold-body">
          <div class="field-note">
            ${isStandalonePwa() ? '当前正以独立应用模式运行。' : '可添加到手机主屏幕或桌面像独立 App 一样全屏运行。'}
            ${swRegistration ? '离线外壳已就绪，断网时仍可复习本地卡片。' : (isPwaSecureContext() ? '正在准备离线外壳…' : '当前为非加密 HTTP 地址：iOS Safari「添加到主屏幕」仍可全屏使用；完整离线缓存与一键安装需通过 HTTPS 或 localhost 访问。')}
            <div class="mt-1">本机存储引擎：<strong>${getLocalStorageBackendName() === 'indexeddb' ? 'IndexedDB（大容量异步持久化）' : 'localStorage 兼容模式'}</strong></div>
          </div>
          <div class="settings-actions mt-2">
            ${!isStandalonePwa() && deferredInstallPrompt ? `<button class="button button-primary small-button" data-action="install-pwa">${icon('download')}一键安装应用</button>` : ''}
            <button class="button button-outline small-button" data-action="refresh-pwa-cache">${icon('sync')}更新离线缓存</button>
          </div>
        </div>
      </details>
    </section>

    <section class="settings-section">
      <h2>${icon('sync')}多设备同步</h2>
      <p>支持同源服务端直连同步与个人 CouchDB 双向同步；本地单机使用无需配置。</p>
      <details class="ios-fold-section mb-2" data-fold-key="storeTokenSettings" ${uiFolds.storeTokenSettings || serverTokenRequired || savedStoreToken ? 'open' : ''}>
        <summary class="ios-fold-summary"><span class="fold-title-group"><span class="fold-icon">${icon('sliders')}</span><span>同源服务访问令牌（STORE_TOKEN）</span></span><span class="fold-chevron">${icon('chevron-right')}</span></summary>
        <div class="ios-fold-body">
          <div class="field-note">当服务端配置了环境变量 <code>STORE_TOKEN</code> 时在此填入，请求将自动携带 <code>X-Store-Token</code>。仅保存在本机浏览器，不写入同步库或导出备份。</div>
          <div class="settings-field mt-2">
            <label class="field-label" for="serverTokenInput">访问令牌（STORE_TOKEN）</label>
            <input class="text-input" id="serverTokenInput" type="password" autocomplete="off" placeholder="若服务端未启用鉴权可留空" value="${escapeHtml(savedStoreToken)}" />
          </div>
          <div class="settings-actions">
            <button class="button button-primary small-button" data-action="save-store-token">保存令牌并同步</button>
            ${savedStoreToken ? '<button class="button button-quiet small-button" data-action="clear-store-token">清除本地令牌</button>' : ''}
          </div>
          <div class="status-box ${serverTokenRequired ? 'error' : (savedStoreToken ? 'ok' : '')}" id="storeTokenStatus">${escapeHtml(serverTokenRequired ? '服务端返回 401：需要有效的 STORE_TOKEN，填写后请点击「保存令牌并同步」。' : (savedStoreToken ? '已在本机保存访问令牌，刷新/同步会自动携带请求头。' : '未设置访问令牌；同源公开部署可留空。'))}</div>
        </div>
      </details>
      <details class="ios-fold-section" data-fold-key="couchSettings" ${uiFolds.couchSettings || syncHandler || prefillUrl || couchProxyState.enabled || savedCreds?.mode === 'proxy' ? 'open' : ''}>
        <summary class="ios-fold-summary"><span class="fold-title-group"><span class="fold-icon">${icon('cloud')}</span><span>高级：连接个人 CouchDB</span></span><span class="fold-chevron">${icon('chevron-right')}</span></summary>
        <div class="ios-fold-body">
          ${couchProxyState.enabled ? `<div class="status-box ok mb-3">
            <strong>已开启服务端 CouchDB 安全代理（浏览器不保存密码）</strong>
            <div class="field-note mt-1">远端凭据由服务端环境变量托管（数据库：<code>${escapeHtml(couchProxyState.db || 'studystyle')}</code>），通过同源代理 + <code>STORE_TOKEN</code> 转发，不在本机 <code>localStorage</code> 存密码。</div>
            <div class="settings-actions mt-2">
              <button class="button button-outline small-button" data-action="test-couch-proxy">测试服务端代理</button>
              <button class="button button-primary small-button" data-action="connect-couch-proxy">通过服务端代理连接同步</button>
            </div>
          </div>` : ''}
          <div class="field-note">${couchProxyState.enabled ? '也可改为手动直连其他 CouchDB（需要服务器启用 HTTPS 与 CORS）：' : '需要已创建的数据库和有读写权限的专用账号。浏览器直连需要服务器启用 HTTPS 与 CORS（或由服务端配置 <code>COUCH_PROXY_URL</code> 代理连接，免在浏览器保存密码）。'}</div>
          <div class="settings-grid mt-2">
            <div class="settings-field"><label class="field-label" for="couchUrl">HTTPS 服务地址</label><input class="text-input" id="couchUrl" type="url" placeholder="https://db.example.com" value="${escapeHtml(prefillUrl)}" /></div>
            <div class="settings-field"><label class="field-label" for="couchDb">数据库名</label><input class="text-input" id="couchDb" placeholder="studystyle" value="${escapeHtml(prefillDb || couchProxyState.db || '')}" /></div>
            <div class="settings-field"><label class="field-label" for="couchUser">专用用户名</label><input class="text-input" id="couchUser" autocomplete="username" value="${escapeHtml(prefillUser)}" /></div>
            <div class="settings-field"><label class="field-label" for="couchPass">密码 <span class="optional">不会写入同步库或导出备份</span></label><input class="text-input" id="couchPass" type="password" autocomplete="current-password" value="${escapeHtml(prefillPass)}" /></div>
          </div>
          <label class="ios-check-row mt-3">
            <input type="checkbox" id="couchRememberCheck" ${rememberChecked ? 'checked' : ''} />
            <span><strong>在此已验证浏览器长期保存同步信息：</strong>验证通过后仅保存在本机浏览器，下次打开无需重新填写账号密码并自动连接同步</span>
          </label>
          <div class="settings-actions">
            <button class="button button-outline" data-action="test-couch">测试直连</button>
            <button class="button button-primary" data-action="connect-couch">直连并同步</button>
            ${syncHandler ? '<button class="button button-quiet" data-action="disconnect-couch">断开</button>' : ''}
            ${(savedCreds?.password || savedCreds?.mode === 'proxy') ? '<button class="button button-quiet" data-action="forget-couch">清除已保存连接</button>' : ''}
          </div>
          <div class="status-box ${escapeHtml(couchStatusState.variant)}" id="couchStatus">${escapeHtml(couchStatusState.text || (syncHandler ? '已连接，正在双向同步。' : (savedCreds?.mode === 'proxy' ? '当前已记忆服务端代理连接（无本地密码），可点击上方按钮立即连接。' : (savedCreds?.password ? '已在本浏览器保存通过验证的同步信息，无需重填密码，可直接点击「直连并同步」。' : (pouchMode ? '本地 PouchDB 可用。填入服务器信息后测试连接。' : '按需点击测试或连接时将自动加载同步组件。')))))}</div>
        </div>
      </details>
    </section>
  </div>`;
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

