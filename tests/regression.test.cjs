/* 独立回归测试：覆盖审计中实证过的真实缺陷路径
   —— 服务端（真实 HTTP + 临时目录）与客户端（vm 沙箱 mock）双侧。
   约定：所有服务端用例只用临时目录，绝不污染项目 data/。 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');

const root = path.resolve(__dirname, '..');
const storeName = 'studystyle-db.json';

let createStudyStyleServer;
let tmpRoots = [];

test.before(async () => {
  ({ createStudyStyleServer } = await import(pathToFileURL(path.join(root, 'server.mjs')).href));
});

test.after(async () => {
  for (const dir of tmpRoots) await fsp.rm(dir, { recursive: true, force: true });
});

async function makeDataDir() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'studystyle-regress-'));
  tmpRoots.push(dir);
  return dir;
}

/* ===================== 服务端测试脚手架 ===================== */

async function startServer(options = {}) {
  const dataDir = options.dataDir || (await makeDataDir());
  const server = createStudyStyleServer({ logger: { log() {}, error() {} }, dataDir, ...options });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    dataDir,
    port,
    base: `http://127.0.0.1:${port}`,
    storeFile: path.join(dataDir, storeName),
    close: () => new Promise(resolve => server.close(resolve))
  };
}

function putJson(base, body, headers = {}) {
  return fetch(`${base}/api/store`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body)
  });
}

function card(id, extra = {}) {
  return { _id: id, title: `卡片 ${id}`, updated_at: '2026-01-01T00:00:00.000Z', ...extra };
}

async function getStore(base, headers = {}) {
  const res = await fetch(`${base}/api/store`, { headers });
  assert.equal(res.status, 200, 'GET /api/store 应成功');
  return res.json();
}

/* ===================== 客户端测试脚手架（vm 沙箱） ===================== */

class MockClassList {
  constructor() { this.set = new Set(); }
  add(...cls) { cls.forEach(c => this.set.add(c)); }
  remove(...cls) { cls.forEach(c => this.set.delete(c)); }
  toggle(c, force) {
    if (force === undefined) {
      if (this.set.has(c)) { this.set.delete(c); return false; }
      this.set.add(c); return true;
    }
    if (force) this.set.add(c); else this.set.delete(c);
    return !!force;
  }
  contains(c) { return this.set.has(c); }
}

/* 客户端沙箱：真实 setTimeout（去抖可测）+ 拦截 fetch（可数调用次数） */
function createSandbox(options = {}) {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const domainCode = fs.readFileSync(path.join(root, 'domain.cjs'), 'utf8');
  const clientFiles = ['src/state.js', 'src/store.js', 'src/views.js', 'src/review.js', 'app.js'];
  const appCode = clientFiles.map(file => fs.readFileSync(path.join(root, file), 'utf8')).join('\n');

  const elementsById = new Map();
  function getOrCreateEl(id) {
    if (!elementsById.has(id)) {
      elementsById.set(id, {
        id,
        textContent: '',
        innerHTML: '',
        outerHTML: '',
        value: '',
        disabled: false,
        hidden: false,
        open: false,
        returnValue: '',
        dataset: {},
        style: {},
        classList: new MockClassList(),
        listeners: {},
        elements: new Proxy({}, {
          get(target, prop) {
            if (!target[prop]) target[prop] = { value: '' };
            return target[prop];
          }
        }),
        addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); },
        reset() { for (const k of Object.keys(this.elements)) this.elements[k].value = ''; },
        showModal() { this.open = true; },
        close() { this.open = false; (this.listeners.close || []).forEach(fn => fn()); },
        focus() {},
        click() {},
        setSelectionRange() {},
        appendChild() {},
        querySelector(sel) {
          if (sel === '.cloze-mask' && this.innerHTML.includes('cloze-mask')) return {};
          return null;
        },
        requestSubmit() { (this.listeners.submit || []).forEach(fn => fn({ preventDefault() {}, currentTarget: this })); }
      });
    }
    return elementsById.get(id);
  }
  for (const m of html.matchAll(/id="([^"]+)"/g)) getOrCreateEl(m[1]);

  const storage = new Map();
  if (Array.isArray(options.initialDocs)) {
    storage.set('studystyle-fallback-v1', JSON.stringify(options.initialDocs));
  }
  const fetchCalls = [];
  let serverRevCounter = 0;
  /* 可由用例覆盖的服务端行为（合并回填场景需要伪造 merged 响应） */
  const serverHook = options.serverHook || (() => ({
    ok: true, status: 200,
    body: { ok: true, rev: `r${++serverRevCounter}`, docs: [] }
  }));

  const fetchMock = async (url, init = {}) => {
    const call = {
      url,
      method: (init.method || 'GET').toUpperCase(),
      body: init.body ? JSON.parse(init.body) : null,
      headers: init.headers || {},
      keepalive: Boolean(init.keepalive)
    };
    fetchCalls.push(call);
    const override = options.onFetch ? await options.onFetch(call) : null;
    const response = override || await serverHook(call);
    return {
      ok: response.ok !== false,
      status: response.status || 200,
      json: async () => response.body
    };
  };

  const docListeners = {};
  const sandbox = {
    console,
    assert,
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: id => clearTimeout(id),
    setInterval: () => 1,
    clearInterval: () => {},
    crypto: { randomUUID: () => 'uuid-' + Math.random().toString(16).slice(2) },
    Blob: class { constructor(parts) { this.parts = parts; } },
    URL: Object.assign(URL, { createObjectURL: () => 'blob:test', revokeObjectURL: () => {} }),
    Element: class {},
    addEventListener() {},
    navigator: { onLine: options.onLine !== false },
    ...(options.indexedDB ? { indexedDB: options.indexedDB } : {}),
    localStorage: {
      getItem: (k) => storage.get(k) ?? null,
      setItem: (k, v) => storage.set(k, String(v)),
      removeItem: (k) => storage.delete(k)
    },
    fetch: fetchMock,
    document: {
      title: '',
      visibilityState: 'visible',
      documentElement: { dataset: {} },
      head: { appendChild() {} },
      createElement: (tag) => getOrCreateEl('created:' + tag),
      addEventListener(type, fn) { (docListeners[type] ||= []).push(fn); },
      querySelector(sel) {
        if (sel.startsWith('#')) {
          const id = sel.slice(1);
          if (elementsById.has(id)) return elementsById.get(id);
          const viewHtml = elementsById.get('viewRoot')?.innerHTML || '';
          if (viewHtml.includes(`id="${id}"`)) return getOrCreateEl(id);
        }
        return null;
      },
      querySelectorAll() { return []; }
    }
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;

  vm.createContext(sandbox);
  vm.runInContext(domainCode, sandbox);
  vm.runInContext(appCode, sandbox);

  return {
    sandbox,
    storage,
    fetchCalls,
    docListeners,
    el: id => elementsById.get(id),
    /* 在沙箱内执行表达式（可读写 app.js 的模块级 let 变量） */
    run: expr => vm.runInContext(expr, sandbox),
    runAsync: expr => vm.runInContext(expr, sandbox),
    localDocs: () => JSON.parse(storage.get('studystyle-fallback-v1') || '[]'),
    putCalls: () => fetchCalls.filter(c => c.method === 'PUT'),
    getCalls: () => fetchCalls.filter(c => c.method === 'GET'),
    wait: ms => new Promise(resolve => setTimeout(resolve, ms))
  };
}

/* 等待初始化（hydrate + 默认 settings 落盘）完成 */
async function settle(harness, ms = 420) {
  await harness.wait(ms);
}

/* =====================================================================
   一、服务端：多设备交错写入 / 乐观锁 / 入参校验 / 损坏隔离 / CSRF / 鉴权
   ===================================================================== */

/* 缺陷路径：多设备交错写入曾被整库覆盖互相抹除（审计 P0-1/P0-4） */
test('R01 多设备交错写入不丢卡：双方卡片最终都在服务端', async t => {
  const srv = await startServer();
  t.after(() => srv.close());

  // 设备 A 与设备 B 同时读到 rev=r0
  const revA = (await getStore(srv.base)).rev;
  const revB = revA;
  assert.equal(revA, 'r0');

  // 交错写入：A 先写自己的卡，B 用过期的 base_rev 写入自己的卡
  await putJson(srv.base, { docs: [card('a1')], base_rev: revA });
  await putJson(srv.base, { docs: [card('b1')], base_rev: revB });

  const after = await getStore(srv.base);
  assert.deepEqual(after.docs.map(d => d._id).sort(), ['a1', 'b1'], '双方卡片都必须保留');

  // 第三轮：A 再写一张，仍用自己较旧的 rev —— 依旧不能抹掉 B 的卡
  await putJson(srv.base, { docs: [card('a1'), card('a2')], base_rev: revA });
  const final = await getStore(srv.base);
  assert.deepEqual(final.docs.map(d => d._id).sort(), ['a1', 'a2', 'b1']);
});

/* 缺陷路径：陈旧客户端曾直接整库覆盖服务端（审计 P0-4） */
test('R02 陈旧客户端带旧 base_rev 推送走合并而非整库替换', async t => {
  const srv = await startServer();
  t.after(() => srv.close());

  await putJson(srv.base, { docs: [card('a1')] });
  const { rev } = await getStore(srv.base);

  // 服务端先被别的设备推进到新 rev
  await putJson(srv.base, { docs: [card('a1'), card('a2')], base_rev: rev });
  const serverRev = (await getStore(srv.base)).rev;
  assert.notEqual(serverRev, rev);

  // 陈旧客户端推送：必须走合并，服务端已有卡片不能消失
  const res = await putJson(srv.base, { docs: [card('a1'), card('b1')], base_rev: rev });
  assert.equal(res.status, 200);
  const payload = await res.json();
  assert.equal(payload.merged, true, 'base_rev 过期必须触发合并');

  const after = await getStore(srv.base);
  assert.deepEqual(after.docs.map(d => d._id).sort(), ['a1', 'a2', 'b1']);
});

