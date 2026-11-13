const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawn } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const storeName = 'studystyle-db.json';

let createStudyStyleServer;
let tmpRoots = [];

test.before(async () => {
  // server.mjs 为 ESM，从 CJS 用动态 import 引入（Windows 必须用 file:// URL）
  ({ createStudyStyleServer } = await import(pathToFileURL(path.join(root, 'server.mjs')).href));
});

test.after(async () => {
  for (const dir of tmpRoots) await fsp.rm(dir, { recursive: true, force: true });
});

async function makeDataDir() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'studystyle-test-'));
  tmpRoots.push(dir);
  return dir;
}

// 在临时目录上启动真实 HTTP 服务，避免污染项目 data/
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

// 起真实子进程，验证环境变量（STORE_TOKEN / DATA_DIR）这条部署路径
async function startServerProcess(env = {}) {
  const dataDir = env.DATA_DIR || (await makeDataDir());
  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: root,
    env: { ...process.env, PORT: '0', HOST: '127.0.0.1', DATA_DIR: dataDir, ...env }
  });
  const port = await new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => reject(new Error('服务端启动超时')), 10000);
    child.stdout.on('data', chunk => {
      buffer += chunk;
      const matched = buffer.match(/running at http:\/\/[^:]+:(\d+)/);
      if (matched) {
        clearTimeout(timer);
        resolve(Number(matched[1]));
      }
    });
    child.on('error', err => {
      clearTimeout(timer);
      reject(err);
    });
  });
  return {
    dataDir,
    port,
    base: `http://127.0.0.1:${port}`,
    storeFile: path.join(dataDir, storeName),
    stop: () => new Promise(resolve => {
      child.on('exit', resolve);
      child.kill('SIGTERM');
    })
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

// 1 & 2：非法入参必须 400，且绝不清空既有数据
test('非法入参返回 400 且不改动服务端数据', async t => {
  const srv = await startServer();
  t.after(() => srv.close());

  await putJson(srv.base, { docs: [card('a')] });
  const before = await (await fetch(`${srv.base}/api/store`)).json();

  const notArray = await putJson(srv.base, { docs: '不是数组' });
  assert.equal(notArray.status, 400);
  assert.equal((await notArray.json()).ok, false);

  const missing = await putJson(srv.base, {});
  assert.equal(missing.status, 400);

  const badElement = await putJson(srv.base, { docs: [{ title: '缺 _id' }] });
  assert.equal(badElement.status, 400);

  const primitiveElement = await putJson(srv.base, { docs: ['字符串元素'] });
  assert.equal(primitiveElement.status, 400);

  const after = await (await fetch(`${srv.base}/api/store`)).json();
  assert.equal(after.docs.length, 1);
  assert.equal(after.docs[0]._id, 'a');
  assert.deepEqual(after.docs, before.docs);
});

// 3：存储文件损坏时备份原文件并返回 500，绝不冒充「无数据」
test('存储文件损坏时返回 500 并保留 .corrupt 备份', async t => {
  const srv = await startServer();
  t.after(() => srv.close());

  const corrupted = '{"docs":[{"_id":"a"';
  await fsp.writeFile(srv.storeFile, corrupted, 'utf8');

  const res = await fetch(`${srv.base}/api/store`);
  assert.equal(res.status, 500);
  const payload = await res.json();
  assert.equal(payload.ok, false);
  assert.match(payload.error, /损坏/);

  const files = await fsp.readdir(srv.dataDir);
  const backups = files.filter(name => name.startsWith(`${storeName}.corrupt.`));
  assert.equal(backups.length, 1);
  // 损坏内容必须原样保留在备份里，不能被空数据覆盖
  assert.equal(await fsp.readFile(path.join(srv.dataDir, backups[0]), 'utf8'), corrupted);

  // 后续读取仍然报 500，不得退化成空数组
  const again = await fetch(`${srv.base}/api/store`);
  assert.equal(again.status, 500);
});

// 4：跨源写请求必须 403
test('跨源 Origin 的写请求被拒绝为 403', async t => {
  const srv = await startServer();
  t.after(() => srv.close());

  await putJson(srv.base, { docs: [card('a')] });

  const res = await putJson(srv.base, { docs: [] }, {
    Origin: 'https://evil.example.com',
    'Content-Type': 'text/plain'
  });
  assert.equal(res.status, 403);

  const after = await (await fetch(`${srv.base}/api/store`)).json();
  assert.equal(after.docs.length, 1);
});

// 5：配置 STORE_TOKEN 后必须带正确令牌
test('STORE_TOKEN 生效时缺少令牌返回 401、携带正确令牌返回 200', async t => {
  const srv = await startServerProcess({ STORE_TOKEN: 'secret-token' });
  t.after(() => srv.stop());

  const missing = await putJson(srv.base, { docs: [card('a')] });
  assert.equal(missing.status, 401);

  const wrong = await putJson(srv.base, { docs: [card('a')] }, { 'X-Store-Token': 'wrong' });
  assert.equal(wrong.status, 401);

  const ok = await putJson(srv.base, { docs: [card('a')] }, { 'X-Store-Token': 'secret-token' });
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).count, 1);

  const read = await fetch(`${srv.base}/api/store`);
  assert.equal(read.status, 401);
});

