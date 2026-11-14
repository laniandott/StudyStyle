/* StudyStyle 模块：src/review.js */

/* ===================== 卡片编辑弹窗 ===================== */
async function openCardDialog(card = null) {
  const form = $('#cardForm'); form.reset();
  form.elements.id.value = card?._id || '';
  form.elements.title.value = card?.title || '';
  form.elements.outline.value = card?.outline || '';
  const tags = cardTags(card);
  form.elements.tags.value = tags.join(', ');
  const defaultNb = card ? cardNotebook(card) : (activeNotebookFilter || Domain.DEFAULT_NOTEBOOK);
  if (form.elements.notebook) form.elements.notebook.value = defaultNb;
  if ($('#cardNotebook')) $('#cardNotebook').value = defaultNb;
  const settings = await getSetting(); const intervals = settings?.interval_days || INTERVALS;
  const defaultDue = card?.due_date || addDays(localDay(), intervals[0]);
  form.elements.due_date.value = defaultDue;
  if ($('#cardMetaFold')) $('#cardMetaFold').open = Boolean(tags.length);
  if ($('#cardMetaSummaryHint')) $('#cardMetaSummaryHint').textContent = tags.length ? `${tags.join(' · ')} · ${fmtDate(defaultDue)}` : `选填 · 默认 ${fmtDate(defaultDue)} 复习`;
  const previewEl = $('#cardOutlinePreview');
  if (previewEl) { previewEl.classList.add('hidden'); previewEl.innerHTML = ''; }
  if ($('#toggleOutlinePreview')) $('#toggleOutlinePreview').textContent = '预览效果';
  const allCards = await getCards();
  const notebooks = Domain.collectNotebooks(allCards, settings?.notebooks || [], localDay());
  if ($('#quickNotebookList')) {
    $('#quickNotebookList').innerHTML = notebooks.map(nb => `<button type="button" class="tag-chip ${nb.name === defaultNb ? 'active' : ''}" data-quick-notebook="${escapeHtml(nb.name)}"><i class="nb-dot nb-color-${nb.color}"></i> ${escapeHtml(nb.name)}</button>`).join('');
  }
  const allTags = [...new Set(allCards.flatMap(cardTags))].sort((a, b) => a.localeCompare(b, 'zh-CN'));
  if ($('#quickTagList')) {
    $('#quickTagList').innerHTML = allTags.length ? allTags.map(t => `<button type="button" class="tag-chip" data-quick-tag="${escapeHtml(t)}">+ ${escapeHtml(t)}</button>`).join('') : '';
  }
  $('#cardDialogTitle').textContent = card ? '编辑卡片' : '新增卡片'; $('#cardDialog').showModal(); $('#cardTitle').focus();
}

let isSavingCard = false;
let isSavingReview = false;

function formatDbWriteError(error, actionLabel = '保存失败') {
  const msg = String(error?.message || error || '');
  if (error?.status === 404 || error?.name === 'not_found') {
    return `${actionLabel}：目标卡片已被删除或尚未同步完成`;
  }
  if (error?.status === 409 || error?.name === 'conflict') {
    return `${actionLabel}：内容刚在其他设备被修改，请刷新后重试`;
  }
  return `${actionLabel}：${msg || '请稍后重试'}`;
}

