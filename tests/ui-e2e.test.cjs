const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

function findBrowserExecutable() {
  const candidates = [
    process.env.CHROME_PATH,
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'
  ].filter(Boolean);
  return candidates.find(p => fs.existsSync(p)) || null;
}

async function launchBrowser(executablePath, profileDir) {
  const proc = spawn(executablePath, [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--no-first-run',
    '--no-default-browser-check',
    '--remote-debugging-port=0',
    `--user-data-dir=${profileDir}`,
    '--window-size=1280,800',
    'about:blank'
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  const wsEndpoint = await new Promise((resolve, reject) => {
    let logs = '';
    const timer = setTimeout(() => reject(new Error(`Browser launch timed out: ${logs.slice(0, 400)}`)), 12000);
    const onData = chunk => {
      logs += chunk.toString('utf8');
      const match = logs.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (match) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    };
    proc.stderr.on('data', onData);
    proc.stdout.on('data', onData);
    proc.once('exit', code => {
      clearTimeout(timer);
      reject(new Error(`Browser exited early with code ${code}: ${logs.slice(0, 400)}`));
    });
  });

  const debugOrigin = wsEndpoint.replace(/^ws:/, 'http:').replace(/\/devtools\/.*$/, '');
  const targets = await (await fetch(`${debugOrigin}/json/list`)).json();
  const pageTarget = targets.find(t => t.type === 'page') || targets[0];
  assert.ok(pageTarget?.webSocketDebuggerUrl, 'Expected page DevTools WebSocket URL');

  const ws = new WebSocket(pageTarget.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', err => reject(new Error(`CDP WebSocket error: ${err.message || err}`)), { once: true });
  });

  let nextId = 1;
  const pending = new Map();
  const exceptions = [];
  const loadWaiters = new Set();

  ws.addEventListener('message', event => {
    const msg = JSON.parse(String(event.data));
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(`CDP ${msg.method || msg.id}: ${msg.error.message}`));
      else resolve(msg.result);
    } else if (msg.method === 'Runtime.exceptionThrown') {
      const details = msg.params?.exceptionDetails;
      exceptions.push(details?.exception?.description || details?.text || 'Runtime exception');
    } else if (msg.method === 'Page.loadEventFired') {
      for (const resolve of loadWaiters) resolve();
      loadWaiters.clear();
    }
  });

  function waitForLoad(action) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        loadWaiters.delete(done);
        reject(new Error('Page.loadEventFired timed out'));
      }, 10000);
      const done = () => { clearTimeout(timer); resolve(); };
      loadWaiters.add(done);
      Promise.resolve(action()).catch(err => {
        clearTimeout(timer);
        loadWaiters.delete(done);
        reject(err);
      });
    });
  }

  function send(method, params = {}) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`CDP call timed out: ${method}`));
      }, 10000);
      pending.set(id, {
        resolve: res => { clearTimeout(timer); resolve(res); },
        reject: err => { clearTimeout(timer); reject(err); }
      });
      ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async function evaluate(expression) {
    const res = await send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true
    });
    if (res?.exceptionDetails) {
      throw new Error(`Page eval error: ${res.exceptionDetails.exception?.description || res.exceptionDetails.text}`);
    }
    return res?.result?.value;
  }

  await send('Page.enable');
  await send('Runtime.enable');

  return {
    send,
    evaluate,
    navigate: url => waitForLoad(() => send('Page.navigate', { url })),
    reload: (ignoreCache = false) => waitForLoad(() => send('Page.reload', { ignoreCache })),
    exceptions,
    async close() {
      try { await Promise.race([send('Browser.close'), new Promise(r => setTimeout(r, 800))]); } catch {}
      try { ws.close(); } catch {}
      try { proc.stdout?.destroy(); } catch {}
      try { proc.stderr?.destroy(); } catch {}
      try { proc.kill('SIGKILL'); } catch {}
      proc.unref();
      await new Promise(resolve => {
        const t = setTimeout(resolve, 600);
        proc.once('exit', () => { clearTimeout(t); resolve(); });
      });
    }
  };
}