// 6：base_rev 不匹配时执行三方合并，双方卡片都要保留
test('base_rev 不匹配时执行合并而非整库覆盖', async t => {
  const srv = await startServer();
  t.after(() => srv.close());

  await putJson(srv.base, { docs: [card('a'), card('b')] });
  const serverRev = (await (await fetch(`${srv.base}/api/store`)).json()).rev;

  // 客户端基于旧 rev 推入 1 张新卡
  const res = await putJson(srv.base, { docs: [card('c')], base_rev: 'r0' });
  assert.equal(res.status, 200);
  const payload = await res.json();
  assert.equal(payload.merged, true);
  assert.equal(payload.count, 3);

  const merged = await (await fetch(`${srv.base}/api/store`)).json();
  assert.equal(merged.docs.length, 3);
  assert.deepEqual(merged.docs.map(d => d._id).sort(), ['a', 'b', 'c']);
  assert.notEqual(merged.rev, serverRev);
});

// 7：base_rev 匹配时走单设备直接替换
test('base_rev 匹配时直接替换整库', async t => {
  const srv = await startServer();
  t.after(() => srv.close());

  await putJson(srv.base, { docs: [card('a'), card('b')] });
  const { rev } = await (await fetch(`${srv.base}/api/store`)).json();

  const res = await putJson(srv.base, { docs: [card('z')], base_rev: rev });
  assert.equal(res.status, 200);
  const payload = await res.json();
  assert.equal(payload.merged, false);
  assert.equal(payload.count, 1);

  const current = await (await fetch(`${srv.base}/api/store`)).json();
  assert.deepEqual(current.docs.map(d => d._id), ['z']);
});

// 7b：不带 base_rev 的写入视为「整库替换」（向后兼容老客户端）
// 注意：本项目自己的客户端已改为「无 rev 时先 GET 再推」，不会走到这条路径；
// 这条断言只为记录服务端对外部老客户端的兼容行为，不代表推荐用法。
test('不带 base_rev 的写入保持整库替换（兼容外部老客户端）', async t => {
  const srv = await startServer();
  t.after(() => srv.close());

  await putJson(srv.base, { docs: [card('a'), card('b')] });
  const res = await putJson(srv.base, { docs: [card('c')] });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).merged, false);

  const current = await (await fetch(`${srv.base}/api/store`)).json();
  assert.deepEqual(current.docs.map(d => d._id), ['c']);
});

// 7b-1：删除通过墓碑传播，服务端旧副本不会被「复活」
test('删除以墓碑形式传播，服务端不会复活已删除的卡片', async t => {
  const srv = await startServer();
  t.after(() => srv.close());

  await putJson(srv.base, { docs: [{ ...card('a'), updated_at: '2026-01-01T00:00:00.000Z' }] });
  // 故意用陈旧 rev 触发合并路径（模拟另一台设备持有的旧快照）
  const res = await putJson(srv.base, {
    base_rev: 'r0',
    docs: [{ _id: 'a', _deleted: true, updated_at: '2026-06-01T00:00:00.000Z' }]
  });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).merged, true);

  // 服务端保留墓碑而不再保留活文档，避免下次合并把卡片复活
  const current = await (await fetch(`${srv.base}/api/store`)).json();
  assert.equal(current.docs.length, 1);
  assert.equal(current.docs[0]._id, 'a');
  assert.equal(current.docs[0]._deleted, true);
});

// 7b-2：任何写入都必须推进 rev，否则乐观锁失效（两台设备会互相整库覆盖）
test('每次写入都推进 rev，确保乐观锁在直接替换路径同样生效', async t => {
  const srv = await startServer();
  t.after(() => srv.close());

  const revs = [];
  for (let i = 0; i < 3; i++) {
    const res = await putJson(srv.base, { docs: [card(`c${i}`)] });
    revs.push((await res.json()).rev);
  }
  assert.equal(new Set(revs).size, 3, `rev 未推进: ${revs.join(',')}`);

  // 设备B 持有最早的 rev，后续任何写入都会让它失配 → 走合并而非覆盖
  const staleRev = revs[0];
  const merged = await putJson(srv.base, { docs: [card('from-b')], base_rev: staleRev });
  assert.equal((await merged.json()).merged, true);
});