/* 缺陷路径：合并时按 updated_at 决胜，相同时间戳以服务端为准（审计 P0-3） */
test('R03 合并同 _id 时 updated_at 较新者胜，相同则服务端胜', async t => {
  const srv = await startServer();
  t.after(() => srv.close());

  await putJson(srv.base, { docs: [card('x', { title: '服务端', updated_at: '2026-01-01T00:00:00.000Z' })] });
  const { rev } = await getStore(srv.base);

  await putJson(srv.base, {
    docs: [card('x', { title: '客户端较新', updated_at: '2026-06-01T00:00:00.000Z' })],
    base_rev: rev
  });
  let current = await getStore(srv.base);
  assert.equal(current.docs[0].title, '客户端较新', 'updated_at 较新的客户端版本应胜出');

  // 客户端版本更旧 → 服务端版本保留
  await putJson(srv.base, {
    docs: [card('x', { title: '客户端较旧', updated_at: '2025-01-01T00:00:00.000Z' })],
    base_rev: rev
  });
  current = await getStore(srv.base);
  assert.equal(current.docs[0].title, '客户端较新');

  // updated_at 完全相同 → 服务端版本胜出
  const serverVersion = current.docs[0];
  await putJson(srv.base, {
    docs: [card('x', { title: '客户端同时间不同内容', updated_at: serverVersion.updated_at })],
    base_rev: rev
  });
  current = await getStore(srv.base);
  assert.equal(current.docs[0].title, serverVersion.title);
});

/* 缺陷路径：非法入参曾静默清库（审计 P0-3 旧版：{} / docs 非数组） */
test('R04 非法入参返回 400 且绝不写库，原有数据完好', async t => {
  const srv = await startServer();
  t.after(() => srv.close());

  await putJson(srv.base, { docs: [card('a1')] });
  const before = await getStore(srv.base);

  const cases = [
    { docs: 'x' },
    {},
    { docs: [{}] },
    { docs: [{ _id: 123 }] },
    { docs: ['字符串元素'] },
    { docs: [null] },
    { docs: [[]] }
  ];
  for (const body of cases) {
    const res = await putJson(srv.base, body);
    assert.equal(res.status, 400, `入参 ${JSON.stringify(body)} 必须 400`);
    assert.equal((await res.json()).ok, false);
  }

  // base_rev 类型非法同样 400
  const badRev = await putJson(srv.base, { docs: [card('a1')], base_rev: 42 });
  assert.equal(badRev.status, 400);

  const after = await getStore(srv.base);
  assert.deepEqual(after.docs, before.docs, '非法入参不能改动任何数据');
  assert.equal(after.rev, before.rev, '非法入参不能推进版本号');
});

/* 缺陷路径：损坏文件曾被当空库并永久覆盖（审计 P0-4 旧版） */
test('R05 损坏文件返回 500 并生成 .corrupt 备份，后续写入被拒且原数据可恢复', async t => {
  const srv = await startServer();
  t.after(() => srv.close());

  const corrupted = '{"docs":[{"_id":"a"';
  await fsp.writeFile(srv.storeFile, corrupted, 'utf8');

  const res = await fetch(`${srv.base}/api/store`);
  assert.equal(res.status, 500);
  assert.match((await res.json()).error, /损坏/);

  // 备份文件必须存在且原样保留损坏内容（原数据可恢复）
  const backups = (await fsp.readdir(srv.dataDir)).filter(name => name.startsWith(`${storeName}.corrupt.`));
  assert.equal(backups.length, 1);
  assert.equal(await fsp.readFile(path.join(srv.dataDir, backups[0]), 'utf8'), corrupted);

  // 后续读取与写入都必须被拒，不能退化成空库
  assert.equal((await fetch(`${srv.base}/api/store`)).status, 500);
  const write = await putJson(srv.base, { docs: [card('a1')] });
  assert.equal(write.status, 500, '损坏隔离后写入必须被拒');

  // 恢复备份后数据可读回
  await fsp.rename(path.join(srv.dataDir, backups[0]), srv.storeFile);
  const recovered = await fetch(`${srv.base}/api/store`);
  assert.equal(recovered.status, 500, '损坏内容本身仍非合法 JSON，恢复后应仍报错而不是假装空库');
});

/* 缺陷路径：跨源请求曾可清库（审计 P0-5 CSRF） */
test('R06 CSRF 防护：跨源 GET/PUT 均 403，同源放行', async t => {
  const srv = await startServer();
  t.after(() => srv.close());

  const evil = 'https://evil.example.com';

  const crossGet = await fetch(`${srv.base}/api/store`, { headers: { Origin: evil } });
  assert.equal(crossGet.status, 403);

  const crossPut = await putJson(srv.base, { docs: [card('a1')] }, { Origin: evil });
  assert.equal(crossPut.status, 403);

  // 同源放行（Origin 与 Host 一致）
  const sameOrigin = { Origin: `http://127.0.0.1:${srv.port}` };
  assert.equal((await fetch(`${srv.base}/api/store`, { headers: sameOrigin })).status, 200);
  assert.equal((await putJson(srv.base, { docs: [card('a1')] }, sameOrigin)).status, 200);

  // 畸形 Origin 同样拒绝
  assert.equal((await fetch(`${srv.base}/api/store`, { headers: { Origin: 'not-a-url' } })).status, 403);

  // 跨源请求不得改动任何数据
  const after = await getStore(srv.base);
  assert.deepEqual(after.docs.map(d => d._id), ['a1']);
});

/* 缺陷路径：STORE_TOKEN 缺失时曾可任意读写（审计 P0-6） */
test('R07 STORE_TOKEN：缺令牌 401 / 错令牌 401 / 正确令牌 200', async t => {
  const srv = await startServer({ storeToken: 'secret-token' });
  t.after(() => srv.close());

  assert.equal((await putJson(srv.base, { docs: [card('a1')] })).status, 401);
  assert.equal((await putJson(srv.base, { docs: [card('a1')] }, { 'X-Store-Token': 'wrong' })).status, 401);
  assert.equal((await fetch(`${srv.base}/api/store`)).status, 401);

  const ok = await putJson(srv.base, { docs: [card('a1')] }, { 'X-Store-Token': 'secret-token' });
  assert.equal(ok.status, 200);
  assert.equal((await fetch(`${srv.base}/api/store`, { headers: { 'X-Store-Token': 'secret-token' } })).status, 200);
});

/* 契约冻结项：PUT 响应必须回传 docs，否则客户端「合并回填」分支永不触发 */
test('R08 PUT 响应含 rev/merged/count/docs，合并后客户端可直接回填完整文档集', async t => {
  const srv = await startServer();
  t.after(() => srv.close());

  await putJson(srv.base, { docs: [card('a1')] });
  const { rev } = await getStore(srv.base);
  await putJson(srv.base, { docs: [card('a1'), card('a2')], base_rev: rev });

  const res = await putJson(srv.base, { docs: [card('b1')], base_rev: rev });
  assert.equal(res.status, 200);
  const payload = await res.json();
  assert.equal(payload.merged, true);
  assert.equal(typeof payload.rev, 'string');
  assert.equal(typeof payload.count, 'number');
  assert.ok(Array.isArray(payload.docs), 'PUT 响应必须带 docs 数组（契约冻结的必填字段）');
  assert.deepEqual(payload.docs.map(d => d._id).sort(), ['a1', 'a2', 'b1']);
  assert.equal(payload.count, payload.docs.length);
});

/* =====================================================================
   二、客户端：同步 / 去抖 / 版本号 / 默认值 / 低分策略 / 脏数据 / 队列
   ===================================================================== */

/* 缺陷路径：无去抖时每次写入都全量 PUT（写放大，审计 P2-3） */
test('R09 客户端去抖：连续多次 put 只触发一次推送', async () => {
  const h = createSandbox();
  await settle(h);
  h.fetchCalls.length = 0;

  await h.runAsync(`(async () => {
    for (let i = 0; i < 8; i++) await db.put({ _id: 'card:' + i, type: 'card', title: 'T' + i, outline: 'O' });
  })()`);
  await h.wait(450);

  assert.ok(h.putCalls().length <= 2, `8 次 put 最多触发 2 次推送，实际 ${h.putCalls().length} 次`);
  assert.equal(h.putCalls().length, 1, '去抖窗口内应合并为 1 次推送');
});

test('R10 bulkDocs 批量写入只触发一次推送', async () => {
  const h = createSandbox();
  await settle(h);
  h.fetchCalls.length = 0;

  await h.runAsync(`(async () => {
    await db.bulkDocs([1, 2, 3, 4, 5].map(i => ({ _id: 'card:' + i, type: 'card', title: 'T' + i, outline: 'O' })));
  })()`);
  await h.wait(450);

  assert.equal(h.putCalls().length, 1, 'bulkDocs 应只推送一次');
  assert.equal(h.putCalls()[0].body.docs.filter(doc => doc.type === 'card').length, 5);
});

test('R11 put 自动写入 updated_at', async () => {
  const h = createSandbox();
  await settle(h);

  const doc = await h.runAsync(`(async () => {
    const d = { _id: 'card:ts', type: 'card', title: 'T', outline: 'O' };
    await db.put(d);
    return d;
  })()`);
  assert.equal(typeof doc.updated_at, 'string');
  assert.ok(!Number.isNaN(Date.parse(doc.updated_at)), 'updated_at 必须是合法时间戳');
  assert.ok(h.localDocs().find(d => d._id === 'card:ts').updated_at);
});