test('真浏览器响应式 UI 与悬浮操作菜单回归（Desktop 1280x800 / Mobile 390x844 & 540x900）', async t => {
  const browserBin = findBrowserExecutable();
  if (!browserBin) {
    t.skip('未检测到 Chrome / Edge，跳过真浏览器 UI 测试');
    return;
  }
  if (typeof globalThis.WebSocket !== 'function') {
    t.skip('当前 Node 版本未内置 WebSocket，跳过 CDP UI 测试');
    return;
  }

  const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'studystyle-ui-data-'));
  const tmpProfile = fs.mkdtempSync(path.join(os.tmpdir(), 'studystyle-ui-prof-'));
  t.after(() => {
    try { fs.rmSync(tmpData, { recursive: true, force: true, maxRetries: 8, retryDelay: 80 }); } catch {}
    try { fs.rmSync(tmpProfile, { recursive: true, force: true, maxRetries: 8, retryDelay: 80 }); } catch {}
  });

  const { createStudyStyleServer } = await import('../server.mjs');
  const srv = createStudyStyleServer({
    dataDir: tmpData,
    logger: { log() {}, error() {} }
  });
  await new Promise(resolve => srv.listen(0, '127.0.0.1', resolve));
  const port = srv.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;
  t.after(() => new Promise(resolve => {
    srv.closeAllConnections?.();
    srv.close(resolve);
  }));

  const today = new Date().toISOString().slice(0, 10);
  const putSeed = await fetch(`${baseUrl}/api/store`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      docs: [
        {
          _id: 'settings:main',
          type: 'settings',
          scheduler_mode: 'adaptive',
          adaptive_leap: false,
          daily_review_limit: 25,
          study_method: 'blurting',
          theme: 'light',
          updated_at: new Date().toISOString()
        },
        {
          _id: 'card:e2e-1',
          type: 'card',
          title: 'CDP 端到端测试卡片一',
          outline: '- **主动回忆** 验证',
          notebook: '系统测试',
          tags: ['E2E'],
          interval_index: 0,
          due_date: today,
          latest_memory_score: null,
          archived_at: null,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        },
        {
          _id: 'card:e2e-2',
          type: 'card',
          title: 'CDP 端到端测试卡片二',
          outline: '- ==悬浮菜单== 命中测试\n  - 二级要点\n    - 三级要点',
          notebook: '系统测试',
          tags: ['E2E'],
          interval_index: 1,
          due_date: today,
          latest_memory_score: 65,
          archived_at: null,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        }
      ]
    })
  });
  assert.equal(putSeed.status, 200);

  const browser = await launchBrowser(browserBin, tmpProfile);
  t.after(() => browser.close());

  await browser.send('Page.navigate', { url: `${baseUrl}/` });
  await browser.evaluate(`new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      const text = document.querySelector('#viewRoot')?.textContent || '';
      if (text.includes('CDP 端到端测试卡片一')) return resolve(true);
      if (Date.now() - start > 6000) return reject(new Error('页面渲染超时: ' + text.slice(0, 200)));
      setTimeout(tick, 40);
    };
    tick();
  })`);

  // 1) Desktop 1280x800 验证：侧栏、主内容区无溢出，全部视图无异常
  const desktopCheck = await browser.evaluate(`(async () => {
    const overflow = document.documentElement.scrollWidth > window.innerWidth + 1;
    const sidebar = document.querySelector('.sidebar')?.getBoundingClientRect();
    const main = document.querySelector('.main-area')?.getBoundingClientRect();
    document.querySelector('[data-view="library"]')?.click();
    await new Promise(r => setTimeout(r, 80));
    const libTitle = document.querySelector('#viewRoot h1')?.textContent || '';
    const rows = document.querySelectorAll('.library-row[data-card-row]').length;
    document.querySelector('.library-title-btn[data-toggle-card="card:e2e-2"]')?.click();
    await new Promise(r => setTimeout(r, 40));
    const indentMargins = [...document.querySelectorAll('[data-card-row="card:e2e-2"] .library-outline-drawer li')]
      .map(li => parseFloat(getComputedStyle(li).marginLeft));
    return {
      overflow,
      sidebarWidth: sidebar?.width || 0,
      mainLeft: main?.left || 0,
      libTitle,
      rows,
      indentMargins
    };
  })()`);
  assert.equal(desktopCheck.overflow, false, '桌面端不应存在横向滚动溢出');
  assert.ok(desktopCheck.sidebarWidth >= 180, '桌面端侧栏宽度应展开');
  assert.ok(desktopCheck.mainLeft >= desktopCheck.sidebarWidth - 1, '桌面端主区域不得被侧栏遮挡');
  assert.match(desktopCheck.libTitle, /全部卡片/);
  assert.equal(desktopCheck.rows, 2);
  assert.deepEqual(desktopCheck.indentMargins, [0, 16, 32], '卡片大纲预览抽屉的嵌套列表必须渲染出递进缩进');

  // 2) Mobile 390x844 验证：底部导航、无横向溢出、⋯ 悬浮菜单不遮挡 & elementFromPoint 真实命中删除并确认删除
  await browser.send('Emulation.setDeviceMetricsOverride', {
    width: 390,
    height: 844,
    deviceScaleFactor: 2,
    mobile: true
  });
  await new Promise(r => setTimeout(r, 80));

  const mobileMenuProbe = await browser.evaluate(`(async () => {
    const overflow = document.documentElement.scrollWidth > window.innerWidth + 1;
    const sidebar = document.querySelector('.sidebar')?.getBoundingClientRect();
    const navRects = [...document.querySelectorAll('.sidebar .nav-item')].map(el => {
      const r = el.getBoundingClientRect();
      return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height };
    });
    const moreBtn = document.querySelector('.library-row [data-more-menu="card:e2e-2"]');
    moreBtn.click();
    await new Promise(r => setTimeout(r, 50));
    const layer = document.querySelector('#floatingRowMenuLayer');
    const menu = document.querySelector('#floatingRowMenu');
    const delBtn = menu?.querySelector('[data-delete="card:e2e-2"]');
    const delRect = delBtn?.getBoundingClientRect();
    const menuRect = menu?.getBoundingClientRect();
    const cx = delRect ? delRect.left + delRect.width / 2 : -1;
    const cy = delRect ? delRect.top + delRect.height / 2 : -1;
    const hitEl = (cx >= 0 && cy >= 0) ? document.elementFromPoint(cx, cy) : null;
    const hitDelete = Boolean(hitEl && hitEl.closest('[data-delete="card:e2e-2"]'));
    return {
      overflow,
      sidebarTop: sidebar?.top || 0,
      sidebarBottom: sidebar?.bottom || 0,
      navCount: navRects.length,
      navAllValid: navRects.every(r => r.width >= 36 && r.height >= 36 && r.left >= 0 && r.right <= 391),
      layerHidden: layer?.classList.contains('hidden'),
      menuRect: menuRect ? { left: menuRect.left, right: menuRect.right, top: menuRect.top, bottom: menuRect.bottom } : null,
      hitDelete
    };
  })()`);

  assert.equal(mobileMenuProbe.overflow, false, 'Mobile 390x844 不应横向溢出');
  assert.ok(mobileMenuProbe.sidebarTop > 700 && mobileMenuProbe.sidebarBottom <= 845, 'Mobile 侧栏应停靠在底部');
  assert.equal(mobileMenuProbe.navCount, 3);
  assert.equal(mobileMenuProbe.navAllValid, true, 'Mobile 底部 3 个导航项必须完整落在视口内');
  assert.equal(mobileMenuProbe.layerHidden, false, '点击 ⋯ 后悬浮菜单层必须显示');
  assert.ok(
    mobileMenuProbe.menuRect &&
    mobileMenuProbe.menuRect.left >= 0 &&
    mobileMenuProbe.menuRect.right <= 390 &&
    mobileMenuProbe.menuRect.bottom <= 844 - 50,
    `悬浮菜单必须处于安全视口区内，实际: ${JSON.stringify(mobileMenuProbe.menuRect)}`
  );
  assert.equal(mobileMenuProbe.hitDelete, true, 'elementFromPoint 必须直接命中悬浮菜单中的删除按钮，不得被底层卡片/纸板遮挡');

  // 实际点击删除并确认，等待落盘到服务端
  await browser.evaluate(`(async () => {
    document.querySelector('#floatingRowMenu [data-delete="card:e2e-2"]').click();
    await new Promise(r => setTimeout(r, 40));
    if (!document.querySelector('#confirmDialog')?.open) throw new Error('删除确认框未打开');
    document.querySelector('#confirmAction').click();
    await new Promise(r => setTimeout(r, 450));
  })()`);

  const rowsAfterDelete = await browser.evaluate(`document.querySelectorAll('.library-row[data-card-row]').length`);
  assert.equal(rowsAfterDelete, 1, '删除后卡片库列表应只剩 1 张卡');

  const srvAfterDelete = await (await fetch(`${baseUrl}/api/store`)).json();
  const deletedDoc = srvAfterDelete.docs.find(d => d._id === 'card:e2e-2');
  assert.equal(deletedDoc?._deleted, true, '真浏览器删除卡片必须向服务端传播墓碑');

  // 3) 540x900 视口切换 4 个主视图 + 切换深色主题均不溢出、无报错
  await browser.send('Emulation.setDeviceMetricsOverride', {
    width: 540,
    height: 900,
    deviceScaleFactor: 2,
    mobile: true
  });
  for (const v of ['today', 'library', 'history', 'settings']) {
    const viewCheck = await browser.evaluate(`(async () => {
      if ('${v}' === 'settings') {
        document.querySelector('.top-tools-menu summary')?.click();
        await new Promise(r => setTimeout(r, 30));
      }
      document.querySelector('[data-view="${v}"]')?.click();
      await new Promise(r => setTimeout(r, 80));
      return {
        overflow: document.documentElement.scrollWidth > window.innerWidth + 1,
        hasContent: (document.querySelector('#viewRoot')?.innerHTML.length || 0) > 50
      };
    })()`);
    assert.equal(viewCheck.overflow, false, `540x900 下视图 ${v} 不得横向溢出`);
    assert.equal(viewCheck.hasContent, true, `视图 ${v} 应正常渲染`);
  }

  // 4) 真实交互闭环：今日复习空草稿防自欺警示 -> 补写回忆 -> 自适应稳定度评分保存 -> 切换深色主题与历史视图
  const reviewE2E = await browser.evaluate(`(async () => {
    document.querySelector('[data-view="today"]')?.click();
    await new Promise(r => setTimeout(r, 60));
    document.querySelector('[data-review-card="card:e2e-1"]')?.click();
    await new Promise(r => setTimeout(r, 60));
    const dialogOpen = Boolean(document.querySelector('#reviewDialog')?.open);

    // 未填回忆草稿直接看答案：触发防自欺警示
    document.querySelector('#revealOutline')?.click();
    await new Promise(r => setTimeout(r, 40));
    const warnVisible = !document.querySelector('#blankRecallWarning')?.classList.contains('hidden');

    // 点击「回去补写回忆」解锁并填入草稿
    document.querySelector('[data-action="resume-blank-recall"]')?.click();
    await new Promise(r => setTimeout(r, 40));
    const recallEl = document.querySelector('#recallInput');
    recallEl.value = '主动回忆验证通过';
    document.querySelector('#revealOutline')?.click();
    await new Promise(r => setTimeout(r, 40));
    document.querySelector('#goToScore')?.click();
    await new Promise(r => setTimeout(r, 50));

    // 选择 90% 高分并核对自适应预览
    document.querySelector('[data-score-preset="4"]')?.click();
    await new Promise(r => setTimeout(r, 40));
    const previewHtml = document.querySelector('#schedulePreview')?.innerHTML || '';
    document.querySelector('#saveReview')?.click();
    await new Promise(r => setTimeout(r, 450));

    // 切换深色外观并切至历史视图检查排版无溢出
    document.querySelector('.top-tools-menu summary')?.click();
    await new Promise(r => setTimeout(r, 30));
    document.querySelector('#themeToggleButton')?.click();
    await new Promise(r => setTimeout(r, 50));
    document.querySelector('[data-view="history"]')?.click();
    await new Promise(r => setTimeout(r, 60));

    return {
      dialogOpen,
      warnVisible,
      hasAdaptiveMeta: previewHtml.includes('稳定度 S='),
      theme: document.documentElement.dataset.theme || '',
      historyOverflow: document.documentElement.scrollWidth > window.innerWidth + 1,
      historyText: document.querySelector('#viewRoot')?.textContent || ''
    };
  })()`);

  assert.equal(reviewE2E.dialogOpen, true, '点击开始复习应打开复习弹窗');
  assert.equal(reviewE2E.warnVisible, true, '空回忆草稿看答案必须弹出防自欺警示');
  assert.equal(reviewE2E.hasAdaptiveMeta, true, '评分预览必须展示自适应稳定度 S 参数');
  assert.equal(reviewE2E.theme, 'dark', '深色外观切换必须生效');
  assert.equal(reviewE2E.historyOverflow, false, '深色主题下历史视图不得横向溢出');
  assert.match(reviewE2E.historyText, /主动回忆验证通过/, '历史视图应展示刚保存的回忆草稿');

  const srvAfterReview = await (await fetch(`${baseUrl}/api/store`)).json();
  const reviewedCard = srvAfterReview.docs.find(d => d._id === 'card:e2e-1');
  assert.equal(reviewedCard?.reps, 1, '服务端应持久化 adaptive reps');
  assert.ok(Number(reviewedCard?.stability) > 0, '服务端应持久化 adaptive stability');
  assert.ok(srvAfterReview.docs.some(d => d.type === 'review' && d.card_id === 'card:e2e-1'), '服务端应持久化 review 记录');

  // 5) 切换经典固定阶梯（ladder）时，卡片列表/今日队列必须立即按 ladder 天数显示（不能残留 adaptive 天数），且长内容卡片在 390px 手机下不横向溢出
  await browser.send('Emulation.setDeviceMetricsOverride', {
    width: 390,
    height: 844,
    deviceScaleFactor: 2,
    mobile: true
  });
  const ladderAndLongTextCheck = await browser.evaluate(`(async () => {
    await db.put({
      _id: 'card:ladder-long',
      type: 'card',
      title: 'SuperLongUnbreakableTokenCheck_ABCDEFGHIJKLMNOPQRSTUVWXYZ_1234567890_VerifyOverflowProtection',
      outline: '- https://example.com/very/long/unbroken/path/segment/to/check/mobile/wrap/behavior\\n- **ATP** 与 ==O2==',
      notebook: '系统测试',
      tags: ['LongText', 'LadderCheck'],
      interval_index: 2,
      next_interval_days: 19,
      due_date: new Date().toISOString().slice(0, 10),
      latest_memory_score: 75,
      archived_at: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    });
    const settings = await getSetting();
    await saveSetting({ ...(settings || {}), scheduler_mode: 'ladder', interval_days: [1, 3, 7, 14, 30, 60] });
    view = 'library';
    await render();
    const libRow = document.querySelector('[data-card-row="card:ladder-long"]')?.textContent || '';
    const libOverflow = document.documentElement.scrollWidth > window.innerWidth + 1;
    view = 'today';
    await render();
    const todayQueueText = document.querySelector('.review-queue')?.textContent || '';
    const todayOverflow = document.documentElement.scrollWidth > window.innerWidth + 1;
    return { libRow, libOverflow, todayQueueText, todayOverflow };
  })()`);

  assert.equal(ladderAndLongTextCheck.libOverflow, false, '390px 下超长标题卡片库不得横向溢出');
  assert.equal(ladderAndLongTextCheck.todayOverflow, false, '390px 下超长标题今日队列不得横向溢出');
  assert.match(ladderAndLongTextCheck.libRow, /周期 7 天/, '切换 ladder 模式后列表必须按阶梯第 2 档显示 7 天，而非 adaptive 19 天');
  assert.match(ladderAndLongTextCheck.todayQueueText, /周期 7 天/, '切换 ladder 模式后今日队列必须按阶梯第 2 档显示 7 天');

  assert.deepEqual(browser.exceptions, [], `浏览器运行期间不得出现未捕获异常: ${browser.exceptions.join('; ')}`);
});