// 7c：同一张卡两边都有时按 updated_at 取新，相同则保留服务端版本
test('合并同一张卡时 updated_at 较新的一方胜出，相同时保留服务端版本', async t => {
  const srv = await startServer();
  t.after(() => srv.close());

  await putJson(srv.base, { docs: [card('a', { title: '服务端', updated_at: '2026-01-01T00:00:00.000Z' })] });
  const { rev } = await (await fetch(`${srv.base}/api/store`)).json();

  // 客户端版本更新 → 客户端胜出
  await putJson(srv.base, {
    docs: [card('a', { title: '客户端较新', updated_at: '2026-06-01T00:00:00.000Z' })],
    base_rev: 'r0'
  });
  let current = await (await fetch(`${srv.base}/api/store`)).json();
  assert.equal(current.docs.length, 1);
  assert.equal(current.docs[0].title, '客户端较新');

  // 客户端版本更旧 → 服务端版本保留
  await putJson(srv.base, {
    docs: [card('a', { title: '客户端较旧', updated_at: '2025-01-01T00:00:00.000Z' })],
    base_rev: 'r0'
  });
  current = await (await fetch(`${srv.base}/api/store`)).json();
  assert.equal(current.docs[0].title, '客户端较新');

  // updated_at 完全相同 → 保留服务端版本（服务端权威）
  const serverVersion = current.docs[0];
  await putJson(srv.base, {
    docs: [card('a', { title: '客户端同时间不同内容', updated_at: serverVersion.updated_at })],
    base_rev: 'r0'
  });
  current = await (await fetch(`${srv.base}/api/store`)).json();
  assert.equal(current.docs[0].title, serverVersion.title);
});

// 8：非法 JSON 请求体返回 400
test('请求体不是合法 JSON 时返回 400', async t => {
  const srv = await startServer();
  t.after(() => srv.close());

  const res = await putJson(srv.base, '{"docs": [');
  assert.equal(res.status, 400);
  assert.equal((await res.json()).ok, false);
});

// 9：超大请求体返回 413
test('超出体积上限的请求体返回 413', async t => {
  const srv = await startServer({ maxBodyBytes: 1024 });
  t.after(() => srv.close());

  const res = await putJson(srv.base, { docs: [card('a', { blob: 'x'.repeat(4096) })] });
  assert.equal(res.status, 413);
  assert.equal((await res.json()).ok, false);
});

// 10：GET 返回体必须带 rev 字段
test('GET /api/store 返回 rev 与 docs', async t => {
  const srv = await startServer();
  t.after(() => srv.close());

  await putJson(srv.base, { docs: [card('a')] });
  const payload = await (await fetch(`${srv.base}/api/store`)).json();
  assert.equal(payload.ok, true);
  assert.equal(typeof payload.rev, 'string');
  assert.ok(payload.rev.length > 0);
  assert.equal(payload.docs.length, 1);
});

// 11：响应必须带齐 5 个安全响应头
test('响应包含 5 个安全响应头', async t => {
  const srv = await startServer();
  t.after(() => srv.close());

  const api = await fetch(`${srv.base}/api/store`);
  const page = await fetch(`${srv.base}/index.html`);
  for (const res of [api, page]) {
    assert.ok(res.headers.get('content-security-policy'), '缺少 CSP');
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('x-frame-options'), 'DENY');
    assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
    assert.ok(res.headers.get('permissions-policy'), '缺少 Permissions-Policy');
  }
  assert.match(api.headers.get('content-security-policy'), /https:\/\/cdn\.jsdelivr\.net/);
});

test('正常请求日志包含路径和状态码，不包含学习文档内容', async t => {
  const entries = [];
  const srv = await startServer({ logger: { log: line => entries.push(line), error: line => entries.push(String(line)) } });
  t.after(() => srv.close());
  const privateTitle = 'private study note 7f3a';

  const response = await putJson(srv.base, { docs: [card('a', { title: privateTitle })] });
  assert.equal(response.status, 200);
  assert.ok(entries.some(line => line.includes('PUT /api/store 200')));
  assert.ok(entries.every(line => !line.includes(privateTitle)));
});