async function saveCardFromDialog(event) {
  event.preventDefault();
  if (isSavingCard) return;
  const form = $('#cardForm');
  const title = (form.elements.title?.value || $('#cardTitle')?.value || '').trim();
  const outline = (form.elements.outline?.value || $('#cardOutline')?.value || '').trim();
  if (!title || !outline) { showToast('请填写卡片标题与大纲内容'); return; }
  const submitBtn = form.querySelector?.('button[type="submit"]');
  isSavingCard = true;
  if (submitBtn) submitBtn.disabled = true;
  try {
    const rawTags = form.elements.tags?.value || $('#cardTags')?.value || '';
    const tags = normalizeTags(rawTags);
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
  } catch (error) {
    console.error(error);
    showToast(formatDbWriteError(error, '保存卡片失败'));
  } finally {
    isSavingCard = false;
    if (submitBtn) submitBtn.disabled = false;
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
    listEl.innerHTML = `<div class="field-label mt-3">现有科目笔记本（共 ${notebooks.length} 个）</div>` + notebooks.map(nb => `<div class="notebook-manage-row ${editName === nb.name ? 'is-editing' : ''}">
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

let isSavingNotebook = false;

/** 批量切换卡片所属科目本；遇到 409 冲突时自动拉取最新 _rev 重试一次。 */
async function bulkMoveCardsNotebook(cards, targetNotebook) {
  if (!cards.length) return;
  const results = await db.bulkDocs(cards.map(card => ({ ...card, notebook: targetNotebook })));
  if (!Array.isArray(results)) return;
  for (const r of results) {
    if (!r?.error) continue;
    if (r.status === 409 || r.name === 'conflict') {
      const latest = await db.get(r.id).catch(() => null);
      if (latest && !latest._deleted) {
        await db.put({ ...latest, notebook: targetNotebook });
      }
      continue;
    }
    throw Object.assign(new Error(r.message || '批量迁移笔记本失败'), r);
  }
}

async function saveNotebookFromDialog(event) {
  event.preventDefault();
  if (isSavingNotebook) return;
  const oldName = ($('#notebookOldName')?.value || '').trim();
  const newName = Domain.normalizeNotebook($('#notebookNameInput')?.value || '');
  if (!newName) { showToast('请输入科目笔记本名称'); return; }
  const saveBtn = $('#saveNotebookBtn');
  isSavingNotebook = true;
  if (saveBtn) saveBtn.disabled = true;
  try {
    const settings = (await getSetting()) || {};
    const allCards = await getCards();
    const existing = Domain.collectNotebooks(allCards, settings.notebooks || [], localDay());
    const nextSaved = existing.map(nb => ({ name: nb.name, color: nb.color }));
    if (oldName) {
      const idx = nextSaved.findIndex(n => n.name === oldName);
      if (idx >= 0) nextSaved[idx] = { name: newName, color: selectedNotebookColor };
      else nextSaved.push({ name: newName, color: selectedNotebookColor });
      if (oldName !== newName) {
        const renamedCards = allCards.filter(card => cardNotebook(card) === oldName);
        await bulkMoveCardsNotebook(renamedCards, newName);
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
  } catch (error) {
    console.error(error);
    showToast(formatDbWriteError(error, '保存笔记本失败'));
  } finally {
    isSavingNotebook = false;
    if (saveBtn) saveBtn.disabled = false;
  }
}

async function deleteNotebook(name) {
  if (!name || name === Domain.DEFAULT_NOTEBOOK || isSavingNotebook) return;
  isSavingNotebook = true;
  try {
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
    await bulkMoveCardsNotebook(affected, Domain.DEFAULT_NOTEBOOK);
    const settings = (await getSetting()) || {};
    const nextNbs = (settings.notebooks || []).filter(item => (typeof item === 'string' ? item : item?.name) !== name);
    await saveSetting({ ...settings, notebooks: nextNbs });
    if (activeNotebookFilter === name) activeNotebookFilter = null;
    if ($('#notebookDialog')?.open) await openNotebookDialog();
    showToast(`已删除「${name}」，卡片已归入${Domain.DEFAULT_NOTEBOOK}`);
    await render();
  } catch (error) {
    console.error(error);
    showToast(formatDbWriteError(error, '删除笔记本失败'));
  } finally {
    isSavingNotebook = false;
  }
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

let isBatchCreating = false;

async function batchCreateFromMarkdown() {
  if (isBatchCreating) return;
  const raw = $('#batchMdInput')?.value || '';
  const tagStr = $('#batchMdTags')?.value || '';
  const nb = Domain.normalizeNotebook($('#batchMdNotebook')?.value || activeNotebookFilter || Domain.DEFAULT_NOTEBOOK);
  const defaultTags = normalizeTags(tagStr);
  const parsed = Domain.parseBatchMarkdownCards(raw, defaultTags, nb);
  if (!parsed.length) {
    showToast('请以 # 或 ## 标题开头输入至少一张卡片及大纲');
    return;
  }
  const btn = $('#runBatchImportBtn') || document.querySelector?.('[data-action="run-batch-import"]');
  isBatchCreating = true;
  if (btn) btn.disabled = true;
  try {
    const settings = (await getSetting()) || {};
    const intervals = settings.interval_days || INTERVALS;
    const defaultDue = addDays(localDay(), intervals[0]);
    const nowIso = new Date().toISOString();
    const savedNbs = Array.isArray(settings.notebooks) ? [...settings.notebooks] : [];
    let nbsChanged = false;
    const docs = parsed.map(item => {
      const nbName = Domain.normalizeNotebook(item.notebook ?? nb);
      if (!savedNbs.some(entry => (typeof entry === 'string' ? entry : entry?.name) === nbName)) {
        savedNbs.push({ name: nbName, color: Domain.NOTEBOOK_COLORS[savedNbs.length % Domain.NOTEBOOK_COLORS.length] });
        nbsChanged = true;
      }
      return {
        _id: `card:${uuid()}`,
        type: 'card',
        title: item.title.trim(),
        outline: item.outline.trim(),
        tags: item.tags,
        notebook: nbName,
        created_at: nowIso,
        archived_at: null,
        interval_index: 0,
        due_date: defaultDue,
        last_reviewed_at: null,
        latest_memory_score: null
      };
    });
    if (nbsChanged) await saveSetting({ ...settings, notebooks: savedNbs });
    await db.bulkDocs(docs);
    if ($('#batchMdInput')) $('#batchMdInput').value = '';
    showToast(`已成功拆分并创建 ${parsed.length} 张卡片至「${nb}」`);
    await render();
  } finally {
    isBatchCreating = false;
    if (btn) btn.disabled = false;
  }
}

function insertMarkdownFormat(mode) {
  const ta = $('#cardOutline');
  if (!ta) return;
  const start = ta.selectionStart ?? ta.value.length;
  const end = ta.selectionEnd ?? ta.value.length;
  const selected = ta.value.slice(start, end);
  let replacement = '';
  let selStartOffset = 0;
  let selEndOffset = 0;
  if (mode === 'list') {
    const prefix = start > 0 && ta.value[start - 1] !== '\n' ? '\n- ' : '- ';
    replacement = `${prefix}${selected || '要点内容'}`;
    selStartOffset = selected ? replacement.length : prefix.length;
    selEndOffset = replacement.length;
  } else if (mode === 'bold') {
    replacement = `**${selected || '重点词'}**`;
    selStartOffset = selected ? replacement.length : 2;
    selEndOffset = selected ? replacement.length : replacement.length - 2;
  } else if (mode === 'cloze') {
    replacement = `==${selected || '挖空内容'}==`;
    selStartOffset = selected ? replacement.length : 2;
    selEndOffset = selected ? replacement.length : replacement.length - 2;
  } else if (mode === 'code') {
    replacement = `\`${selected || 'code'}\``;
    selStartOffset = selected ? replacement.length : 1;
    selEndOffset = selected ? replacement.length : replacement.length - 1;
  }
  ta.value = ta.value.slice(0, start) + replacement + ta.value.slice(end);
  ta.focus();
  ta.setSelectionRange(start + selStartOffset, start + selEndOffset);
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
  const warning = $('#blankRecallWarning');
  if (warning) {
    const skippedDraft = !(firstRecallDraft || '').trim() && preselect == null;
    if (skippedDraft) {
      warning.innerHTML = '<strong>未写回忆直接翻面：</strong>哪怕只写 2–3 个关键词再核对，记忆提取效果也远好于直接默看。<button type="button" class="text-button" data-action="resume-blank-recall">回去补写回忆</button>';
      warning.classList.remove('hidden');
    } else {
      warning.innerHTML = '';
      warning.classList.add('hidden');
    }
  }
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
  const blankWarnEl = $('#blankRecallWarning');
  if (blankWarnEl) { blankWarnEl.innerHTML = ''; blankWarnEl.classList.add('hidden'); }
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
  const daysNow = intervalFor(fresh, intervals, settings);
  const stabilityTag = schedulerModeFor(settings) === 'adaptive' && Number.isFinite(Number(fresh.stability))
    ? ` · 稳定度 S=${Number(fresh.stability).toFixed(1)}天 / D=${Number(fresh.difficulty ?? 5).toFixed(1)}`
    : '';
  $('#reviewInterval').textContent = `当前周期 ${daysNow} 天${stabilityTag} · 下次到期 ${fmtDate(fresh.due_date)}`;
  $('#reviewOutline').innerHTML = markdownToHtml(fresh.outline);
  const hasCloze = Boolean($('#reviewOutline').querySelector('.cloze-mask'));
  $('#toggleAllCloze')?.classList.toggle('hidden', !hasCloze);
  $('#reviewForm').elements.recall.value = ''; $('#reviewForm').elements.note.value = '';
  if ($('#applicationAttempt')) $('#applicationAttempt').value = '';
  $('#scoreRange').value = 50; $('#scoreOutput').value = '50%';
  selectedScore = null; selectedPreset = null; lowCycleChoice = null; requeueSameSession = false; $('#saveReview').disabled = true;
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
  const passThreshold = passThresholdFor(settings);
  const defaultLow = settings?.default_low_action || 'hold';
  const today = localDay();
  const buttons = SCORE_PRESETS.map((score, index) => {
    const mode = score < passThreshold ? defaultLow : 'advance';
    let days = intervals[0];
    if (card) {
      try { days = computeReviewSchedule(card, score, mode, today, intervals, settings).days; }
      catch { days = intervals[0]; }
    }
    const selected = selectedPreset === index;
    return `<button type="button" role="radio" aria-checked="${selected}" class="score-button ${selected ? 'selected' : ''}" data-score-preset="${index}" aria-label="${score}% ${SCORE_GRADES[index]}，下次 ${days} 天">
      <kbd class="score-kbd">${index + 1}</kbd>
      <span class="score-grade"><span class="bag-dot score-dot-${index + 1}"></span>${SCORE_GRADES[index]}</span>
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
  const hint = $('#scorePreselectHint');
  if (hint) {
    const hasDraft = Boolean((firstRecallDraft || '').trim() || (feedbackRecallDraft || '').trim() || ($('#recallInput')?.value || '').trim());
    if (!hasDraft && score >= 70) {
      hint.textContent = '提醒：本次未填写书面回忆草稿；若未闭卷完整复述，请谨慎给出高分';
      hint.classList.remove('hidden');
    } else if (!hint.textContent.includes('想不起来')) {
      hint.textContent = '';
      hint.classList.add('hidden');
    }
  }
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
  const passThreshold = passThresholdFor(settings);
  const defaultLow = settings?.default_low_action || 'hold';
  const adaptiveLeap = settings?.adaptive_leap === true;
  const low = selectedScore < passThreshold;
  /* 低分策略是「每张卡」的决策：用户手动选过就沿用，否则回落到全局默认。
     直接读 radio 的 checked 会把上一张卡的选择带到下一张，必须由显式状态驱动。 */
  const mode = (low && lowCycleChoice) || (low ? defaultLow : 'advance');
  const schedule = computeReviewSchedule(card, selectedScore, mode, localDay(), intervals, settings);
  const keepCheckbox = $('input[name="keepRandomDue"]');
  const keepDue = reviewMode === 'random' ? (keepCheckbox ? keepCheckbox.checked : card.due_date > localDay()) : false;
  const leaped = !low && adaptiveLeap && selectedScore >= 85 && (schedule.intervalIndex - card.interval_index >= 2 || schedule.schedulerMode === 'adaptive');
  const action = mode === 'hold'
    ? '保持当前稳定度档位'
    : mode === 'reset'
      ? (schedule.schedulerMode === 'adaptive' ? '遗忘软回退重新巩固' : '重置至 1 天')
      : schedule.schedulerMode === 'adaptive'
        ? (leaped ? '高分自适应加速间隔' : '自适应延长间隔')
        : (leaped ? '高分跳级至下两档' : '升至下一档');
  $('#scoreNextHint').textContent = `${BAG_NAMES[schedule.bag]} · ${selectedScore}%`;
  const summaryText = keepDue
    ? `保存后进入 <strong>${BAG_NAMES[schedule.bag]}</strong>，仅自测巩固，保持原到期日 <strong>${fmtDate(card.due_date, { year: 'numeric', month: 'long', day: 'numeric' })}</strong>`
    : `保存后进入 <strong>${BAG_NAMES[schedule.bag]}</strong>，${action}（${schedule.days} 天），下次复习 <strong>${fmtDate(schedule.dueDate, { year: 'numeric', month: 'long', day: 'numeric' })}</strong>`;
  const adaptiveMetaHtml = (!keepDue && schedule.schedulerMode === 'adaptive' && Number.isFinite(Number(schedule.stability)))
    ? `<div class="field-note mt-15">记忆参数预估：稳定度 S=${Number(schedule.stability).toFixed(1)} 天 · 难度 D=${Number(schedule.difficulty).toFixed(1)}/10 · 累计巩固 ${Number(schedule.reps || 0)} 次${schedule.lapses ? `（遗忘 ${Number(schedule.lapses)} 次）` : ''}</div>`
    : '';
  const lowOptionsHtml = (!keepDue && low) ? `<div class="schedule-options">
    <label class="schedule-option"><input type="radio" name="lowCycle" value="hold" ${mode === 'hold' ? 'checked' : ''} /><span><strong>保持当前周期</strong><small>不再往后延，下次仍按当前稳定周期巩固</small></span></label>
    <label class="schedule-option"><input type="radio" name="lowCycle" value="reset" ${mode === 'reset' ? 'checked' : ''} /><span><strong>重置 / 软回退重新巩固</strong><small>按低分软回退大幅缩短间隔，尽快再复习这一张</small></span></label>
    <label class="schedule-option"><input type="radio" name="lowCycle" value="advance" ${mode === 'advance' ? 'checked' : ''} /><span><strong>照常延后</strong><small>即使没过线也按常规轻微延后一轮</small></span></label>
    ${reviewMode !== 'random' ? `<label class="schedule-option"><input type="checkbox" name="requeueSameSession" value="1" ${requeueSameSession ? 'checked' : ''} /><span><strong>本轮稍后再抽查一遍（错题回炉）</strong><small>保存本次评分后，将该卡追加到本轮队列末尾再次巩固</small></span></label>` : ''}
  </div>` : '';
  const randomOptionHtml = reviewMode === 'random' ? `<div class="schedule-options"><label class="schedule-option"><input type="checkbox" name="keepRandomDue" value="1" ${keepDue ? 'checked' : ''} /><span><strong>仅更新记忆等级，保持原定到期日（${fmtDate(card.due_date)}）</strong><small>随机抽卡只做自测，不改变排期</small></span></label></div>` : '';
  $('#schedulePreview').innerHTML = `${summaryText}${adaptiveMetaHtml}${lowOptionsHtml}${randomOptionHtml}`;
}

async function commitCardAndReview(card, review, schedulePatch) {
  const results = await db.bulkDocs([card, review]);
  if (!Array.isArray(results) || !results.some(r => r?.error)) return;
  const cardErr = results.find(r => r?.id === card._id && r?.error);
  const reviewErr = results.find(r => r?.id === review._id && r?.error);
  if (cardErr && (cardErr.status === 409 || cardErr.name === 'conflict')) {
    const latest = await db.get(card._id);
    const mergedCard = { ...latest, ...schedulePatch, _id: latest._id, _rev: latest._rev };
    if (reviewErr) {
      const retry = await db.bulkDocs([mergedCard, review]);
      const failed = Array.isArray(retry) && retry.find(r => r?.error);
      if (failed) throw Object.assign(new Error(failed.message || '写入冲突重试失败'), failed);
    } else {
      await db.put(mergedCard);
    }
    return;
  }
  const firstErr = cardErr || reviewErr;
  throw Object.assign(new Error(firstErr.message || '写入失败'), firstErr);
}

async function saveReview(event) {
  event.preventDefault();
  if (isSavingReview || selectedScore == null || !reviewQueue[reviewIndex]) return;
  isSavingReview = true;
  const saveBtn = $('#saveReview');
  const finishBtn = $('#saveAndFinishRandom');
  if (saveBtn) saveBtn.disabled = true;
  if (finishBtn) finishBtn.disabled = true;
  try {
    const card = await db.get(reviewQueue[reviewIndex]._id);
    const cardBefore = { ...card };
    const settings = await getSetting();
    const intervals = settings?.interval_days || INTERVALS;
    const passThreshold = passThresholdFor(settings);
    const defaultLow = settings?.default_low_action || 'hold';
    const reviewedAt = new Date().toISOString();
    const keepDue = reviewMode === 'random' && Boolean($('input[name="keepRandomDue"]')?.checked);
    const isLowScore = selectedScore < passThreshold;
    const mode = (isLowScore && lowCycleChoice) || (isLowScore ? defaultLow : 'advance');
    const schedule = computeReviewSchedule(card, selectedScore, mode, localDay(new Date(reviewedAt)), intervals, settings);
    const nextIntervalIndex = keepDue ? card.interval_index : schedule.intervalIndex;
    const nextDays = keepDue ? intervalFor(card, intervals, settings) : schedule.days;
    const nextDueDate = keepDue ? card.due_date : schedule.dueDate;
    const durationSec = cardReviewStartedAt ? Math.max(1, Math.round((Date.now() - cardReviewStartedAt) / 1000)) : null;
    const recallValue = $('#reviewForm').elements.recall.value;
    const review = {
      _id: `review:${uuid()}`, type: 'review', card_id: card._id, reviewed_at: reviewedAt,
      memory_score: selectedScore, bag_after: schedule.bag + 1,
      interval_days_before: intervalFor(card, intervals, settings), interval_days_after: nextDays,
      next_due_date: nextDueDate, duration_sec: durationSec,
      stability_after: schedule.stability ?? null, difficulty_after: schedule.difficulty ?? null,
      recall_draft: firstRecallDraft ?? recallValue, recall_after_feedback: feedbackRecallDraft,
      note: $('#reviewForm').elements.note.value.trim(), application_attempt: $('#applicationAttempt')?.value.trim() || ''
    };
    const schedulePatch = {
      latest_memory_score: selectedScore,
      interval_index: nextIntervalIndex,
      due_date: nextDueDate,
      last_reviewed_at: reviewedAt,
      ...( !keepDue && schedule.schedulerMode === 'adaptive' ? {
        stability: schedule.stability,
        difficulty: schedule.difficulty,
        reps: schedule.reps,
        lapses: schedule.lapses,
        next_interval_days: schedule.days
      } : {} )
    };
    Object.assign(card, schedulePatch);
    await commitCardAndReview(card, review, schedulePatch);
    const shouldRequeue = reviewMode !== 'random' && !keepDue && isLowScore && (requeueSameSession || Boolean($('input[name="requeueSameSession"]')?.checked));
    requeueSameSession = false;
    if (shouldRequeue) reviewQueue.push({ ...card });
    lastReviewSnapshot = { cardBefore, reviewId: review._id, mode: reviewMode, requeued: shouldRequeue };
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
    if (shouldRequeue) showToast(`已将《${card.title}》加入本轮末尾再抽查`, true);
    await showReviewCard();
  } catch (error) {
    console.error(error);
    showToast(formatDbWriteError(error, '保存复习记录失败'));
  } finally {
    isSavingReview = false;
    finishAfterSave = false;
    if (saveBtn) saveBtn.disabled = selectedScore == null;
    if (finishBtn) finishBtn.disabled = selectedScore == null;
  }
}

/* 第 2 步「跳过这张」：记 10% 并把到期日设为明天（带防连击锁与随机模式续抽） */
async function skipCurrentCard() {
  if (isSavingReview || !reviewQueue[reviewIndex]) return;
  isSavingReview = true;
  const skipBtn = $('#skipCard');
  if (skipBtn) skipBtn.disabled = true;
  try {
    const card = await db.get(reviewQueue[reviewIndex]._id);
    const cardBefore = { ...card };
    const settings = await getSetting();
    const intervals = settings?.interval_days || INTERVALS;
    const reviewedAt = new Date().toISOString();
    const schedule = computeReviewSchedule(card, 10, 'reset', localDay(new Date(reviewedAt)), intervals, settings);
    const review = {
      _id: `review:${uuid()}`, type: 'review', card_id: card._id, reviewed_at: reviewedAt, memory_score: 10,
      bag_after: schedule.bag + 1, interval_days_before: intervalFor(card, intervals, settings), interval_days_after: schedule.days,
      next_due_date: schedule.dueDate, stability_after: schedule.stability ?? null, difficulty_after: schedule.difficulty ?? null,
      duration_sec: cardReviewStartedAt ? Math.max(1, Math.round((Date.now() - cardReviewStartedAt) / 1000)) : null,
      recall_draft: firstRecallDraft ?? $('#reviewForm').elements.recall.value, recall_after_feedback: feedbackRecallDraft, note: '跳过本张，明天再复习'
    };
    const schedulePatch = {
      latest_memory_score: 10,
      interval_index: schedule.intervalIndex,
      due_date: schedule.dueDate,
      last_reviewed_at: reviewedAt,
      ...(schedule.schedulerMode === 'adaptive' ? {
        stability: schedule.stability,
        difficulty: schedule.difficulty,
        reps: schedule.reps,
        lapses: schedule.lapses,
        next_interval_days: schedule.days
      } : {})
    };
    Object.assign(card, schedulePatch);
    await commitCardAndReview(card, review, schedulePatch);
    lastReviewSnapshot = { cardBefore, reviewId: review._id, mode: reviewMode, requeued: false };
    if (reviewMode === 'random') {
      const freshPool = await getCards();
      const poolIds = new Set(randomPool.map(item => item._id));
      randomPool = freshPool.filter(item => poolIds.has(item._id));
      if (!randomPool.length) {
        $('#reviewDialog').close(); showToast(`已跳过《${card.title}》，明天再复习`, true); await render(); return;
      }
      const nextCard = Domain.pickRandomCard(randomPool, card._id);
      reviewQueue = [nextCard]; reviewIndex = 0; randomDrawCount++;
      showToast(`已跳过《${card.title}》，为您抽出下一张`, true);
      await showReviewCard(); await render(); return;
    }
    showToast(`已跳过《${card.title}》，明天再复习`, true);
    reviewIndex++;
    if (reviewIndex >= reviewQueue.length) { $('#reviewDialog').close(); showToast('今天的复习完成', true); await render(); return; }
    await showReviewCard();
  } catch (error) {
    console.error(error);
    showToast(formatDbWriteError(error, '跳过卡片失败'));
  } finally {
    isSavingReview = false;
    if (skipBtn) skipBtn.disabled = false;
  }
}

async function undoLastReview() {
  if (!lastReviewSnapshot || isSavingReview) return;
  isSavingReview = true;
  try {
    const { cardBefore, reviewId, requeued } = lastReviewSnapshot;
    const currentCard = await db.get(cardBefore._id).catch(() => null);
    if (!currentCard || currentCard._deleted) {
      throw Object.assign(new Error('目标卡片已被删除'), { status: 404, name: 'not_found' });
    }
    const revDoc = await db.get(reviewId).catch(() => null);
    const nowIso = new Date().toISOString();
    const docsToApply = [{ ...cardBefore, _rev: currentCard._rev }];
    if (revDoc && !revDoc._deleted) {
      docsToApply.push({ _id: revDoc._id, _rev: revDoc._rev, _deleted: true, updated_at: nowIso, deleted_at: nowIso });
    }
    const results = await db.bulkDocs(docsToApply);
    if (Array.isArray(results)) {
      for (const r of results) {
        if (!r?.error) continue;
        if (r.status === 409 || r.name === 'conflict') {
          if (r.id === cardBefore._id) {
            const latest = await db.get(cardBefore._id).catch(() => null);
            if (!latest || latest._deleted) {
              throw Object.assign(new Error('目标卡片已被删除'), { status: 404, name: 'not_found' });
            }
            await db.put({ ...cardBefore, _rev: latest._rev });
          } else if (r.id === reviewId) {
            const latestRev = await db.get(reviewId).catch(() => null);
            if (latestRev && !latestRev._deleted) {
              await db.put({ _id: latestRev._id, _rev: latestRev._rev, _deleted: true, updated_at: nowIso, deleted_at: nowIso });
            }
          }
          continue;
        }
        throw Object.assign(new Error(r.message || '撤销写入失败'), r);
      }
    }
    // 只有写回成功后才清空撤销快照，避免中途报错丢失撤销机会
    lastReviewSnapshot = null;
    showToast(`已撤销《${cardBefore.title}》的打分`);
    await render();
    if ($('#reviewDialog')?.open) {
      const restored = await db.get(cardBefore._id).catch(() => null);
      if (!restored || restored._deleted) {
        $('#reviewDialog').close();
        return;
      }
      if (reviewMode === 'random' || !reviewQueue.length) {
        reviewQueue = [restored];
        reviewIndex = 0;
      } else {
        if (requeued && reviewQueue.length > 1 && reviewQueue[reviewQueue.length - 1]?._id === cardBefore._id) {
          reviewQueue.pop();
        }
        if (reviewIndex > 0 && reviewQueue[reviewIndex - 1]?._id === cardBefore._id) {
          reviewIndex--;
          reviewQueue[reviewIndex] = restored;
        } else if (reviewQueue[reviewIndex]?._id === cardBefore._id) {
          reviewQueue[reviewIndex] = restored;
        } else {
          reviewQueue.splice(reviewIndex, 0, restored);
        }
      }
      await showReviewCard();
    }
  } catch (error) {
    console.error(error);
    showToast(formatDbWriteError(error, '撤销复习失败'));
  } finally {
    isSavingReview = false;
  }
}


/* 学习法轮换（M 键） */
function cycleStudyMethod() {
  const keys = Object.keys(Domain.STUDY_METHODS || {});
  if (!keys.length) return;
  const index = keys.indexOf(activeStudyMethod);
  const next = keys[(index + 1) % keys.length];
  applyStudyMethodUI(next, reviewQueue[reviewIndex]);
  getSetting()
    .then(s => { if (s) return saveSetting({ ...s, study_method: next }); })
    .catch(err => console.error('保存学习法设置失败:', err));
}