test('R12 _rev 采用 <数字>-<hash> 格式且连续两次 put 不同', async () => {
  const h = createSandbox();
  await settle(h);

  const revs = await h.runAsync(`(async () => {
    const a = { _id: 'card:r1', type: 'card', title: 'T', outline: 'O' };
    const b = { _id: 'card:r2', type: 'card', title: 'T', outline: 'O' };
    await db.put(a);
    await db.put(b);
    return [a._rev, b._rev];
  })()`);

  for (const rev of revs) {
    assert.match(rev, /^\d+-[0-9a-f]{4,}$/, `_rev 必须形如 <数字>-<hash>，实际 ${rev}`);
  }
  assert.notEqual(revs[0], revs[1], '连续两次 put 的 _rev 必须不同');
});

test('R13 adaptive_leap 新装默认关闭，旧 settings 缺该字段也视为关闭', async () => {
  const h = createSandbox();
  await settle(h);

  const fresh = await h.runAsync('getSetting()');
  assert.equal(fresh.adaptive_leap, false, '新装环境 adaptive_leap 必须为 false');

  // 读取点语义统一：只有严格 true 才算开启
  const reads = await h.runAsync(`(async () => [
    (await getSetting())?.adaptive_leap === true,
    (await getSetting())?.adaptive_leap ?? false
  ])()`);
  assert.deepEqual(Array.from(reads), [false, false]);

  // 旧 settings 没有该字段 → 视为关闭
  const legacy = createSandbox();
  legacy.storage.set('studystyle-fallback-v1', JSON.stringify([
    { _id: 'settings:main', type: 'settings', interval_days: [1, 3, 7, 14, 30, 60], default_low_action: 'hold' }
  ]));
  await settle(legacy);
  const legacySettings = await legacy.runAsync('getSetting()');
  assert.equal(legacySettings.adaptive_leap, undefined, '旧 settings 不应被强行写入新字段');
  assert.equal(await legacy.runAsync('(async () => (await getSetting())?.adaptive_leap === true)()'), false);
});

test('R14 低分策略不跨卡片泄漏：卡 A 的手动选择不能带到卡 B', async () => {
  const h = createSandbox();
  await settle(h);

  await h.runAsync(`(async () => {
    await saveCard({ id: '', title: '甲卡', outline: '- 甲', tags: [], due_date: localDay() });
    await saveCard({ id: '', title: '乙卡', outline: '- 乙', tags: [], due_date: localDay() });
    view = 'today';
    await render();
    await beginReview();
  })()`);

  // 卡 A：打低分并手动选「重置为 1 天」
  await h.runAsync('(async () => { await selectScore(30, 1); })()');
  const radioChange = h.el('reviewDialog').listeners.change[0];
  await radioChange({ target: { name: 'lowCycle', value: 'reset' } });
  await h.wait(20);
  assert.equal(await h.run('lowCycleChoice'), 'reset');
  assert.match(h.el('schedulePreview').innerHTML, /value="reset"\s+checked/, '卡 A 应显示重置被选中');

  // 保存并切到卡 B
  await h.runAsync(`(async () => { await saveReview({ preventDefault() {} }); })()`);
  await h.wait(20);
  assert.equal(await h.run('lowCycleChoice'), null, '切卡后必须清空手动选择');

  // 卡 B：同样打低分 → 必须回到全局默认（hold），不能沿用卡 A 的 reset
  await h.runAsync('(async () => { await selectScore(30, 1); })()');
  await h.wait(20);
  const previewB = h.el('schedulePreview').innerHTML;
  assert.match(previewB, /value="hold"\s+checked/, '卡 B 应使用全局默认 hold');
  assert.doesNotMatch(previewB, /value="reset"\s+checked/, '卡 B 不得沿用卡 A 的重置选择');
});

test('R15 脏分数不崩页面：越界/NaN/字符串分数都归入待首次复习', async () => {
  const h = createSandbox();
  await settle(h);

  const result = await h.runAsync(`(async () => {
    const dirty = [150, NaN, 'abc', -5];
    for (let i = 0; i < dirty.length; i++) {
      await db.put({
        _id: 'card:dirty' + i, type: 'card', title: '脏分' + i, outline: '- x',
        latest_memory_score: dirty[i], due_date: localDay(), created_at: new Date().toISOString(),
        interval_index: 0, notebook: '默认笔记本', tags: []
      });
    }
    view = 'today';
    await render();
    const all = await getCards();
    return {
      count: all.length,
      bags: all.map(c => bagIndex(c)),
      titles: all.map(c => c.title),
      html: document.querySelector('#viewRoot').innerHTML
    };
  })()`);

  assert.equal(result.count, 4);
  assert.deepEqual(Array.from(result.bags), [0, 0, 0, 0], '脏分数应全部归入 L1 待首次复习');
  assert.ok(result.html.includes('待首次复习'));
  for (const title of result.titles) assert.ok(result.html.includes(title), `队列应渲染 ${title}`);
});

test('R16 导入脏数据：缺标题被跳过、越界分数被修复并提示数量', async () => {
  const h = createSandbox();
  await settle(h);

  const payload = {
    app: 'StudyStyle', version: 1, docs: [
      { _id: 'card:good', type: 'card', title: '正常卡', outline: '- 正文', due_date: '2026-01-01', latest_memory_score: 40 },
      { _id: 'card:notitle', type: 'card', outline: '- 有大纲没标题', due_date: '2026-01-01' },
      { _id: 'card:badscore', type: 'card', title: '越界分', outline: '- 正文', due_date: '2026-01-01', latest_memory_score: 150 },
      { _id: 'review:bad', type: 'review', card_id: 'card:good', memory_score: 80 },
      { _id: 'card:unknown', type: 'whatever', title: '未知类型', outline: '- 正文' }
    ]
  };

  await h.runAsync(`(async () => {
    await importData({ text: async () => ${JSON.stringify(JSON.stringify(payload))} });
  })()`);
  await h.wait(20);

  const toast = h.el('toast').textContent;
  assert.match(toast, /已导入 2 条/, `toast 必须提示导入数量，实际：${toast}`);
  assert.match(toast, /跳过 3 条/, `toast 必须提示跳过数量，实际：${toast}`);
  assert.match(toast, /修复 1 条/, `toast 必须提示修复数量，实际：${toast}`);

  const docs = h.localDocs();
  const ids = docs.filter(d => d.type === 'card').map(d => d._id).sort();
  assert.deepEqual(ids, ['card:badscore', 'card:good'], '被跳过的记录不得入库，也不得让其它卡消失');
  assert.equal(docs.find(d => d._id === 'card:badscore').latest_memory_score, null, '越界分数应被修复为 null');
});

test('R17 队列不按每日上限截断：到期卡片数超过上限时 DOM 仍包含全部', async () => {
  const h = createSandbox();
  await settle(h);

  await h.runAsync(`(async () => {
    await saveSetting({ daily_review_limit: 2 });
    for (let i = 0; i < 6; i++) {
      await db.put({
        _id: 'card:q' + i, type: 'card', title: '到期卡' + i, outline: '- x',
        due_date: localDay(), created_at: new Date().toISOString(),
        interval_index: 0, notebook: '默认笔记本', tags: []
      });
    }
    view = 'today';
    await render();
  })()`);

  const html = h.el('viewRoot').innerHTML;
  for (let i = 0; i < 6; i++) {
    assert.ok(html.includes(`到期卡${i}`), `队列 DOM 必须包含第 ${i} 张到期卡（不得按每日上限截断）`);
  }
  const rowCount = (html.match(/class="queue-row/g) || []).length;
  assert.equal(rowCount, 6, '队列行数应等于全部到期卡片数');
});

test('R18 flushServerStore 必须立即推送，不能只是重置去抖窗口', async () => {
  const h = createSandbox();
  await settle(h);
  h.fetchCalls.length = 0;

  await h.runAsync(`(async () => { await db.put({ _id: 'card:f', type: 'card', title: 'T', outline: 'O' }); })()`);
  // 不等去抖窗口，直接冲刷
  await h.runAsync('flushServerStore()');
  assert.equal(h.putCalls().length, 1, 'flushServerStore 应立即发出推送');
});

/* =====================================================================
   三、端到端：真实服务端 + 客户端沙箱联动
   ===================================================================== */

test('R19 端到端：客户端合并回填后与服务端保持一致，不会分叉', async t => {
  const srv = await startServer();
  t.after(() => srv.close());

  const h = createSandbox({
    serverHook: async call => {
      if (call.method === 'GET') {
        const payload = await (await fetch(`${srv.base}/api/store`)).json();
        return { ok: true, status: 200, body: payload };
      }
      const res = await fetch(`${srv.base}/api/store`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(call.body)
      });
      const body = await res.json();
      return { ok: res.ok, status: res.status, body };
    }
  });
  await settle(h);

  // 模拟「服务端已有别的设备的卡」：先直接写入服务端
  await putJson(srv.base, { docs: [card('remote1', { updated_at: '2026-02-01T00:00:00.000Z' })] });

  // 客户端写入自己的卡（此时客户端持有的 rev 已过期 → 触发服务端合并）
  await h.runAsync(`(async () => { await db.put({ _id: 'card:local1', type: 'card', title: '本地卡', outline: 'O' }); })()`);
  await h.wait(450);

  const serverDocs = await getStore(srv.base);
  assert.deepEqual(serverDocs.docs.filter(d => d._id !== 'settings:main').map(d => d._id).sort(), ['card:local1', 'remote1'], '服务端合并后应同时有两张卡');

  const localIds = h.localDocs().filter(d => d._id !== 'settings:main').map(d => d._id).sort();
  assert.deepEqual(localIds, ['card:local1', 'remote1'], '客户端必须回填服务端合并结果，否则两端永久分叉');
});

test('R20 端到端：客户端两次推送之间不丢失服务端新增的卡片', async t => {
  const srv = await startServer();
  t.after(() => srv.close());

  const h = createSandbox({
    serverHook: async call => {
      if (call.method === 'GET') {
        const payload = await (await fetch(`${srv.base}/api/store`)).json();
        return { ok: true, status: 200, body: payload };
      }
      const res = await fetch(`${srv.base}/api/store`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(call.body)
      });
      return { ok: res.ok, status: res.status, body: await res.json() };
    }
  });
  await settle(h);

  await h.runAsync(`(async () => { await db.put({ _id: 'card:m1', type: 'card', title: '本机卡', outline: 'O' }); })()`);
  await h.wait(450);

  // 另一台设备此刻写入服务端
  await putJson(srv.base, { docs: [card('card:m1', { updated_at: '2026-01-01T00:00:00.000Z' }), card('other', { updated_at: '2026-01-02T00:00:00.000Z' })] });

  // 本机再写一次
  await h.runAsync(`(async () => { await db.put({ _id: 'card:m2', type: 'card', title: '本机卡2', outline: 'O' }); })()`);
  await h.wait(450);

  const serverIds = (await getStore(srv.base)).docs.filter(d => d._id !== 'settings:main').map(d => d._id).sort();
  assert.deepEqual(serverIds, ['card:m1', 'card:m2', 'other'], '服务端不得因为本机再次推送而丢失别的设备的卡片');
});