// 附加：错误码分级
test('错误码分级：405 带 Allow 头、415 拒绝非 JSON、404 静态资源缺失', async t => {
  const srv = await startServer();
  t.after(() => srv.close());

  const notAllowed = await fetch(`${srv.base}/api/store`, { method: 'POST' });
  assert.equal(notAllowed.status, 405);
  assert.match(notAllowed.headers.get('allow'), /PUT/);

  const badType = await fetch(`${srv.base}/api/store`, {
    method: 'PUT',
    headers: { 'Content-Type': 'text/plain' },
    body: JSON.stringify({ docs: [] })
  });
  assert.equal(badType.status, 415);

  const missing = await fetch(`${srv.base}/not-exist.html`);
  assert.equal(missing.status, 404);

  const ok = await fetch(`${srv.base}/api/store`);
  assert.equal(ok.status, 200);
});

// 附加：读操作也做 Origin 校验，防止跨站读取学习数据
test('跨源 GET 请求被拒绝为 403', async t => {
  const srv = await startServer();
  t.after(() => srv.close());

  const res = await fetch(`${srv.base}/api/store`, { headers: { Origin: 'https://evil.example.com' } });
  assert.equal(res.status, 403);
});

// 附加：并发写必须串行落盘，不出现文件损坏或丢写
test('并发写请求全部成功且存储文件保持合法 JSON', async t => {
  const srv = await startServer();
  t.after(() => srv.close());

  const responses = await Promise.all(
    Array.from({ length: 10 }, (_, i) => putJson(srv.base, { docs: [card(`c${i}`)] }))
  );
  for (const res of responses) assert.equal(res.status, 200);

  const raw = await fsp.readFile(srv.storeFile, 'utf8');
  const parsed = JSON.parse(raw);
  assert.ok(Array.isArray(parsed.docs));
  assert.equal(parsed.docs.length, 1);
  assert.equal(typeof parsed.rev, 'string');
});

// 附加：健康检查与静态资源仍然可用
test('健康检查与静态资源不受加固影响', async t => {
  const srv = await startServer();
  t.after(() => srv.close());

  const health = await fetch(`${srv.base}/healthz`);
  assert.equal(health.status, 200);
  assert.equal((await health.json()).status, 'ok');

  const index = await fetch(`${srv.base}/`);
  assert.equal(index.status, 200);
  assert.match(index.headers.get('content-type'), /text\/html/);

  const assets = await Promise.all(['styles.css', 'app.js', 'domain.cjs', 'favicon.svg', 'manifest.webmanifest', 'sw.js', 'apple-touch-icon.png', 'icon-192.png', 'icon-512.png', 'icon-maskable-512.png'].map(
    name => fetch(`${srv.base}/${name}`)
  ));
  for (const res of assets) assert.equal(res.status, 200);
});