test('真浏览器 IndexedDB 持久化、旧 localStorage 自动迁移与 Service Worker 离线冷启动', async t => {
  const browserBin = findBrowserExecutable();
  if (!browserBin) {
    t.skip('未检测到 Chrome / Edge，跳过真浏览器离线测试');
    return;
  }
  if (typeof globalThis.WebSocket !== 'function') {
    t.skip('当前 Node 版本未内置 WebSocket，跳过 CDP 离线测试');
    return;
  }

  const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'studystyle-ui-idb-data-'));
  const tmpProfile = fs.mkdtempSync(path.join(os.tmpdir(), 'studystyle-ui-idb-prof-'));
  t.after(() => {
    try { fs.rmSync(tmpData, { recursive: true, force: true, maxRetries: 8, retryDelay: 80 }); } catch {}
    try { fs.rmSync(tmpProfile, { recursive: true, force: true, maxRetries: 8, retryDelay: 80 }); } catch {}
  });

  const { createStudyStyleServer } = await import('../server.mjs');
  const reqLog = [];
  const srv = createStudyStyleServer({
    dataDir: tmpData,
    logger: { log() {}, error() {} }
  });
  srv.on('request', req => reqLog.push(`${req.method} ${req.url}`));
  await new Promise(resolve => srv.listen(0, '127.0.0.1', resolve));
  const port = srv.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;
  t.after(() => new Promise(resolve => {
    srv.closeAllConnections?.();
    srv.close(resolve);
  }));

  const browser = await launchBrowser(browserBin, tmpProfile);
  t.after(() => browser.close());
  await browser.send('Network.enable');

  // 先在同源写入一条遗留 localStorage 数据（模拟老用户升级），再完整进入应用
  await browser.navigate(`${baseUrl}/healthz`);
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  await browser.evaluate(`localStorage.setItem('studystyle-fallback-v1', JSON.stringify([
    { _id: 'settings:main', type: 'settings', scheduler_mode: 'adaptive', hold_interval_below_score: 60, study_method: 'blurting', updated_at: '2026-01-01T00:00:00.000Z' },
    { _id: 'card:legacy-migrate', type: 'card', title: '遗留 LocalStorage 自动迁移验证卡', outline: '- **IndexedDB** 持久层', notebook: '离线存储', tags: ['PWA'], interval_index: 0, due_date: '${today}', latest_memory_score: null, archived_at: null, created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z' }
  ]))`);

  await browser.navigate(`${baseUrl}/`);
  const bootState = await browser.evaluate(`new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = async () => {
      const text = document.querySelector('#viewRoot')?.textContent || '';
      if (text.includes('遗留 LocalStorage 自动迁移验证卡') && typeof getLocalStorageBackendName === 'function') {
        const reg = navigator.serviceWorker ? await navigator.serviceWorker.ready.catch(() => null) : null;
        return resolve({
          backend: getLocalStorageBackendName(),
          legacyCleared: localStorage.getItem('studystyle-fallback-v1') === null,
          migratedFlag: localStorage.getItem('studystyle-idb-migrated-v1'),
          swActive: Boolean(reg && reg.active)
        });
      }
      if (Date.now() - start > 8000) return reject(new Error('IndexedDB 迁移加载超时: ' + text.slice(0, 200)));
      setTimeout(tick, 60);
    };
    tick();
  })`);

  assert.equal(bootState.backend, 'indexeddb', '真实浏览器必须启用原生 IndexedDB 引擎');
  assert.equal(bootState.legacyCleared, true, '迁移完成后必须清空旧 localStorage 键，释放 5MB 配额');
  assert.equal(bootState.migratedFlag, '1');
  assert.equal(bootState.swActive, true, 'Service Worker 必须在同源上下文成功激活');

  // 新建一张本地卡片（此时清空服务端并断网），验证 IndexedDB + Service Worker 离线重载后完全可用
  await browser.evaluate(`(async () => {
    await db.put({
      _id: 'card:offline-idb',
      type: 'card',
      title: '断网 IndexedDB 离线存活测试卡',
      outline: '- ==Offline== Ready',
      notebook: '离线存储',
      tags: ['Offline'],
      interval_index: 0,
      due_date: '${today}',
      latest_memory_score: null,
      archived_at: null,
      created_at: new Date().toISOString()
    });
    await new Promise(r => setTimeout(r, 80));
  })()`);

  // 验证 IndexedDB v2 按文档分条存储、sync_cursor 游标持久化及在线冷刷新 ?since= 增量拉取
  const idbV2Check = await browser.evaluate(`(async () => {
    flushServerStore();
    for (let i = 0; i < 40; i++) {
      if (serverRev && serverBaselineKnown) {
        const synced = await new Promise((resolve, reject) => {
          const req = indexedDB.open('studystyle-local-v1');
          req.onerror = () => reject(req.error || new Error('indexedDB.open 失败'));
          req.onsuccess = () => {
            const d = req.result;
            try {
              const tx = d.transaction(['kv', 'docs'], 'readonly');
              const kvStore = tx.objectStore('kv');
              const docsStore = tx.objectStore('docs');
              const docsKeyPath = docsStore.keyPath;
              const kvDocsReq = kvStore.get('docs');
              const cursorReq = kvStore.get('sync_cursor');
              const docReq = docsStore.get('card:offline-idb');
              tx.onerror = () => { d.close(); reject(tx.error || new Error('IDB 事务失败')); };
              tx.onabort = () => { d.close(); reject(tx.error || new Error('IDB 事务中止')); };
              tx.oncomplete = () => {
                const cursor = cursorReq.result;
                const ok = Boolean(docReq.result && cursor?.rev === serverRev && Array.isArray(cursor.entries) && cursor.entries.some(e => e[0] === 'card:offline-idb'));
                const snapshot = {
                  ok,
                  version: d.version,
                  hasDocsStore: d.objectStoreNames.contains('docs'),
                  keyPath: docsKeyPath,
                  kvDocsRemoved: kvDocsReq.result === undefined
                };
                d.close();
                resolve(snapshot);
              };
            } catch (err) {
              d.close();
              reject(err);
            }
          };
        });
        if (synced.ok) return synced;
      }
      await new Promise(r => setTimeout(r, 50));
    }
    throw new Error('IndexedDB v2 同步游标超时未落盘');
  })()`);
  assert.equal(idbV2Check.version, 2);
  assert.equal(idbV2Check.hasDocsStore, true);
  assert.equal(idbV2Check.keyPath, '_id');
  assert.equal(idbV2Check.kvDocsRemoved, true);

  reqLog.length = 0;
  await browser.reload(false);
  await browser.evaluate(`new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      const text = document.querySelector('#viewRoot')?.textContent || '';
      if (text.includes('断网 IndexedDB 离线存活测试卡') && typeof serverRev === 'string' && serverRev) return resolve(true);
      if (Date.now() - start > 8000) return reject(new Error('在线重载超时: ' + text.slice(0, 200)));
      setTimeout(tick, 50);
    };
    tick();
  })`);
  assert.ok(reqLog.some(line => line.startsWith('GET /api/store?since=')), `冷刷新应发起 ?since= 增量请求，实际日志: ${reqLog.join(', ')}`);
  assert.equal(reqLog.some(line => line === 'GET /api/store'), false, `冷刷新命中游标时不应回退全量 GET /api/store: ${reqLog.join(', ')}`);

  try {
    await browser.send('Network.emulateNetworkConditions', {
      offline: true,
      latency: 0,
      downloadThroughput: -1,
      uploadThroughput: -1
    });
    await browser.reload(false);

    const offlineBoot = await browser.evaluate(`new Promise((resolve, reject) => {
      const start = Date.now();
      const tick = () => {
        const text = document.querySelector('#viewRoot')?.textContent || '';
        if (text.includes('断网 IndexedDB 离线存活测试卡') && text.includes('遗留 LocalStorage 自动迁移验证卡')) {
          return resolve({ ok: true, backend: getLocalStorageBackendName(), hasController: Boolean(navigator.serviceWorker?.controller) });
        }
        if (Date.now() - start > 8000) return reject(new Error('离线冷启动超时: ' + text.slice(0, 250)));
        setTimeout(tick, 60);
      };
      tick();
    })`);
    assert.equal(offlineBoot.ok, true, '完全断网后应通过 Service Worker + IndexedDB 完整启动并渲染本地卡片');
    assert.equal(offlineBoot.backend, 'indexeddb');
    assert.equal(offlineBoot.hasController, true, '离线重载页面应由已激活的 Service Worker 接管');
  } finally {
    await browser.send('Network.emulateNetworkConditions', {
      offline: false,
      latency: 0,
      downloadThroughput: -1,
      uploadThroughput: -1
    });
  }

  assert.deepEqual(browser.exceptions, [], `离线与迁移期间不得产生未捕获 JS 异常: ${browser.exceptions.join('; ')}`);
});