test('启动合并发现同数量但本地内容较新时仍回推服务端', async () => {
  const remoteDocs = [
    { _id: 'card:same-count', type: 'card', title: 'remote old', outline: '- x', updated_at: '2026-01-01T00:00:00.000Z' },
    { _id: 'settings:main', type: 'settings', study_method: 'blurting', updated_at: '2026-01-01T00:00:00.000Z' }
  ];
  const h = createSandbox({
    initialDocs: [
      { ...remoteDocs[0], title: 'local newer', updated_at: '2026-06-01T00:00:00.000Z' },
      remoteDocs[1]
    ],
    serverHook: async call => call.method === 'GET'
      ? { ok: true, body: { rev: 'r7', docs: remoteDocs } }
      : { ok: true, body: { rev: 'r8', merged: false, docs: call.body.docs } }
  });
  await settle(h);

  const pushes = h.putCalls();
  assert.equal(pushes.length, 1);
  assert.equal(pushes[0].body.base_rev, 'r7');
  assert.equal(pushes[0].body.docs.find(doc => doc._id === 'card:same-count').title, 'local newer');
});

test('迟到的合并响应不会覆盖请求发出后的本地编辑', async () => {
  let releasePut;
  let delayNextPut = false;
  const h = createSandbox({
    serverHook: async call => {
      if (call.method === 'GET') return { ok: true, body: { rev: 'r4', docs: [] } };
      if (delayNextPut) {
        delayNextPut = false;
        return new Promise(resolve => { releasePut = resolve; });
      }
      return { ok: true, body: { rev: 'r5', merged: false, docs: call.body.docs } };
    }
  });
  await settle(h);

  const original = { _id: 'card:race', type: 'card', title: 'before', outline: '- x', updated_at: '2026-01-01T00:00:00.000Z' };
  h.storage.set('studystyle-fallback-v1', JSON.stringify([
    { _id: 'settings:main', type: 'settings', study_method: 'blurting' },
    original
  ]));
  h.run("serverRev = 'r10'");
  delayNextPut = true;
  h.run("pushServerStoreNow(JSON.parse(localStorage.getItem('studystyle-fallback-v1')))");
  for (let i = 0; i < 20 && !releasePut; i++) await h.wait(5);
  assert.equal(typeof releasePut, 'function', 'PUT 请求应已到达可控响应桩');

  await h.runAsync(`(async () => {
    const card = await db.get('card:race');
    card.title = 'edited after request';
    await db.put(card);
  })()`);
  releasePut({ ok: true, body: { rev: 'r11', merged: true, docs: [original, { _id: 'card:remote', type: 'card', title: 'remote', outline: '- y' }] } });
  await h.wait(20);

  const docs = h.localDocs();
  assert.equal(docs.find(doc => doc._id === 'card:race').title, 'edited after request');
  assert.ok(docs.some(doc => doc._id === 'card:remote'));
  h.run('flushServerStore()');
  await h.wait(20);
});

test('筛选空状态对用户提供的标签内容进行 HTML 转义', async () => {
  const h = createSandbox();
  await settle(h);
  await h.runAsync(`(async () => {
    await saveCard({ id: '', title: '安全测试卡', outline: '- 内容', tags: ['safe'], due_date: localDay() });
    view = 'library';
    await render();
  })()`);
  h.el('tagFilter').value = '<img src=x onerror=alert(1)>';
  h.run(`document.querySelectorAll = selector => selector === '.library-row[data-card-row]' ? [{
    dataset: { search: 'card', tags: 'safe', bag: '0', due: '2026-01-01', score: '0', created: '2026-01-01', title: 'card' },
    textContent: 'card', hidden: false
  }] : []`);
  h.run('filterLibrary()');

  const html = h.el('libraryEmptyResult').innerHTML;
  assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
});

test('localStorage 配额错误会提示用户并拒绝写入', async () => {
  const h = createSandbox();
  await settle(h);
  h.sandbox.localStorage.setItem = () => {
    const error = new Error('quota exceeded');
    error.name = 'QuotaExceededError';
    throw error;
  };

  await assert.rejects(
    h.runAsync(`(async () => db.put({ _id: 'card:quota', type: 'card', title: 'T', outline: 'O' }))()`),
    /本地存储空间已满/
  );
  assert.match(h.el('toast').textContent, /本地存储空间已满/);
});

test('导入遇到本地存储配额错误时不会留下部分导入数据', async () => {
  const h = createSandbox();
  await settle(h);
  const key = 'studystyle-fallback-v1';
  const before = h.storage.get(key);
  h.sandbox.localStorage.setItem = () => {
    const error = new Error('quota exceeded');
    error.name = 'QuotaExceededError';
    throw error;
  };

  await h.runAsync(`(async () => importData({ text: async () => JSON.stringify({ docs: [
    { _id: 'card:import-1', type: 'card', title: 'one', outline: '- one' },
    { _id: 'card:import-2', type: 'card', title: 'two', outline: '- two' }
  ] }) }))()`);

  assert.equal(h.storage.get(key), before);
  assert.match(h.el('toast').textContent, /本地存储空间已满/);
});

test('getReviews tolerates legacy entries without reviewed_at', async () => {
  const h = createSandbox();
  await settle(h);
  await h.runAsync(`(async () => {
    await db.put({ _id: 'review:legacy', type: 'review', card_id: 'card:1', memory_score: 70 });
  })()`);
  const reviews = await h.runAsync('getReviews()');
  assert.equal(reviews.length, 1);
  assert.equal(reviews[0].reviewed_at, undefined);
});

/* 项目 data/ 不得被本文件污染 */
test('R21 回归测试全部使用临时目录，项目 data/ 不被写入', async () => {
  const dataDir = path.join(root, 'data');
  if (!fs.existsSync(dataDir)) return;
  assert.deepEqual(fs.readdirSync(dataDir).filter(name => name.includes('.corrupt.')), []);
});


test('R22 客户端增量 delta 同步：仅推送变更文档并正确合入其他设备新增', async t => {
  const srv = await startServer();
  t.after(() => srv.close());

  await putJson(srv.base, {
    docs: [
      { _id: 'settings:main', type: 'settings', study_method: 'blurting', updated_at: '2026-01-01T00:00:00.000Z' },
      card('c1', { updated_at: '2026-01-01T00:00:00.000Z' }),
      card('c2', { updated_at: '2026-01-01T00:00:00.000Z' })
    ]
  });

  const h = createSandbox({
    serverHook: async call => {
      if (call.method === 'GET') {
        const res = await fetch(`${srv.base}${call.url || '/api/store'}`);
        return { ok: res.ok, status: res.status, body: await res.json() };
      }
      const res = await fetch(`${srv.base}/api/store`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(call.body)
      });
      return { ok: res.ok, status: res.status, body: await res.json() };
    }
  });
  await settle(h);
  h.fetchCalls.length = 0;

  // 本地仅修改 c1，应该以 delta 模式推送且仅含 c1
  await h.runAsync(`(async () => {
    const c = await db.get('c1');
    c.title = 'c1 本地微调';
    await db.put(c);
  })()`);
  await h.wait(450);

  const puts = h.putCalls();
  assert.equal(puts.length, 1);
  assert.equal(puts[0].body.mode, 'delta');
  assert.deepEqual(puts[0].body.docs.map(d => d._id), ['c1'], 'delta 模式应只发送被修改的 c1');

  const srvAfter = await getStore(srv.base);
  assert.deepEqual(srvAfter.docs.map(d => d._id).sort(), ['c1', 'c2', 'settings:main']);
  assert.equal(srvAfter.docs.find(d => d._id === 'c1').title, 'c1 本地微调');
});

