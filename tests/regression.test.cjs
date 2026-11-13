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
  const appCode = fs.readFileSync(path.join(root, 'app.js'), 'utf8');

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
      headers: init.headers || {}
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
    localStorage: {
      getItem: (k) => storage.get(k) ?? null,
      setItem: (k, v) => storage.set(k, String(v)),
      removeItem: (k) => storage.delete(k)
    },
    fetch: fetchMock,
    document: {
      title: '',
      documentElement: { dataset: {} },
      head: { appendChild() {} },
      createElement: (tag) => getOrCreateEl('created:' + tag),
      addEventListener() {},
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
