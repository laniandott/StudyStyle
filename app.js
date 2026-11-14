/* StudyStyle 应用入口：事件绑定、快捷键流、生命周期与启动 */

async function openCurrentReviewCardEditor() {
  const cur = reviewQueue[reviewIndex];
  if (!cur) return;
  const freshCard = await db.get(cur._id).catch(() => null);
  if (!freshCard || freshCard._deleted) {
    showToast('当前卡片已被删除或尚未同步完成');
    return;
  }
  await openCardDialog(freshCard);
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
    if (target.closest('#editInReviewButton')) { await openCurrentReviewCardEditor(); return; }
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
      const targets = (await allDocs()).filter(c => c.type === 'card' && selectedCardIds.has(c._id)).map(c => ({ ...c, notebook: targetNb }));
      if (targets.length) await db.bulkDocs(targets);
      showToast(`已将 ${targets.length} 张卡片移入「${targetNb}」`);
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
      const targets = (await allDocs()).filter(c => c.type === 'card' && selectedCardIds.has(c._id)).map(c => ({ ...c, due_date: today }));
      if (targets.length) await db.bulkDocs(targets);
      showToast(`已将 ${targets.length} 张卡片设为今日到期`);
      selectedCardIds.clear(); batchMode = false; await render(); return;
    }
    if (action === 'batch-archive') {
      if (!selectedCardIds.size) return;
      const yes = await askConfirm('批量归档卡片', `确定将选中的 ${selectedCardIds.size} 张卡片移入归档区？`, '批量归档');
      if (yes) {
        const nowIso = new Date().toISOString();
        const targets = (await allDocs()).filter(c => c.type === 'card' && !c.archived_at && selectedCardIds.has(c._id)).map(c => ({ ...c, archived_at: nowIso }));
        if (targets.length) await db.bulkDocs(targets);
        selectedCardIds.clear(); batchMode = false; await render(); showToast(`已批量归档 ${targets.length} 张卡片`);
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
    if (action === 'clear-filter') { activeBagFilter = null; await render(); return; }
    if (action === 'clear-filters') { libraryFilter = { ...libraryFilter, query: '', tag: 'all', status: 'all', sort: 'due' }; activeBagFilter = null; await render(); return; }
    if (action === 'clear-history-filter') { activeHistoryCardFilter = null; historyVisibleLimit = 120; await render(); return; }
    if (action === 'load-more-history') { historyVisibleLimit += 120; await render(); return; }
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
    if (action === 'snooze') { await snoozeDue(); return; }
    if (action === 'export') { await exportData(); return; }
    if (action === 'import') { $('#importFile').click(); return; }
    if (action === 'test-couch') { await connectCouch(true); return; }
    if (action === 'connect-couch') { await connectCouch(false); return; }
    if (action === 'test-couch-proxy') { await connectCouch(true, null, true); return; }
    if (action === 'connect-couch-proxy') { await connectCouch(false, null, true); return; }
    if (action === 'disconnect-couch') { await disconnectCouch(); return; }
    if (action === 'forget-couch') { await forgetSavedCouch(); return; }
    if (action === 'resume-blank-recall') {
      firstRecallDraft = null;
      const warn = $('#blankRecallWarning');
      if (warn) { warn.innerHTML = ''; warn.classList.add('hidden'); }
      setReviewStep(1);
      return;
    }
    if (action === 'save-store-token') {
      const tokenVal = $('#serverTokenInput')?.value?.trim() || '';
      saveStoreToken(tokenVal);
      tokenPrompted = false;
      await hydrateFromServerStore();
      await refreshCouchProxyStatus();
      if (!serverTokenRequired) void resumeSavedCouchSync();
      showToast(serverTokenRequired ? '令牌无效，服务端仍返回 401' : (tokenVal ? '访问令牌已保存并同步' : '已保存空令牌'));
      await render();
      return;
    }
    if (action === 'clear-store-token') {
      saveStoreToken('');
      serverTokenRequired = false;
      tokenPrompted = false;
      await hydrateFromServerStore({ incremental: Boolean(serverRev && serverBaselineKnown) });
      await refreshCouchProxyStatus();
      showToast('已清除本机保存的访问令牌');
      await render();
      return;
    }
    if (action === 'save-intervals') {
      const daysInput = $('#intervalDays');
      const fallback = daysInput ? [] : ((await getSetting())?.interval_days || INTERVALS);
      const values = daysInput ? daysInput.value.split(',').map(value => value.trim()).filter(Boolean).map(Number) : fallback;
      const valid = values.length > 0 && values[0] === 1 && values.every((value, index) => Number.isInteger(value) && value > 0 && value <= 365 && (index === 0 || value > values[index - 1]));
      if (!valid) { showToast('周期需从 1 天开始，之后使用严格递增的 1–365 天整数'); return; }
      const schedulerMode = $('#schedulerModeSelect')?.value === 'ladder' ? 'ladder' : 'adaptive';
      const passThreshold = Number($('#passThresholdSelect')?.value ?? (schedulerMode === 'adaptive' ? 60 : 40));
      const defaultLowAction = $('#lowActionSelect')?.value || 'hold';
      const adaptiveLeap = $('#adaptiveLeapCheck') ? Boolean($('#adaptiveLeapCheck').checked) : false;
      const dailyLimit = Number($('#dailyLimitSelect')?.value ?? 25);
      const studyMethod = $('#defaultStudyMethodSelect')?.value || 'blurting';
      activeStudyMethod = studyMethod;
      const settings = await getSetting();
      await saveSetting({
        ...settings,
        scheduler_mode: schedulerMode,
        interval_days: values,
        hold_interval_below_score: passThreshold,
        default_low_action: defaultLowAction,
        adaptive_leap: adaptiveLeap,
        daily_review_limit: dailyLimit,
        study_method: studyMethod
      });
      showToast('基础调度规则与学习方法设定已保存');
      await render();
      return;
    }
    const edit = target.closest('[data-edit]'); if (edit) { closeAllRowMenus(); await openCardDialog(await db.get(edit.dataset.edit)); return; }
    const archive = target.closest('[data-archive]'); if (archive) { closeAllRowMenus(); const yes = await askConfirm('归档卡片', '归档后卡片会从复习池移出，可在卡片库底部恢复。', '归档'); if (yes) { await archiveCard(archive.dataset.archive); await render(); showToast('卡片已归档'); } return; }
    const restore = target.closest('[data-restore]'); if (restore) { await archiveCard(restore.dataset.restore, true); await render(); showToast('卡片已恢复'); return; }
    const del = target.closest('[data-delete]'); if (del) { closeAllRowMenus(); const yes = await askConfirm('彻底删除卡片', '删除后卡片及其所有复习历史记录将被永久移除，确定继续？', '彻底删除'); if (yes) { await deleteCard(del.dataset.delete); await render(); showToast('卡片已删除'); } return; }
    const preset = target.closest('[data-score-preset]'); if (preset) { const i = Number(preset.dataset.scorePreset); selectScore(SCORE_PRESETS[i], i); return; }
  } catch (err) {
    console.error(err);
    const errText = err?.message || (err?.status === 404 ? '目标记录不存在或已被删除' : String(err));
    showToast(`操作出错：${errText}`);
  }
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
  if (event.target.name === 'requeueSameSession') { requeueSameSession = Boolean(event.target.checked); return; }
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
/* ===================== 键盘流 ===================== */
const isTypingTarget = target => Boolean(target && target.matches && target.matches('input, textarea, select, [contenteditable="true"]'));

document.addEventListener('keydown', async event => {
  if (event.isComposing) return;
  try {
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
      if ((event.key === 'e' || event.key === 'E')) {
        event.preventDefault();
        await openCurrentReviewCardEditor();
        return;
      }
      if ((event.key === 'u' || event.key === 'U')) { event.preventDefault(); await undoLastReview(); return; }
      if ((event.key === 'r' || event.key === 'R') && reviewMode === 'random' && !$('#rerollRandomCard')?.classList.contains('hidden')) { event.preventDefault(); rerollRandomCard(); return; }
      if (event.key === 'Escape') { event.preventDefault(); dialog.close(); return; }
      return;
    }

    /* 弹窗之外：Esc 退出批量 / 关闭上限选择 / 收起抽屉 */
    if (event.key === 'Escape') {
      const popover = $('.limit-popover');
      if (popover) { popover.remove(); return; }
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
  } catch (error) {
    console.error(error);
    showToast(error?.message || '快捷键操作失败');
  }
});
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
  await hydrateFromServerStore({ incremental: Boolean(serverRev && serverBaselineKnown) });
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
/* 页面隐藏前立即冲刷待推送数据；切回前台时增量拉取服务端新变化，仅当确有数据变更且未中断弹窗作答时重绘 */
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') flushServerStore({ keepalive: true });
  else if (document.visibilityState === 'visible' && navigator.onLine !== false) {
    void hydrateFromServerStore({ incremental: true }).then(res => {
      if (!res?.changed) return;
      if ($('#reviewDialog')?.open || $('#cardDialog')?.open) return;
      return render();
    });
    void resumeSavedCouchSync();
  }
});
window.addEventListener('pagehide', () => flushServerStore({ keepalive: true }));
window.addEventListener('beforeunload', () => flushServerStore({ keepalive: true }));
setInterval(() => { const currentDay = localDay(); if (currentDay === observedDay) return; observedDay = currentDay; if ($('#reviewDialog').open) pendingDayRefresh = true; else render(); }, 60000);
initStore().catch(error => { console.error(error); $('#viewRoot').innerHTML = `<div class="empty-state"><div class="empty-symbol">${icon('warning', 'icon icon-24')}</div><h3>应用启动失败</h3><p>${escapeHtml(error.message || '未知错误')}</p><div class="empty-actions"><button class="button button-primary" data-action="reload">重新加载</button></div></div>`; });