test('R23 原生 IndexedDB 存储迁移与本轮错题回炉（requeueSameSession）', async () => {
  const idbData = new Map();
  const mockIdb = {
    open() {
      const storeNames = new Set();
      const dbObj = {
        objectStoreNames: { contains: name => storeNames.has(name) },
        createObjectStore(name) { storeNames.add(name); return {}; },
        transaction(_name, _mode) {
          const tx = { oncomplete: null, onerror: null, onabort: null, error: null };
          tx.objectStore = () => ({
            get(key) {
              const req = { result: undefined, onsuccess: null, onerror: null };
              queueMicrotask(() => { req.result = idbData.get(key); req.onsuccess?.(); });
              return req;
            },
            put(value, key) {
              idbData.set(key, value);
              queueMicrotask(() => { tx.oncomplete?.(); });
              return {};
            }
          });
          return tx;
        }
      };
      const openReq = { result: dbObj, onupgradeneeded: null, onsuccess: null, onerror: null, onblocked: null };
      queueMicrotask(() => {
        openReq.onupgradeneeded?.();
        openReq.onsuccess?.();
      });
      return openReq;
    }
  };

  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const h = createSandbox({
    indexedDB: mockIdb,
    initialDocs: [
      { _id: 'settings:main', type: 'settings', scheduler_mode: 'adaptive', hold_interval_below_score: 60, study_method: 'blurting', updated_at: '2026-01-01T00:00:00.000Z' },
      card('c-requeue', { type: 'card', archived_at: null, title: '错题回炉卡', outline: '- **要点**', due_date: today, interval_index: 0, latest_memory_score: null, updated_at: '2026-01-01T00:00:00.000Z' })
    ]
  });
  await settle(h);

  // 验证启动时已自动将 localStorage 旧库迁入 IndexedDB 并清理旧键
  assert.equal(h.run('getLocalStorageBackendName()'), 'indexeddb');
  assert.equal(h.storage.get('studystyle-fallback-v1'), undefined, '迁移后应清理 bloated localStorage 旧键');
  assert.equal(h.storage.get('studystyle-idb-migrated-v1'), '1');
  assert.ok(Array.isArray(idbData.get('docs')) && idbData.get('docs').some(d => d._id === 'c-requeue'));

  // 验证低分开启 requeueSameSession 会将该卡追加到本轮队列末尾再次复习
  await h.runAsync(`(async () => {
    await beginReview();
    assert.equal(reviewQueue.length, 1);
    await selectScore(30, 1);
    requeueSameSession = true;
    await saveReview({ preventDefault() {} });
    assert.equal($('#reviewDialog').open, true, '加入错题回炉后弹窗不应提前关闭');
    assert.equal(reviewQueue.length, 2, '同一张卡应被追加到本轮队列末尾');
    assert.equal(reviewIndex, 1);
    await selectScore(80, 3);
    requeueSameSession = false;
    await saveReview({ preventDefault() {} });
    assert.equal($('#reviewDialog').open, false, '第二次抽查通过后应正常结束本轮');
  })()`);
});

test('R24 零上限分流保护、遗留无效历史容错、saveReview 防连击锁与 keepalive 冲刷', async () => {
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const dueCards = Array.from({ length: 18 }, (_, i) =>
    card(`c-cap-${i}`, {
      type: 'card',
      archived_at: null,
      title: `上限卡 ${i}`,
      outline: '- test',
      due_date: today,
      interval_index: 0,
      latest_memory_score: null,
      updated_at: '2026-01-01T00:00:00.000Z'
    })
  );
  const h = createSandbox({
    initialDocs: [
      { _id: 'settings:main', type: 'settings', daily_review_limit: 0, scheduler_mode: 'adaptive', hold_interval_below_score: 60, study_method: 'blurting', updated_at: '2026-01-01T00:00:00.000Z' },
      ...dueCards,
      { _id: 'rev:legacy-broken', type: 'review', card_id: 'c-cap-0' }
    ]
  });
  await settle(h);

  // 1) daily_review_limit === 0 ("不设上限") 时 balanceOverdueNow 不得按默认 15 张偷偷分流
  await h.runAsync('balanceOverdueNow()');
  const dueAfter = h.localDocs().filter(d => d.type === 'card' && d.due_date === today);
  assert.equal(dueAfter.length, 18, 'daily_review_limit=0 时应保留全部到期卡片，不能按 15 张上限分流');

  // 2) renderHistory 遇到缺 reviewed_at / memory_score / next_due_date 的遗留记录不得渲染 Invalid Date 或 NaN%
  await h.runAsync(`(async () => {
    view = 'history';
    await render();
  })()`);
  const historyHtml = h.el('viewRoot').innerHTML;
  assert.ok(historyHtml.includes('未知日期'));
  assert.ok(historyHtml.includes('时间未记录'));
  assert.ok(historyHtml.includes('未评分'));
  assert.equal(historyHtml.includes('Invalid Date'), false);
  assert.equal(historyHtml.includes('NaN'), false);
  assert.equal(historyHtml.includes('null%'), false);
  assert.equal(historyHtml.includes('undefined%'), false);

  // 3) saveReview 并发连击时只写入 1 条复习记录
  await h.runAsync(`(async () => {
    await beginReview();
    await selectScore(80, 3);
    await Promise.all([
      saveReview({ preventDefault() {} }),
      saveReview({ preventDefault() {} })
    ]);
  })()`);
  const reviewDocs = h.localDocs().filter(d => d.type === 'review' && !d._deleted);
  assert.equal(reviewDocs.length, 2, '原有 1 条 + 本次连击仅保存 1 条，共计 2 条');

  // 4) flushServerStore({ keepalive: true }) 必须向 fetch 传递 keepalive 标记
  h.fetchCalls.length = 0;
  await h.runAsync(`(async () => {
    await db.put({ _id: 'c-keepalive', type: 'card', title: '关闭前冲刷', outline: '- a', due_date: '${today}', interval_index: 0 });
    flushServerStore({ keepalive: true });
  })()`);
  await settle(h);
  const keepalivePut = h.putCalls().find(c => c.keepalive === true);
  assert.ok(keepalivePut, 'pagehide/beforeunload 路径应透传 keepalive: true');
});

test('R25 saveNotebookFromDialog 并发防连击、markdownToHtml 无内联缩进与视图零静态 inline style', async () => {
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const h = createSandbox({
    initialDocs: [
      {
        _id: 'settings:main',
        type: 'settings',
        notebooks: [{ name: '默认笔记本', color: 'indigo' }, { name: '旧科目', color: 'emerald' }],
        updated_at: '2026-01-01T00:00:00.000Z'
      },
      card('c-r25', {
        type: 'card',
        archived_at: null,
        notebook: '旧科目',
        title: '笔记本测试卡',
        outline: '- 一级要点\n  - 二级要点',
        due_date: today,
        interval_index: 0,
        latest_memory_score: 80,
        updated_at: '2026-01-01T00:00:00.000Z'
      })
    ]
  });
  await settle(h);

  // 1) markdownToHtml 嵌套列表应转为 md-indent-* 类，不得产出内联 style=""；有序列表应保留 <ol>
  const mdHtml = h.run("markdownToHtml('- 一级要点\\n  - 二级要点\\n    - 三级要点\\n1. 编号一\\n  2. 缩进编号二')");
  assert.ok(mdHtml.includes('md-indent-1'));
  assert.ok(mdHtml.includes('md-indent-2'));
  assert.ok(mdHtml.includes('<ul>') && mdHtml.includes('<ol>'));
  assert.equal(mdHtml.includes('style='), false);

  // 2) saveNotebookFromDialog 并发连击只执行一次批量改名
  await h.runAsync(`(async () => {
    await openNotebookDialog('旧科目');
    assert.ok($('#notebookOldName'));
    $('#notebookNameInput').value = '新科目';
    let bulkCalls = 0;
    const origBulk = db.bulkDocs.bind(db);
    db.bulkDocs = (...args) => { bulkCalls++; return origBulk(...args); };
    await Promise.all([
      saveNotebookFromDialog({ preventDefault() {} }),
      saveNotebookFromDialog({ preventDefault() {} })
    ]);
    assert.equal(bulkCalls, 1, '并发连击 saveNotebookFromDialog 只应执行 1 次批量更新');
    assert.equal($('#saveNotebookBtn').disabled, false, '保存完成后应恢复按钮可点击状态');
  })()`);

  const updatedCard = h.localDocs().find(d => d._id === 'c-r25');
  assert.equal(updatedCard.notebook, '新科目');

  // 3) settings / library / history 视图不应包含静态 style="..." 属性
  for (const targetView of ['settings', 'library', 'history']) {
    await h.runAsync(`(async () => {
      view = '${targetView}';
      await render();
    })()`);
    const viewHtml = h.el('viewRoot').innerHTML;
    assert.equal(/\bstyle\s*=/.test(viewHtml), false, `${targetView} 视图不应包含内联 style 属性`);
  }
});