// 附加：PWA 清单、Service Worker 与 PNG 图标响应头与内容合法
test('PWA 清单、Service Worker 与图标接口可用', async t => {
  const srv = await startServer();
  t.after(() => srv.close());

  const manifestRes = await fetch(`${srv.base}/manifest.webmanifest`);
  assert.equal(manifestRes.status, 200);
  assert.match(manifestRes.headers.get('content-type'), /application\/manifest\+json/);
  const manifest = await manifestRes.json();
  assert.equal(manifest.display, 'standalone');
  assert.ok(manifest.icons.some(i => i.sizes === '192x192' && i.type === 'image/png'));
  assert.ok(manifest.icons.some(i => i.sizes === '512x512' && i.purpose === 'maskable'));

  const swRes = await fetch(`${srv.base}/sw.js`);
  assert.equal(swRes.status, 200);
  assert.match(swRes.headers.get('content-type'), /javascript/);
  const swText = await swRes.text();
  assert.match(swText, /\/api\//);

  for (const iconName of ['apple-touch-icon.png', 'icon-192.png', 'icon-512.png', 'icon-maskable-512.png']) {
    const iconRes = await fetch(`${srv.base}/${iconName}`);
    assert.equal(iconRes.status, 200);
    assert.equal(iconRes.headers.get('content-type'), 'image/png');
    const bytes = new Uint8Array(await iconRes.arrayBuffer());
    assert.deepEqual([...bytes.slice(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10], `${iconName} 应为合法 PNG`);
  }
});

// 附加：删除墓碑必须能传播，否则服务端残留的旧卡片会被「复活」
test('删除墓碑（_deleted）在合并时胜出，旧卡片不被复活', async t => {
  const srv = await startServer();
  t.after(() => srv.close());

  await putJson(srv.base, { docs: [card('card:1', { updated_at: '2026-01-01T00:00:00.000Z' })] });
  const { rev } = await (await fetch(`${srv.base}/api/store`)).json();

  // 客户端B 删除 card:1，写入墓碑（updated_at 更新）
  await putJson(srv.base, {
    docs: [card('card:1', { _deleted: true, updated_at: '2026-06-01T00:00:00.000Z' })],
    base_rev: rev
  });

  // 客户端A 手上有旧副本（未删除），用失配的 base_rev 推上来 —— 墓碑必须胜出
  await putJson(srv.base, {
    docs: [card('card:1', { title: '客户端A的旧副本', updated_at: '2026-01-01T00:00:00.000Z' })],
    base_rev: 'r0'
  });

  const current = await (await fetch(`${srv.base}/api/store`)).json();
  const doc = current.docs.find(d => d._id === 'card:1');
  assert.ok(doc, 'card:1 不应凭空消失');
  assert.equal(doc._deleted, true, '墓碑应保留，旧卡片不得复活');
});

// 附加：墓碑必须原样透传给客户端，否则删除意图无法传播到其它设备
test('GET 透传墓碑，客户端据此得知其它设备的删除', async t => {
  const srv = await startServer();
  t.after(() => srv.close());

  await putJson(srv.base, { docs: [card('a'), card('b')] });
  await putJson(srv.base, {
    docs: [card('a'), card('b', { _deleted: true, updated_at: '2026-06-01T00:00:00.000Z' })],
    base_rev: 'r0'
  });

  const current = await (await fetch(`${srv.base}/api/store`)).json();
  const tombstone = current.docs.find(d => d._id === 'b');
  assert.ok(tombstone, '服务端必须保留 b 的墓碑');
  assert.equal(tombstone._deleted, true, '墓碑必须原样返回给客户端，否则删除无法跨设备传播');
});

// 附加：缺 updated_at 时不得让客户端编辑被旧数据覆盖（架构审计 P0-3）
test('客户端文档缺少 updated_at 时以客户端版本为准', async t => {
  const srv = await startServer();
  t.after(() => srv.close());

  // 服务端存着无时间戳的「老数据」
  await putJson(srv.base, { docs: [{ _id: 'card:1', title: '老数据原样' }] });

  // 客户端编辑后推送（带时间戳），rev 失配走合并 —— 客户端编辑必须保留
  await putJson(srv.base, {
    docs: [card('card:1', { title: '客户端编辑后的新内容', updated_at: '2026-06-01T00:00:00.000Z' })],
    base_rev: 'r0'
  });

  const current = await (await fetch(`${srv.base}/api/store`)).json();
  assert.equal(current.docs[0].title, '客户端编辑后的新内容', '客户端编辑被老数据覆盖了');
});

// 附加：客户端无戳、服务端有戳时服务端胜出（老数据不得盖掉服务端新数据）
test('客户端文档缺少 updated_at 而服务端有戳时保留服务端版本', async t => {
  const srv = await startServer();
  t.after(() => srv.close());

  await putJson(srv.base, { docs: [card('a', { updated_at: '2026-06-01T00:00:00.000Z' })] });
  await putJson(srv.base, {
    docs: [{ _id: 'a', title: '客户端的无戳旧数据' }],
    base_rev: 'r0'
  });

  const current = await (await fetch(`${srv.base}/api/store`)).json();
  assert.equal(current.docs[0].title, '卡片 a', '服务端新数据被客户端无戳旧数据覆盖了');
});

// 附加：_id 会进入 HTML 属性，必须限定字符集
test('_id 含非法字符时返回 400 且不写入', async t => {
  const srv = await startServer();
  t.after(() => srv.close());

  await putJson(srv.base, { docs: [card('card:1')] });
  const before = (await (await fetch(`${srv.base}/api/store`)).json()).docs.length;

  for (const badId of ['card onload=alert(1)', 'a"b', 'a<b', 'x'.repeat(129)]) {
    const res = await putJson(srv.base, { docs: [card(badId)] });
    assert.equal(res.status, 400, `应拒绝 _id=${badId.slice(0, 20)}`);
    assert.equal((await res.json()).ok, false);
  }

  const after = (await (await fetch(`${srv.base}/api/store`)).json()).docs.length;
  assert.equal(after, before, '非法 _id 不得写入任何数据');
});

// 附加：项目 data/ 目录未被测试污染
test('测试全部使用临时目录，项目 data/ 不被写入', () => {
  const dataDir = path.join(root, 'data');
  if (!fs.existsSync(dataDir)) return;
  const entries = fs.readdirSync(dataDir);
  assert.deepEqual(entries.filter(name => name.includes('.corrupt.')), []);
});