test('R26 跳过防连击与随机续抽、弹窗内撤销不截断队列、脏日期容错与串行推送防伪冲突', async t => {
  const srv = await startServer();
  t.after(() => srv.close());

  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  await putJson(srv.base, {
    docs: [
      { _id: 'settings:main', type: 'settings', study_method: 'blurting', updated_at: '2026-01-01T00:00:00.000Z' },
      card('c-q1', { type: 'card', archived_at: null, title: '队列卡 1', outline: '- ==**加粗词**==', due_date: today, interval_index: 0, latest_memory_score: null, updated_at: '2026-01-01T00:00:00.000Z' }),
      card('c-q2', { type: 'card', archived_at: null, title: '队列卡 2', outline: '- 要点 2', due_date: today, interval_index: 0, latest_memory_score: null, updated_at: '2026-01-01T00:00:00.000Z' }),
      card('c-q3', { type: 'card', archived_at: null, title: '队列卡 3', outline: '- 要点 3', due_date: today, interval_index: 0, latest_memory_score: null, updated_at: '2026-01-01T00:00:00.000Z' }),
      card('c-arch-bad', { type: 'card', archived_at: 123456, title: '脏归档卡', outline: '- x', due_date: 'bad-date', interval_index: 0, latest_memory_score: null, updated_at: '2026-01-01T00:00:00.000Z' })
    ]
  });

  let delayFirstPut = true;
  const h = createSandbox({
    serverHook: async call => {
      if (call.method === 'GET') {
        const res = await fetch(`${srv.base}${call.url || '/api/store'}`);
        return { ok: res.ok, status: res.status, body: await res.json() };
      }
      if (delayFirstPut) {
        delayFirstPut = false;
        await new Promise(r => setTimeout(r, 120));
      }
      const res = await fetch(`${srv.base}/api/store`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(call.body)
      });
      return { ok: res.ok, status: res.status, body: await res.json() };
    }
  });
  await settle(h);

  // 1) markdownToHtml 挖空按钮 aria-label 剥离内部 HTML 标签
  const mdOut = h.run("markdownToHtml('==**加粗重点**==')");
  assert.ok(mdOut.includes('aria-label="挖空：加粗重点，点击显示答案"'));
  assert.ok(mdOut.includes('<strong>加粗重点</strong></button>'));

  // 2) fmtDate / fmtDue / renderLibrary 容错非法 due_date 与非字符串 archived_at
  assert.equal(h.run("fmtDate('not-a-date')"), '未安排');
  assert.equal(h.run("fmtDue({ due_date: 'not-a-date' })").includes('Invalid Date'), false);
  await h.runAsync("(async () => { view = 'library'; await render(); })()");
  const libHtml = h.el('viewRoot').innerHTML;
  assert.ok(libHtml.includes('未知日期'));
  assert.equal(libHtml.includes('Invalid Date'), false);

  // 3) skipCurrentCard 防连击锁 + 弹窗内 undoLastReview 保留后续复习队列
  await h.runAsync(`(async () => {
    await beginReview();
    assert.equal(reviewQueue.length, 3);
    await Promise.all([skipCurrentCard(), skipCurrentCard()]);
    assert.equal(reviewIndex, 1, '连击跳过只应前进 1 张');
    assert.equal(reviewQueue[reviewIndex]._id, 'c-q2');
    await undoLastReview();
    assert.equal(reviewIndex, 0, '撤销后应回到刚才那张');
    assert.equal(reviewQueue.length, 3, '弹窗内撤销不得截断后续待复习队列');
    assert.equal(reviewQueue[reviewIndex]._id, 'c-q1');
  })()`);
  const reviewsAfterUndo = h.localDocs().filter(d => d.type === 'review' && !d._deleted);
  assert.equal(reviewsAfterUndo.length, 0, '连击跳过仅生成 1 条记录且撤销后应已被标记删除');

  // 4) skipCurrentCard 在随机模式下应抽出下一张而不是结束会话
  await h.runAsync(`(async () => {
    await beginRandomReview();
    assert.equal($('#reviewDialog').open, true);
    await skipCurrentCard();
    assert.equal($('#reviewDialog').open, true, '随机模式跳过后应继续抽下一张');
    assert.equal(randomDrawCount, 2);
  })()`);

  // 5) 串行推送队列：两次紧邻 pushServerStoreNow 不得带同一个旧 base_rev 撞出伪合并冲突
  await h.runAsync("flushServerStore()");
  await h.wait(200);
  h.fetchCalls.length = 0;
  await h.runAsync(`(async () => {
    const c1 = await db.get('c-q1');
    const c2 = await db.get('c-q2');
    const p1 = pushServerStoreNow([...(await allDocs())], new Set([c1._id]));
    const p2 = pushServerStoreNow([...(await allDocs())], new Set([c2._id]));
    await Promise.all([p1, p2]);
  })()`);
  for (let i = 0; i < 40 && (h.putCalls().length < 2 || h.run('Boolean(pushInFlightPromise)')); i++) await h.wait(25);
  const serialPuts = h.putCalls();
  assert.equal(serialPuts.length, 2);
  assert.notEqual(serialPuts[0].body.base_rev, serialPuts[1].body.base_rev, '第二次推送必须等待第一次拿到新 rev 再发，绝不重复携带旧 base_rev');

  // 6) hydrateFromServerStore 准确返回 { changed }
  const noChange = await h.runAsync("hydrateFromServerStore({ incremental: true })");
  assert.equal(noChange.changed, false);
  await putJson(srv.base, {
    docs: [card('c-remote-new', { title: '远端新增卡', outline: '- z', due_date: today, updated_at: '2026-12-01T00:00:00.000Z' })],
    base_rev: (await getStore(srv.base)).rev,
    mode: 'delta'
  });
  const withChange = await h.runAsync("hydrateFromServerStore({ incremental: true })");
  assert.equal(withChange.changed, true);
});

test('R27 tags 非数组容错与导入归一化、已删卡片历史不污染默认本、批量建卡防连击及 remove 参数校验', async t => {
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const h = createSandbox({
    initialDocs: [
      { _id: 'settings:main', type: 'settings', updated_at: '2026-01-01T00:00:00.000Z' },
      card('c-existing', { type: 'card', archived_at: null, title: '旧卡片', outline: '- old', due_date: today, interval_index: 0, latest_memory_score: null, updated_at: '2026-01-01T00:00:00.000Z' }),
      card('c-dirty-tags', { type: 'card', archived_at: null, title: '异常字符串标签卡', outline: '- outline', tags: '化学，实验', notebook: '化学', due_date: today, interval_index: 0, latest_memory_score: null, updated_at: '2026-01-01T00:00:00.000Z' }),
      card('c-num-tags', { type: 'card', archived_at: null, title: '数字标签默认本卡', outline: '- outline', tags: 12345, notebook: '默认笔记本', due_date: today, interval_index: 0, latest_memory_score: null, updated_at: '2026-01-01T00:00:00.000Z' }),
      { _id: 'rev-live-default', type: 'review', card_id: 'c-num-tags', reviewed_at: '2026-11-10T09:00:00.000Z', memory_score: 80, updated_at: '2026-11-10T09:00:00.000Z' },
      { _id: 'rev-deleted-math', type: 'review', card_id: 'c-deleted-math', reviewed_at: '2026-11-10T10:00:00.000Z', memory_score: 40, note: '已删数学卡记录', updated_at: '2026-11-10T10:00:00.000Z' }
    ]
  });
  await settle(h);

  // 1) 非数组 tags 渲染 Today / Library 与打开编辑弹窗不得抛 TypeError
  for (const targetView of ['today', 'library']) {
    await h.runAsync(`(async () => { view = '${targetView}'; await render(); })()`);
    const html = h.el('viewRoot').innerHTML;
    assert.ok(html.includes('异常字符串标签卡'));
    assert.ok(html.includes('化学'));
    assert.ok(html.includes('数字标签默认本卡'));
  }
  await h.runAsync(`(async () => {
    await openCardDialog(await db.get('c-dirty-tags'));
    assert.equal($('#cardTags').value || $('#cardForm').elements.tags.value, '化学, 实验');
    $('#cardDialog').close();
    await openCardDialog(await db.get('c-num-tags'));
    assert.equal($('#cardForm').elements.tags.value, '');
    $('#cardDialog').close();
  })()`);

  // 2) importData 归一化字符串 tags、忽略 _deleted 条目并保留已存在卡更新
  const importPayload = JSON.stringify({
    docs: [
      { _id: 'c-existing', type: 'card', title: '覆盖后的旧卡', outline: '- new', tags: '英语, 核心', notebook: '英语', due_date: today },
      { _id: 'c-tombstone-skip', type: 'card', title: '死卡不应导入', outline: '- x', _deleted: true, due_date: today },
      { _id: 'rev-tombstone-skip', type: 'review', card_id: 'c-existing', reviewed_at: '2026-11-11T09:00:00.000Z', _deleted: true }
    ]
  });
  h.sandbox.__importFile = { text: async () => importPayload };
  await h.runAsync('importData(__importFile)');
  const importedCard = h.localDocs().find(d => d._id === 'c-existing');
  assert.equal(importedCard.title, '覆盖后的旧卡');
  assert.deepEqual(importedCard.tags, ['英语', '核心']);
  assert.equal(h.localDocs().some(d => d._id === 'c-tombstone-skip'), false, '_deleted 条目不得被 importData 写入');
  assert.equal(h.localDocs().some(d => d._id === 'rev-tombstone-skip'), false);

  // 3) 筛选具体科目笔记本时，已删卡片历史记录不得归入默认笔记本；全部科目下仍可见
  await h.runAsync(`(async () => {
    activeNotebookFilter = '默认笔记本';
    activeHistoryCardFilter = null;
    view = 'history';
    await render();
  })()`);
  const defaultHistoryHtml = h.el('viewRoot').innerHTML;
  assert.ok(defaultHistoryHtml.includes('数字标签默认本卡'));
  assert.equal(defaultHistoryHtml.includes('已删数学卡记录'), false, '已删除卡片的复习记录不得污染默认笔记本历史');
  assert.equal(defaultHistoryHtml.includes('已删除卡片'), false);

  await h.runAsync(`(async () => {
    activeNotebookFilter = null;
    view = 'history';
    await render();
  })()`);
  assert.ok(h.el('viewRoot').innerHTML.includes('已删除卡片'));

  // 4) batchCreateFromMarkdown 并发连击只提交 1 次
  await h.runAsync(`(async () => {
    view = 'library';
    await render();
    $('#batchMdInput').value = '# 批量卡一\\n- 要点一\\n# 批量卡二\\n- 要点二';
    $('#batchMdTags').value = '高频，重点';
    let bulkCalls = 0;
    const origBulk = db.bulkDocs.bind(db);
    db.bulkDocs = (...args) => { bulkCalls++; return origBulk(...args); };
    await Promise.all([batchCreateFromMarkdown(), batchCreateFromMarkdown()]);
    assert.equal(bulkCalls, 1, '并发连击 batchCreateFromMarkdown 只应批量创建 1 次');
    assert.equal($('#runBatchImportBtn').disabled, false);
  })()`);
  const createdBatchCards = h.localDocs().filter(d => !d._deleted && d.type === 'card' && d.title.startsWith('批量卡'));
  assert.equal(createdBatchCards.length, 2);
  assert.deepEqual(createdBatchCards[0].tags, ['高频', '重点']);

  // 5) createLocalStore().remove 拒绝非法 _id
  await assert.rejects(() => h.runAsync("db.remove({ _id: 'bad\"id' })"), /非法的文档 _id/);
});

test('R28 migrateLocalDocsToPouch 双向墓碑不复活与 scheduleSyncRender 防打断聚焦输入', async () => {
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const h = createSandbox({
    initialDocs: [
      { _id: 'settings:main', type: 'settings', updated_at: '2026-01-01T00:00:00.000Z' },
      { _id: 'c-deleted-on-server', _deleted: true, updated_at: '2026-11-12T00:00:00.000Z', deleted_at: '2026-11-12T00:00:00.000Z' },
      card('c-deleted-in-pouch', { type: 'card', archived_at: null, title: '已在Pouch删除卡', outline: '- p', due_date: today, updated_at: '2026-11-10T00:00:00.000Z' }),
      card('c-live', { type: 'card', archived_at: null, title: '正常存活卡', outline: '- ok', due_date: today, updated_at: '2026-11-10T00:00:00.000Z' })
    ]
  });
  await settle(h);

  // 构造既有 PouchDB：含一张在服务端已删但 PouchDB 仍存活的卡，以及一张在 PouchDB 已删（reason: 'deleted'）的卡
  const pouchStore = new Map([
    ['c-deleted-on-server', { _id: 'c-deleted-on-server', _rev: '1-old', type: 'card', title: '服务端已删但Pouch残留', outline: '- x', due_date: today, updated_at: '2026-11-01T00:00:00.000Z' }],
    ['c-deleted-in-pouch', { _id: 'c-deleted-in-pouch', _rev: '2-del', _deleted: true }]
  ]);
  h.sandbox.PouchDB = function MockMigrationPouch() {
    this.allDocs = async () => ({
      rows: [...pouchStore.values()].filter(d => !d._deleted).map(d => ({ doc: { ...d } }))
    });
    this.get = async id => {
      const doc = pouchStore.get(id);
      if (!doc) throw { status: 404, name: 'not_found', reason: 'missing' };
      if (doc._deleted) throw { status: 404, name: 'not_found', reason: 'deleted' };
      return { ...doc };
    };
    this.put = async doc => {
      const copy = { ...doc, _rev: `2-${Math.random().toString(16).slice(2, 8)}` };
      pouchStore.set(copy._id, copy);
      return { ok: true, id: copy._id, rev: copy._rev };
    };
    this.changes = () => ({ on() { return this; }, cancel() {} });
  };

  await h.runAsync('migrateLocalDocsToPouch()');
  assert.equal(Boolean(pouchStore.get('c-deleted-on-server')?._deleted), true, 'fallbackDocs 中的删除墓碑必须同步删除既有 PouchDB 中的残留存活卡');
  assert.equal(Boolean(pouchStore.get('c-deleted-in-pouch')?._deleted), true, '已在 PouchDB 删除的卡片不得被旧 fallbackDocs 复活');
  assert.equal(pouchStore.get('c-live')?.title, '正常存活卡');

  // scheduleSyncRender：当用户正在 #viewRoot 内的输入框打字时延后重绘，失焦后再执行重绘
  const focusedInput = { tagName: 'INPUT' };
  h.el('viewRoot').contains = node => node === focusedInput;
  h.sandbox.document.activeElement = focusedInput;
  h.el('viewRoot').innerHTML = 'USER_TYPING_SNAPSHOT';
  h.run('scheduleSyncRender()');
  await h.wait(300);
  assert.equal(h.el('viewRoot').innerHTML, 'USER_TYPING_SNAPSHOT', '输入框聚焦期间后台同步不得冲掉 #viewRoot');
  h.sandbox.document.activeElement = null;
  await h.wait(320);
  assert.notEqual(h.el('viewRoot').innerHTML, 'USER_TYPING_SNAPSHOT', '失焦后应自动完成延后的同步重绘');
});

test('R29 批量迁库/离线Pouch切换、切回前台重连、列表插标光标与快捷键404兜底', async () => {
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const h = createSandbox({
    onLine: false,
    initialDocs: [
      { _id: 'settings:main', type: 'settings', updated_at: '2026-01-01T00:00:00.000Z' },
      card('c-batch-new', { type: 'card', archived_at: null, title: '新增批量迁移卡', outline: '- a', due_date: today, updated_at: '2026-11-12T00:00:00.000Z' }),
      card('c-batch-deleted', { type: 'card', archived_at: null, title: 'Pouch已删卡', outline: '- b', due_date: today, updated_at: '2026-11-10T00:00:00.000Z' })
    ]
  });
  await settle(h);

  // 1) insertMarkdownFormat('list') 无选区时选区范围不得倒置（选中占位文本「要点内容」）
  const ta = h.el('cardOutline');
  ta.value = '';
  ta.selectionStart = 0;
  ta.selectionEnd = 0;
  let capturedRange = null;
  ta.setSelectionRange = (s, e) => { capturedRange = [s, e]; };
  h.run(`insertMarkdownFormat('list')`);
  assert.equal(ta.value, '- 要点内容');
  assert.deepEqual(capturedRange, [2, 6], '插入列表占位符应选中「要点内容」，不能出现 selectionEnd < selectionStart');

  // 2) migrateLocalDocsToPouch 优先走 allDocs({ keys }) + bulkDocs，不退化为 N 次串行 get()
  const gottenIds = [];
  let bulkCalls = 0;
  let syncCalls = 0;
  const pouchMap = new Map([
    ['c-batch-deleted', { _id: 'c-batch-deleted', _rev: '2-del', _deleted: true }]
  ]);
  h.sandbox.PouchDB = function BatchMockPouch() {
    this.allDocs = async (opts = {}) => {
      if (Array.isArray(opts.keys)) {
        return {
          rows: opts.keys.map(k => {
            const d = pouchMap.get(k);
            if (!d) return { key: k, error: 'not_found' };
            if (d._deleted) return { id: k, key: k, value: { rev: d._rev, deleted: true } };
            return { id: k, key: k, value: { rev: d._rev }, doc: { ...d } };
          })
        };
      }
      return { rows: [...pouchMap.values()].filter(d => !d._deleted).map(d => ({ doc: { ...d } })) };
    };
    this.get = async id => {
      gottenIds.push(id);
      const d = pouchMap.get(id);
      if (!d) throw { status: 404, name: 'not_found', reason: 'missing' };
      if (d._deleted) throw { status: 404, name: 'not_found', reason: 'deleted' };
      return { ...d };
    };
    this.bulkDocs = async list => {
      bulkCalls++;
      for (const item of list) {
        const saved = { ...item, _rev: `1-${Math.random().toString(16).slice(2, 8)}` };
        pouchMap.set(saved._id, saved);
      }
      return list.map(d => ({ ok: true, id: d._id }));
    };
    this.put = async d => ({ ok: true, id: d._id, rev: '1-p' });
    this.changes = () => ({ on() { return this; }, cancel() {} });
    this.info = async () => ({ db_name: 'studystyle' });
    this.remove = async () => ({ ok: true });
    this.sync = () => { syncCalls++; return { on() { return this; }, cancel() {} }; };
  };
  h.storage.set('studystyle-couch-local-v1', JSON.stringify({ mode: 'proxy', name: 'studystyle', autoConnect: true }));

  await h.runAsync('resumeSavedCouchSync()');
  assert.equal(h.run('pouchMode'), true, '离线冷启动有已保存 Couch 配置时也应切到本地 PouchDB');
  assert.equal(gottenIds.includes('c-batch-new'), false, '支持 allDocs({ keys }) 时不应逐条调用 pouch.get');
  assert.equal(gottenIds.includes('c-batch-deleted'), false, '支持 allDocs({ keys }) 时不应逐条探测墓碑');
  assert.equal(bulkCalls, 1, '迁移写入应合并为单次 bulkDocs 事务');
  assert.equal(pouchMap.has('c-batch-new'), true);
  assert.equal(pouchMap.get('c-batch-deleted')._deleted, true);
  assert.equal(syncCalls, 0, '离线模式下不应触发远端复制');

  // 3) 切回前台 visibilitychange -> visible 时，若 syncHandler 为空应自动调用 resumeSavedCouchSync 重连
  h.sandbox.navigator.onLine = true;
  h.sandbox.document.visibilityState = 'visible';
  for (const fn of h.docListeners.visibilitychange || []) fn();
  await h.wait(150);
  assert.equal(syncCalls, 1, '切回前台 visible 时若 syncHandler 断开应自动恢复 CouchDB 同步');

  // 4) 复习弹窗按 E 键编辑已删卡片时，捕获 404 并温和提示而非未捕获异常
  h.el('reviewDialog').open = true;
  h.run(`reviewQueue = [{ _id: 'c-missing-during-review' }]; reviewIndex = 0;`);
  for (const fn of h.docListeners.keydown || []) {
    await fn({
      key: 'e',
      code: 'KeyE',
      isComposing: false,
      target: { tagName: 'DIV', matches: () => false },
      preventDefault() {}
    });
  }
  assert.match(h.el('toast').textContent, /删除|同步/);
});

test('R30 表单提交异常提示与复习 409 冲突自动重拉合并', async () => {
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const h = createSandbox({
    initialDocs: [
      { _id: 'settings:main', type: 'settings', updated_at: '2026-01-01T00:00:00.000Z' },
      card('c-conflict', { type: 'card', archived_at: null, title: '冲突测试卡', outline: '- 要点', due_date: today, updated_at: '2026-11-10T00:00:00.000Z' })
    ]
  });
  await settle(h);

  // 1) saveCardFromDialog 遇写入错误时弹窗 toast 提示，不得静默卡死
  await h.runAsync(`(async () => {
    await openCardDialog(await db.get('c-conflict'));
    const origPut = db.put.bind(db);
    db.put = async () => { throw { status: 409, name: 'conflict', message: 'Document update conflict' }; };
    try {
      await saveCardFromDialog({ preventDefault() {} });
    } finally {
      db.put = origPut;
    }
  })()`);
  assert.match(h.el('toast').textContent, /冲突|其他设备|刷新/);
  assert.equal(h.el('cardDialog').open, true, '保存失败时不该关闭编辑弹窗丢失用户输入');

  // 2) saveNotebookFromDialog 遇错误时 toast 提示并恢复锁状态
  await h.runAsync(`(async () => {
    await openNotebookDialog();
    $('#notebookNameInput').value = '异常笔记本';
    const origPut = db.put.bind(db);
    db.put = async () => { throw new Error('磁盘只读'); };
    try {
      await saveNotebookFromDialog({ preventDefault() {} });
    } finally {
      db.put = origPut;
    }
  })()`);
  assert.match(h.el('toast').textContent, /保存笔记本失败.*磁盘只读/);
  assert.equal(h.run('isSavingNotebook'), false);

  // 3) saveReview 遇卡片在另一端被删（404）时 toast 提示且解锁按钮
  await h.runAsync(`(async () => {
    reviewQueue = [{ _id: 'c-gone-during-review' }];
    reviewIndex = 0;
    selectedScore = 80;
    $('#reviewDialog').open = true;
    await saveReview({ preventDefault() {} });
  })()`);
  assert.match(h.el('toast').textContent, /删除|同步/);
  assert.equal(h.run('isSavingReview'), false);
  assert.equal(h.el('saveReview').disabled, false);

  // 4) saveReview 在 db.bulkDocs 返回卡文档 409 冲突时自动重拉最新 _rev 重试写入，且不重复创建第二条 review
  await h.runAsync(`(async () => {
    reviewQueue = [await db.get('c-conflict')];
    reviewIndex = 0;
    selectedScore = 80;
    $('#reviewDialog').open = true;
    $('#reviewForm').elements.recall.value = '回忆内容';
    globalThis.__bulkAttempts = 0;
    globalThis.__putRetryCardRev = '';
    const origBulk = db.bulkDocs.bind(db);
    const origGet = db.get.bind(db);
    const origPut = db.put.bind(db);
    db.bulkDocs = async list => {
      globalThis.__bulkAttempts++;
      if (globalThis.__bulkAttempts === 1) {
        const revDoc = list.find(d => d.type === 'review');
        await origBulk([revDoc]);
        return [
          { id: 'c-conflict', error: true, status: 409, name: 'conflict' },
          { id: revDoc._id, ok: true, rev: '1-rev' }
        ];
      }
      return origBulk(list);
    };
    db.get = async id => {
      const doc = await origGet(id);
      return { ...doc, _rev: '9-latest-from-couch' };
    };
    db.put = async doc => {
      globalThis.__putRetryCardRev = doc._rev;
      return origPut(doc);
    };
    try {
      await saveReview({ preventDefault() {} });
    } finally {
      db.bulkDocs = origBulk;
      db.get = origGet;
      db.put = origPut;
    }
  })()`);
  assert.equal(h.sandbox.__bulkAttempts, 1, 'review 首次已成功，重试时不应二次提交 bulkDocs 产生重复复习记录');
  assert.equal(h.sandbox.__putRetryCardRev, '9-latest-from-couch', '冲突重试必须带最新 _rev 合并写回卡片');
  const updatedConflictCard = h.localDocs().find(d => d._id === 'c-conflict');
  assert.equal(updatedConflictCard.latest_memory_score, 80);
  const reviewsForConflict = h.localDocs().filter(d => !d._deleted && d.type === 'review' && d.card_id === 'c-conflict');
  assert.equal(reviewsForConflict.length, 1, '409 冲突重试后只应保留 1 条复习记录');
});

test('R31 撤销复习/跳过容错、删本防连击 409 重试与复习中编辑 404 兜底', async () => {
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const h = createSandbox({
    initialDocs: [
      { _id: 'settings:main', type: 'settings', notebooks: [{ name: '旧科目', color: 'indigo' }], updated_at: '2026-01-01T00:00:00.000Z' },
      card('c-r31-a', { type: 'card', archived_at: null, title: '并发卡A', notebook: '旧科目', outline: '- 要点', due_date: today, updated_at: '2026-11-10T00:00:00.000Z' })
    ]
  });
  await settle(h);

  // 1) undoLastReview 写入失败时保留快照并弹窗提示，随后遇到 409 冲突可自动带最新 _rev 完成撤销
  await h.runAsync(`(async () => {
    await beginReview();
    await selectScore(80, 3);
    await saveReview({ preventDefault() {} });
    assert.ok(lastReviewSnapshot, '保存后应保留撤销快照');

    const origBulk = db.bulkDocs.bind(db);
    const origGet = db.get.bind(db);
    const origPut = db.put.bind(db);
    db.bulkDocs = async () => { throw new Error('短暂写入失败'); };
    try {
      await undoLastReview();
    } finally {
      db.bulkDocs = origBulk;
    }
    assert.ok(lastReviewSnapshot, '撤销失败时不得提前丢弃撤销快照');
    assert.equal(isSavingReview, false);

    let putRev = '';
    db.bulkDocs = async () => [{ id: 'c-r31-a', error: true, status: 409, name: 'conflict' }];
    db.get = async id => {
      const doc = await origGet(id);
      return doc ? { ...doc, _rev: '12-remote-rev' } : doc;
    };
    db.put = async doc => {
      putRev = doc._rev;
      return origPut(doc);
    };
    try {
      await undoLastReview();
    } finally {
      db.bulkDocs = origBulk;
      db.get = origGet;
      db.put = origPut;
    }
    globalThis.__undoRetryRev = putRev;
  })()`);
  assert.match(h.el('toast').textContent, /已撤销|短暂写入失败/);
  assert.equal(h.run('lastReviewSnapshot'), null, '撤销真正成功后才应清空快照');
  assert.equal(h.sandbox.__undoRetryRev, '12-remote-rev');

  // 2) skipCurrentCard 遇异常时提示用户并释放按钮/锁
  await h.runAsync(`(async () => {
    reviewQueue = [await db.get('c-r31-a')];
    reviewIndex = 0;
    $('#reviewDialog').open = true;
    const origBulk = db.bulkDocs.bind(db);
    db.bulkDocs = async () => { throw new Error('跳过写入异常'); };
    try {
      await skipCurrentCard();
    } finally {
      db.bulkDocs = origBulk;
    }
  })()`);
  assert.match(h.el('toast').textContent, /跳过卡片失败.*跳过写入异常/);
  assert.equal(h.run('isSavingReview'), false);
  assert.equal(h.el('skipCard').disabled, false);

  // 3) deleteNotebook 迁移遇到 409 冲突会自动重拉最新 _rev 归入默认笔记本，再删除设置项
  await h.runAsync(`(async () => {
    askConfirm = async () => true;
    const origBulk = db.bulkDocs.bind(db);
    const origGet = db.get.bind(db);
    const origPut = db.put.bind(db);
    let migratedRev = '';
    db.bulkDocs = async () => [{ id: 'c-r31-a', error: true, status: 409, name: 'conflict' }];
    db.get = async id => {
      const doc = await origGet(id);
      return doc ? { ...doc, _rev: '15-nb-conflict' } : doc;
    };
    db.put = async doc => {
      migratedRev = doc._rev;
      return origPut(doc);
    };
    try {
      await deleteNotebook('旧科目');
    } finally {
      db.bulkDocs = origBulk;
      db.get = origGet;
      db.put = origPut;
    }
    globalThis.__nbMigrateRev = migratedRev;
  })()`);
  assert.equal(h.sandbox.__nbMigrateRev, '15-nb-conflict');
  assert.equal(h.localDocs().find(d => d._id === 'c-r31-a')?.notebook, '默认笔记本');
  assert.equal(h.run('isSavingNotebook'), false);

  // 4) 复习中目标卡片在别处被删后，点击编辑只给友好提示不抛 404
  await h.runAsync(`(async () => {
    reviewQueue = [{ _id: 'c-deleted-elsewhere' }];
    reviewIndex = 0;
    await openCurrentReviewCardEditor();
  })()`);
  assert.match(h.el('toast').textContent, /已被删除|尚未同步/);
});
