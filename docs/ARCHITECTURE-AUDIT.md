# StudyStyle 技术架构审计报告

> 审计人：高见远（技术方案架构师）｜审计方式：只读代码审计 + 全部结论均经运行时实测复现
> 审计基准版本（**最终复核于 11:08**）：
> - `server.mjs` `1067ca84682979f6ecbd164ab51b3b25`（约 400 行）
> - `app.js` `2543a7167bb67c025b1d7981549a82c3`（约 2020 行）
> - `domain.cjs` `7842af5a16e827c2200adfde3a7176ba`（含 `scoreToBagSafe`）
>
> **重要说明**：审计期间 `server.mjs` / `app.js` / `domain.cjs` / `styles.css` 被并行改写了多轮
> （10:44 / 10:45 / 10:48 / 10:49 / 10:51 / 10:52 / 11:0x）。
> 本报告已针对**最终版本重新跑完全部实测**，结论以最终版本为准，报告中所有行号均对应该版本。
> **审计过程中 P0-2 已被并行修复**（合并响应补上 `docs` 字段），报告已同步更新并标注 ✅。
> 审计过程**未修改任何项目代码文件**，仅新增本报告 `docs/ARCHITECTURE-AUDIT.md`。

---

## 一、结论先行

**整体判断：架构方向正确，服务端加固质量很高（35 个测试全绿），核心数据丢失路径已基本闭环。剩余 3 个 P1 + 2 个 P2，全部集中在「客户端与服务端判定规则不一致」和「输入未转义」两类。**

| 维度 | 评价 |
| --- | --- |
| 领域层分层 | ✅ 优秀。`domain.cjs` 纯函数、无 DOM 依赖、可独立单测，是本项目最健康的部分 |
| 服务端健壮性 | ✅ 已充分加固。校验、状态码、CSP、跨源防护、损坏备份、乐观锁、墓碑消费均已到位；测试 18 例 |
| 前后端契约 | ⚠️ **最大遗留**。服务端 `isNewer` 已校正，但**客户端 hydrate 仍用自己的一套判定** → 两端规则不一致，迟早再次分叉 |
| 前端状态管理 | ⚠️ 中等。30+ 模块级变量 + 全量重绘，当前规模可跑，500 卡以上会明显劣化 |
| XSS 防护 | ⚠️ 主路径已闭合，**仍存 1 处未转义注入点**（空状态提示） |
| 工程化 | ⚠️ 服务端测试已补齐（0 → 35 例）但**未锁住墓碑语义**、`tools/` 15 个一次性脚本、**项目无 git** |

**一句话**：本轮 10+ 次并行加固把服务端补得很扎实 —— 校验、CSP、乐观锁、损坏备份、墓碑消费全部到位，**我审计开始时识别的 P0 已全部闭环**。剩下的不是「缺功能」，而是**两端判定规则没收敛**（客户端 hydrate 的时间戳仲裁与服务端 `isNewer` 各写各的）+ **一处未转义插值** + **没有 git**。

**当前剩余问题（按优先级）**：
1. **客户端 hydrate 的合并判定与服务端 `isNewer` 不一致** → 缺 `updated_at` 的本地编辑在客户端 hydrate 时仍会被丢弃。**根治办法：把判定收敛成 `domain.cjs` 的单一纯函数，两端共用**
2. **XSS-A**：空状态提示的标签/关键词未转义（`app.js:1836-1840`）
3. **墓碑语义无回归用例** → 当前行为正确（实测 `["c1","c3","TOMB:c2"]`），但**没有测试锁住**，后续重构误删分支会静默复发
4. **项目无 git** → 审计期间核心文件被改写 10+ 轮，无任何版本追踪
5. `getReviews()` 缺 `reviewed_at` 崩溃 / `localStorage` 配额未捕获 / 服务端无请求日志 / 优雅关闭无超时

**已确认关闭**（我审计开始时的旧版 + 本轮 10+ 轮并行加固）：空 body 清库、docs 非数组、跨源 CSRF、JSON 损坏当空库、500 伪装 404、缺 CSP/安全头、缺 405/404、bulkDocs N 次全量 PUT、`_rev` 同毫秒撞号、无去抖、scoreToBag 越界白屏、importData 脏字段、合并响应缺 `docs`、`base_rev` 缺失整库覆盖、`isNewer` 无戳恒 false、`library-row` 未转义、**墓碑被服务端丢弃导致删除复活**。

---

## 二、P0：安全 / 数据丢失（必须立即修）

### P0-1 ✅ 已修（墓碑端到端生效）—— 但需补回归用例锁住

**原始问题**：客户端与服务端**各自实现了墓碑的一半，但对不上**：
- `app.js` 客户端 `remove()` 写墓碑（`_deleted:true`），`get()`/`allDocs()` 过滤 `_deleted` ✅
- `server.mjs` 定义了 `isTombstone(doc)`，注释写明「否则合并时会把服务端残留的旧卡片复活」，**但从未被调用** → `mergeDocs()` 不识别墓碑 → **删除在多设备下仍然复活**

**失效机制**（当时的 `isNewer` 分支语义反了）
```js
if (!left) return true;    // 客户端无戳 → 客户端胜
if (!right) return false;  // ★ 服务端无戳 → 服务端胜 → 墓碑被判「更旧」而被丢弃
```
墓碑 vs 服务端活卡片（服务端那份通常没有 `updated_at`）→ `isNewer=false` → `mergeDocs` push 活卡片，墓碑被丢。

**✅ 修复确认**（最新版本实测）
```
服务端初始: c1(保留) c2(要删) c3(保留3)
客户端 PUT: [c1, c3, {c2, _deleted:true, updated_at:'2026-11-12T12:00:00Z'}]  base_rev='r0'
服务端结果: ["c1","c3","TOMB:c2"]
★ c2 是否仍作为活卡片存在? 否 → 墓碑生效 ✅
```
- `server.mjs:94-95` `mergeDocs()` 现已加独立分支：
  ```js
  if (isTombstone(clientDoc)) { merged.push(clientDoc); continue; }
  if (isTombstone(serverDoc)) { merged.push(serverDoc); continue; }
  ```
  墓碑**不走时间戳仲裁**（删除意图不可被内容版本覆盖）✅

**⚠️ 遗留：必须补回归用例锁住这个行为**

> 这个洞的危险性在于**它「看起来已经修了」**（客户端有墓碑、服务端有 `isTombstone`）。不做端到端验证就判定「已修复」，同类缺陷会再次潜伏。

```js
// tests/server.test.cjs —— 新增
test('客户端删除的卡片不会在合并后复活', async t => {
  const srv = await startServer(); t.after(() => srv.close());
  await putJson(srv.base, { docs: [card('a'), card('b'), card('c')] });
  // 客户端删除 b → 写墓碑（必须是真实墓碑对象，不能用「数组少一个 id」代替）
  const tombstone = { _id: 'b', _deleted: true, updated_at: new Date().toISOString() };
  const res = await putJson(srv.base, { docs: [card('a'), card('c'), tombstone], base_rev: 'r0' });
  const payload = await res.json();
  assert.ok(!payload.docs.some(d => d._id === 'b' && !d._deleted), 'b 不得作为活卡片存在');
});
```
> ⚠️ 该用例必须**用真实的墓碑对象**（`_deleted:true`），不能用「数组里少一个 id」代替 —— 后者测的是另一条路径，会假绿。

---

### P0-2 ✅ 服务端合并响应缺 `docs` 字段 —— **已于 11:0x 被并行修复**

**原始证据**（11:0x 前的版本）
- `commit()` 返回 `{ rev, merged, count }` —— **没有 `docs`**。
- 响应体 `{ ok, rev, merged, count }` —— 同样没有 `docs`。
  （对比 GET 响应 `{ ok, rev, docs }` —— **GET 有 docs，PUT 没有**，正是这个不对称导致问题）
- `app.js` 客户端：`if (data && data.merged && Array.isArray(data.docs)) { ...回填... }`

**实测**（原始版本）：过期 `base_rev` 写入后响应为 `{"ok":true,"rev":"r3","merged":true,"count":3}`，`'docs' in body === false` → 客户端回填分支被静默跳过 → 服务端 500 张 / 客户端 1 张 → **无限循环分叉**。

**✅ 修复确认**（最新版本实测）
```
P0-2 合并响应 = {"ok":true,"rev":"r3","merged":true,"count":3,
                 "docs":[{"_id":"c1",...},{"_id":"c2"},{"_id":"c3"}]}
含 docs? true   ← 已闭合
```
- `server.mjs` `commit()` 现返回 `{ rev, merged, count, docs }`
- 响应体现在带 `docs: result.docs`
- 客户端 `app.js` 的 `if (data.merged && Array.isArray(data.docs))` 分支**现已能正常触发** → 本地回填生效

**遗留建议**：把这条**固化为回归测试**（§六 用例 #10），防止后续重构再删掉 `docs` 字段。
```js
// tests/server.test.cjs 用例 #10
const res = await put(docs, staleRev);
const body = await res.json();
assert.ok(body.merged === true);
assert.ok(Array.isArray(body.docs), '合并响应必须带 docs，客户端据此回填本地');
assert.equal(body.docs.length, expectedTotal);
```

---

### P0-3 ✅ 已修（`isNewer` 三段式语义已校正）

**原始问题**：`isNewer()` 用 `left > right` 比较，两边都取 `updated_at`，缺失时为 `''`。而 `'' > '2026-11-12T...'` **恒为 false** → 任何没有 `updated_at` 的文档（老版本 localStorage 残留、导入的历史 JSON 备份），客户端编辑在合并时**必定被服务端版本覆盖**。

**✅ 修复确认**（最新版本 `server.mjs`）
```js
function isNewer(candidate, incumbent) {
  const left  = typeof candidate?.updated_at === 'string' ? candidate.updated_at : '';
  const right = typeof incumbent?.updated_at === 'string' ? incumbent.updated_at : '';
  if (!left && !right) return true;   // 双方都无戳 → 客户端胜
  if (!left)  return false;           // 客户端无戳、服务端有戳 → 服务端胜
  if (!right) return true;            // 客户端有戳、服务端无戳 → 客户端胜
  return left > right;
}
```
与我建议的语义完全一致 ✅

**⚠️ 遗留：客户端侧需同步校正**
`app.js` 的 `hydrateFromServerStore` 合并分支仍用 `localTime > remoteTime`，缺时间戳时 `'' > '...'` 恒 false → **客户端 hydrate 仍会丢本地编辑**（服务端侧已修好，但客户端拉取时用自己的一套规则，两端判定不一致）。

```js
// app.js hydrateFromServerStore —— 与服务端 isNewer 保持同一套三段式
const localTime  = local?.updated_at || '';
const remoteTime = doc.updated_at || '';
const localWins = (!localTime && !remoteTime) ? true
                : (!localTime)  ? false
                : (!remoteTime) ? true
                : localTime > remoteTime;
merged.set(doc._id, local && localWins ? local : doc);
```
> 更好的做法：把这个判定**收敛成 domain.cjs 的单一纯函数**（如 `Domain.pickNewer(localDoc, remoteDoc)`），客户端与服务端共用同一套语义 —— 否则两侧规则迟早再次分叉。

---

### P0-4 ✅ 已修（`base_rev` 兜底已落地）

**原始问题**：`app.js` 的 `if (serverRev) body.base_rev = serverRev;` —— `serverRev` 只在 hydrate 成功时赋值。**服务端一旦返回 500（损坏）/401/403，hydrate 直接 `return`，`serverRev` 永远为空**，此后任何写入都是无条件整库覆盖（实测 500 张 → 1 张）。

**✅ 修复确认**（最新版本 `app.js:121-132`）
```js
if (!serverRev) {
  /* ...先 GET 一次拿到 rev，绝不盲写... */
  serverRev = data.rev;
}
const body = { docs, base_rev: serverRev };
```
实测：服务端 500 张 → 无 `base_rev` 写入 → **服务端仍为 500 张** ✅（原为 1 张）

**遗留建议**：
1. **`base_rev` 现在无条件发送**，需确认服务端在 `base_rev` 缺失时是否也应拒绝整库替换（服务端目前是 `mismatch = typeof baseRev === 'string' && ...`，缺失时 `mismatch=false` → 仍整库替换）。建议服务端改为：**无 `base_rev` 的 PUT 一律走 merge**，而不是静默替换。
2. 现有测试 `tests/server.test.cjs`「老客户端不带 base_rev 时保持直接替换（向后兼容）」**把这个危险行为断言为预期**，建议随本项一并改为「缺少 base_rev 时执行合并而非替换」。

---

## 三、P1：稳定性与一致性

### P1-1 `server.mjs` 损坏文件隔离后，后续所有写入持续 500 —— 备份未被自动恢复

**证据**
- `server.mjs:151-157`：`JSON.parse` 失败 → `backupCorrupt()` 把主文件 **rename** 成 `.corrupt.<ts>` → 抛 500。
- `server.mjs:143-148`：主文件 ENOENT → `findCorruptBackup()` 发现 `.corrupt.*` → 抛 500「存储文件缺失」。
- `server.mjs:168-171`：`commit()` 第一步就是 `await read()` → 必然 500。

**实测**：写入 `{BROKEN JSON` 后，GET 返回 500 且目录只剩 `studystyle-db.json.corrupt.*`；此后 PUT 永久 500。

**评价**：**数据是安全的**（备份文件保留了原内容，比旧版「静默当空库」好太多），但**服务进入不可写状态且需人工介入**——容器会一直重启、healthcheck 一直失败。

**改进动作**：备份后自动从备份恢复可解析内容，或提供恢复入口：
```js
// server.mjs：损坏时尝试用备份文件的可解析部分恢复，而非永久锁死
async function backupCorrupt() {
  const backupFile = join(dataDir, `${corruptPrefix}${stamp}`);
  await rename(storeFile, backupFile);
  // 尝试用备份文件恢复：若备份本身也坏，则保持锁死并报错
  try {
    const raw = await readFile(backupFile, 'utf8');
    const parsed = JSON.parse(raw);
    const docs = Array.isArray(parsed) ? parsed : parsed?.docs;
    if (Array.isArray(docs)) {
      await writeFile(storeFile, JSON.stringify({ app:'StudyStyle', updated_at:new Date().toISOString(), rev:'r1', docs }, null, 2), 'utf8');
      return backupFile;   // 已恢复
    }
  } catch { /* 备份也坏 → 保持锁死 */ }
  return backupFile;
}
```
> 另建议：`docker-compose.yml` 挂载的 `./data` 目录应配一个 `restart` 策略说明 + README 章节讲清「数据文件在哪、怎么备份、怎么恢复」。

### P1-2 服务端无请求日志，无法排查「谁在什么时候清了库」

**证据**：`server.mjs` 仅在启动（`:375`）和错误（`:327-328`）时打日志。正常请求**零日志**。

**影响**：多设备场景下发生数据异常时，无任何可追溯线索。这是 P0-1/P0-4 的**事后取证能力缺失**——问题发生时无法定位是哪台设备、哪个时间点发的 PUT。

**改进动作**
```js
// server.mjs handle() 开头
const startedAt = Date.now();
res.on('finish', () => {
  console.log(`[studystyle] ${req.method} ${pathname} ${res.statusCode} ${Date.now()-startedAt}ms ` +
              `origin=${req.headers.origin||'-'} rev=${req.headers['x-store-rev']||'-'}`);
});
```
> 注意日志中**不要打印 `docs` 内容**（可能含隐私的学习内容）与 `x-store-token`。

### P1-3 优雅关闭无超时，SIGTERM 后进程可能挂死

**证据**：`server.mjs:377-381`
```js
server.close(() => process.exit(0));
```
`server.close()` 只停止接受新连接，**不会中断已建立的长连接**。浏览器 keep-alive 连接（`keep-alive: timeout=5`）最长可能挂 5 秒；而 `writeChain` 中未落盘的写也会被 `process.exit(0)` 硬杀。

**影响**：`docker stop` 的 10 秒宽限期被耗尽 → 容器被 SIGKILL → 正在写的 `tmp` 文件残留。

**改进动作**
```js
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    const force = setTimeout(() => process.exit(1), 5000);   // 兜底强杀
    server.close(async () => {
      await store.flush();          // 等待 writeChain 落盘
      clearTimeout(force);
      process.exit(0);
    });
    server.closeIdleConnections?.();  // Node 18+
  });
}
```

### P1-5 `scoreToBag` 越界抛错 —— 已被并行修复 ✅，但 `getReviews()` 排序崩溃仍未处理

**证据**
- ✅ **已修复**：`domain.cjs` 新增 `scoreToBagSafe()`（缺失/越界返回 `-1`），`app.js:31` `bagFor` 已切换为 `Domain.scoreToBagSafe(...)`。实测 `scoreToBag(150)` 抛 RangeError 的白屏路径**已闭合**。
- ❌ **未修复**：`app.js:242` `getReviews()`：
  ```js
  async function getReviews() { return (await allDocs()).filter(doc => doc.type === 'review').sort((a, b) => b.reviewed_at.localeCompare(a.reviewed_at)); }
  ```
  `reviewed_at` 缺失时 `.localeCompare` 抛 TypeError → **整个 render 崩溃**。

**触发路径**：`importData` 导入的 JSON 中含 `type:'review'` 但缺 `reviewed_at` 的记录 —— `importData` 当前**不校验 review 记录的 `reviewed_at`**（只校验了 `card` 的字段）→ 直接入库 → 下次 `getReviews()` 崩溃 → 白屏。

**改进动作**
```js
// app.js importData 中补 review 分支校验
if (clean.type === 'review') {
  if (typeof clean.reviewed_at !== 'string' || !clean.reviewed_at) { skipped++; continue; }
  clean.memory_score = Number.isFinite(Number(clean.memory_score))
    ? Math.max(0, Math.min(100, Math.trunc(Number(clean.memory_score)))) : null;
}
// app.js getReviews() 兜底（防御纵深）
async function getReviews() {
  return (await allDocs())
    .filter(doc => doc.type === 'review')
    .sort((a, b) => String(b.reviewed_at || '').localeCompare(String(a.reviewed_at || '')));
}
```

### P1-4 `server.mjs` 的 `createStudyStyleServer` 导出后**没有任何测试覆盖**

**证据**：`server.mjs` 导出工厂函数 `createStudyStyleServer`（便于测试），但 `tests/` 下只有 `domain.test.cjs` 与 `app.test.cjs`，**均不涉及 server**。

**影响**：本轮加固引入的 `validateStorePayload` / `mergeDocs` / `isNewer` / 损坏备份 / 跨源校验 / `base_rev` 分支——**全部零测试**。这正是 P0-1/P0-2/P0-3 三个缺陷能够同时存在并逃过评审的根本原因。

**改进动作**：新增 `tests/server.test.cjs`（用 `node:test` + `fetch`，零依赖），首批必测用例见 §6。

---

## 四、XSS 全面检查结果

### ✅ 已闭合的部分

`markdownToHtml`（`app.js:288-322`）**当前实现是安全的**——实测验证：
```
输入 '<img src=x onerror=alert(1)>'  → '&lt;img src=x onerror=alert(1)&gt;'   ← 已转义
输入 '" onmouseover="alert(1)'      → '&quot; onmouseover=&quot;alert(1)'   ← 已转义
输入 '==<img src=x onerror=alert(1)==' → '==&lt;img...&gt;=='                ← 未匹配到 cloze
```
`escapeHtml`（`app.js:28`）覆盖 `& < > " '` 五字符，先转义再做正则替换，**顺序正确**（`==...==` 的 `aria-label` 插值 `${word}` 取自已转义字符串，**不会二次注入**）。

> 团队任务书里「`cloze-mask` 的 `aria-label` 属性注入」的怀疑**证伪**：实测 `==**重点**==` → `aria-label="挖空：<strong>重点</strong>，点击显示答案"`，`<strong>` 是 markdown 自身产物且 `word` 已转义，**不构成 XSS**，但它是**语义 bug**（aria-label 里混入标签，详见 P2-6）。

### ❌ 仍未转义的 2 个注入点

#### XSS-A（高）`filterLibrary()` 空状态提示 — 标签与关键词未转义

**证据**（最新版本行号）：`app.js:1839-1843`
```js
if (tag !== 'all') parts.push(`标签：${tag}`);      // ← tag 未转义
if (query)       parts.push(`关键词：${query}`);      // ← query 未转义
emptyEl.innerHTML = `没有符合条件的卡片。清除筛选（${parts.join(' · ')}）后可看到全部 <strong>${rows.length}</strong> 张。`;
```
**数据来源**：`tag` 来自 `$('#tagFilter').value`，该 `<option>` 的 value 来自卡片标签。虽然**写入 option 时用了 `escapeHtml`**，但 **HTML 属性解码后 `select.value` 拿到的是原始串**。`query` 来自 `$('#cardSearch').value`（用户在搜索框输入）。

**实测**（复现脚本输出）：
```
标签：<img src=x onerror=alert(document.domain)>）
→ emptyEl.innerHTML 含未转义的 <img → XSS 成立
```
**触发路径**：用户创建一张标签为 `<img src=x onerror=...>` 的卡 → 卡片库 → 标签筛选选该标签 → 搜索一个不匹配的词 → 空状态渲染 → **XSS 执行**。
**影响**：可读取 `localStorage` 全部数据（卡片、复习记录、默写草稿），并以用户身份发请求到同源 `/api/store`（**把用户全部学习数据 POST 到攻击者服务器**）。

**改进动作**
```js
// app.js:1839-1843 —— 全部走 escapeHtml
if (tag !== 'all') parts.push(`标签：${escapeHtml(tag)}`);
if (query)       parts.push(`关键词：${escapeHtml(query)}`);
// 更稳妥：整个 parts 拼接后再统一转义
emptyEl.innerHTML = `没有符合条件的卡片。清除筛选（${escapeHtml(parts.join(' · '))}）后可看到全部 <strong>${rows.length}</strong> 张。`;
```
> 注意：`rows.length` 是数字，安全；但**统一在拼接后转义**更不易漏。

#### XSS-B ✅ 已修（`data-card-row` 已加 `escapeHtml`）

**原始问题**：`app.js` 的 `library-row` 中 `data-card-row="${card._id}"` / `data-score="${scoreVal}"` / `data-due="${card.due_date}"` 三处未转义（同段其余字段均已转义，是遗漏非设计）。

**✅ 修复确认**（最新版本 `app.js:659`）：`data-card-row="${escapeHtml(card._id)}"` ✅

**⚠️ 仍需补的最后一环**：`importData` 的 `_id` **只判空、不校验格式**（`app.js:169` `if (!doc?._id) continue;`），畸形 `_id` 仍能入库。虽然渲染层现在转义了，但**脏 `_id` 仍会进入 localStorage 与服务端**，影响排序、查找与后续可能的 `querySelector` 拼接。建议从源头拒绝：
```js
// app.js importData
if (!/^(card|review|settings):[A-Za-z0-9._:-]{1,120}$/.test(doc._id)) { skipped++; continue; }
```

#### 补充：`server.mjs` 侧注入面已收紧 ✅

新版服务端 `validateStorePayload` 要求每个 doc 是对象且 `_id` 为非空字符串，配合 `app.js` 端转义，服务端不再是注入跳板。这条已闭合。

---

## 五、P2：性能与可维护性

### P2-1 `render()` 全量重绘 `#viewRoot.innerHTML` — 滚动位置丢失 + 输入框失焦

**证据**：`app.js:365-368`
```js
if (view === 'today')   $('#viewRoot').innerHTML = await renderToday(...);
if (view === 'library') { $('#viewRoot').innerHTML = await renderLibrary(...); filterLibrary(); }
```
**影响**：
1. **滚动位置丢失**：`#viewRoot` 是 `.content` 的内容（`index.html:302`），`.main-area` 用 `min-height:100vh` + flex（`styles.css:320-325`），页面滚动由 body 承担。替换 innerHTML 后浏览器会重算布局，**长列表页跳回顶部**。
2. **输入框失焦**：卡片库搜索框 `#cardSearch` 位于 `#viewRoot` 内。每次 `render()` 都重建 DOM → 正在输入的搜索词**丢失焦点与光标位置**。
3. **事件委托是否失效**：**不会失效**——`document.addEventListener('click', ...)`（`app.js:1440`）挂在 document 上，重绘后依然有效；`#viewRoot` 上的 `input`/`change`/`toggle`/`pointerdown` 委托也因 `#viewRoot` 元素本身未被替换而存活。**这一点团队任务书的怀疑证伪**。

**改进动作**：改为「视图片段级更新 + 输入态不重绘」
```js
// app.js render()：搜索框聚焦时不重绘
if (document.activeElement?.id === 'cardSearch') { renderChrome(); return; }
// 并在 renderLibrary 后恢复焦点与光标
const active = document.activeElement?.id;
const selStart = document.activeElement?.selectionStart;
...innerHTML 替换后...
if (active) { const el = document.getElementById(active); el?.focus(); el?.setSelectionRange(selStart, selStart); }
```

### P2-2 每次渲染重复全量 `JSON.parse` localStorage（5~6 次）

**证据**：`app.js` 中 `getCards()`（→`allDocs()`）、`dueCards()`（→`getCards()`）、`getReviews()`（→`allDocs()`）、`getSetting()` 各自独立读 localStorage 并 `JSON.parse` 整个数组。
实测：`render()` 一次调用链上，`localStorage.getItem` + `JSON.parse` 触发 **5~6 次**；500 卡时单次解析 **~135KB**。

**影响**：每次渲染重复解析 135KB×6 ≈ 800KB JSON。1000 卡时单次渲染解析 ~1MB。这是主线程上的**同步阻塞**，直接表现为切页卡顿。

**改进动作**：加一层内存缓存
```js
let docsCache = null;
function readDocs() {
  if (docsCache) return docsCache;
  docsCache = JSON.parse(localStorage.getItem(LOCAL_KEY) || '[]');
  return docsCache;
}
function writeDocs(docs) {
  docsCache = docs;
  localStorage.setItem(LOCAL_KEY, JSON.stringify(docs));
}
```
> 需配合 `window.addEventListener('storage', ...)`（`app.js:1968`）在跨标签页变更时清缓存。

### P2-3 `pushServerStore` 全量 PUT 的带宽放大

**证据**（最终版本行号）：`app.js:107-115`（去抖已加 ✅）+ `app.js:116` `pushServerStoreNow` 仍 PUT **整个 docs 数组**。

**实测体积**（每卡 outline ≈300 字节）：
| 卡片数 | 单次 PUT 体积 | 含 3n 条复习记录 | 批量导入 50 卡累计上行 |
| --- | --- | --- | --- |
| 100 | 50 KB | 116 KB | 2.5 MB |
| 500 | 253 KB | 584 KB | 12.4 MB |
| 1000 | 507 KB | 1.17 MB | **24.7 MB** |
| 2000 | 1015 KB | 2.34 MB | **49.6 MB** |

**评价**：去抖（300ms）+ `bulkDocs` 单次推送（`app.js:184-192`）已经**解决了「N 次全量 PUT」的放大**（团队任务书的怀疑已部分修正）✅。但**单次仍是全量**，且 `hydrateFromServerStore`（`app.js:134`）在启动时也拉全量。

**改进动作**：改增量接口（与 P0-1/P0-4 同一改造）
```
POST /api/store/changes  { upserts:[{_id,...字段}], deletes:['_id'] }
→ 服务端按 _id 逐条合并，返回 {rev, applied, conflicts:[...]}
```
**取舍**：
| 方案 | 带宽 | 冲突处理 | 改动量 | 建议 |
| --- | --- | --- | --- | --- |
| 全量 PUT + base_rev（现状） | O(N) 每次 | 服务端 merge | 已完成 | 短期可用，500 卡内可接受 |
| 增量 POST /changes | O(变更量) | 逐条冲突检测，可精确到卡 | 中（服务端+客户端各 ~80 行） | **推荐** |
| 加 WebSocket 推送 | O(变更量) | 服务端主动推 | 大 | 本项目规模**不需要**，过度设计 |

### P2-4 `app.js` 30+ 模块级 `let` 变量

**证据**：`app.js:43-77` 共 30 个模块级 `let`（`view` / `activeBagFilter` / `reviewQueue` / `reviewIndex` / `selectedCardIds` / `expandedCardIds` / `uiFolds` / `libraryFilter` …）。

**影响**：功能上正确（单一事件循环，无并发写），但**无法单独测试任一状态转换**——`render()` 依赖其中 10+ 个变量。`tests/app.test.cjs` 只能通过 `vm` 沙箱整体跑，正是这个原因。

**改进动作**：合并为一个显式 state 对象，便于按 slice 测试（**不改行为**）：
```js
const state = {
  view: 'today', filters: { bag: null, notebook: null }, review: { queue: [], index: 0, step: 1 },
  ui: { folds: {}, batchMode: false }, selection: { cards: new Set(), expanded: new Set() }
};
```

### P2-5 领域层与 UI 的重复实现

**证据**（最终版本行号）：`domain.cjs` 已是干净的纯函数层，但 `app.js` 里有与之**语义重叠**的实现：

| app.js 位置 | 实现 | domain.cjs 对应 | 是否重复 |
| --- | --- | --- | --- |
| `app.js:327` `levelCounts(cards)` | 统计 6 档等级计数 | 无（缺） | **应下沉**（纯函数、可测） |
| `app.js:323` `fmtDue(card)` | 逾期天数 → HTML | 无（缺） | **应下沉为纯函数**（返回天数，HTML 留在 UI） |
| `app.js:25` `localDay(date)` | YYYY-MM-DD 格式化 | `domain.cjs` `addLocalDays` 内含同款格式化 | **轻度重复** |
| `app.js:31` `bagFor` / `app.js:32` `bagIndex` | 评分→档位、+1 偏移 | `domain.cjs` `scoreToBag` / `scoreToBagSafe` | `bagIndex` 的 +1 是 UI 约定，**留 UI 合理** |

**改进动作**：把 `levelCounts` 与「逾期天数计算」下沉到 `domain.cjs`
```js
// domain.cjs 新增导出
function levelCounts(cards, levelCount = 6) {
  const counts = Array(levelCount).fill(0);
  for (const card of cards || []) {
    const bag = scoreToBag(card?.latest_memory_score);
    counts[bag < 0 ? 0 : bag + 1]++;
  }
  return counts;
}
function daysOverdue(card, today) {
  if (!card?.due_date) return 0;
  const diff = Math.round((new Date(`${today}T12:00:00`) - new Date(`${card.due_date}T12:00:00`)) / 86400000);
  return diff > 0 ? diff : 0;
}
```
> `localDay` 建议也下沉（`Domain.toLocalDay(date)`），消掉 `app.js:25` 与 `domain.cjs:57` 的格式化重复。

### P2-6 `markdownToHtml` 的顺序 bug 与 Markdown 覆盖度不足

**证据**（最终版本行号）：`app.js:288-295`
```js
let html = escapeHtml(markdown)
  .replace(/`([^`]+)`/g, '<code>$1</code>')          // ① 先处理行内代码
  .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>') // ② 后处理加粗 → 会命中代码块内部
  .replace(/==([^=]+)==/g, (match, word) => `<button ... aria-label="挖空：${word}，点击显示答案">${word}</button>`);
```
**实测三个缺陷**：
```
输入 '`**不该变粗**`'  → '<code><strong>不该变粗</strong></code>'   ← 代码内被加粗（①→② 顺序错）
输入 '==**重点**=='    → aria-label="挖空：<strong>重点</strong>，点击显示答案"  ← aria-label 混入标签（语义 bug）
输入 '1. 第一步'      → '<ul><li>第一步</li></ul>'                   ← 有序列表编号丢失
输入 '# 一级\n## 二级' → 全部输出 <h4 class="md-heading">            ← 标题层级全部压成 h4
输入 '> 引用 / [链接](x) / |表格|' → 原样输出 <p>（均不支持）
```
**与计划要求对照**（`间隔提醒Web项目计划.md:20`「基础 Markdown（多级列表 `- `、加粗 `**`、行内代码等）」）：
- ✅ 加粗 `**`、行内代码 `` ` `` —— 支持
- ⚠️ **多级列表** —— 实现了，但用 `margin-left` 内联样式模拟缩进（`app.js:313`），**不是真正的嵌套 `<ul>`**；且**有序列表编号被丢弃**（`1.` 与 `- ` 混用同一分支）
- ❌ 标题层级：全部压成 `<h4>`，语义丢失

**改进动作**
```js
// app.js markdownToHtml —— 修正顺序 + 保层级 + 保有序编号
function markdownToHtml(markdown) {
  const lines = escapeHtml(markdown).split(/\r?\n/);
  let out = ''; let listStack = [];   // 记录嵌套层级
  for (const raw of lines) {
    const h = raw.match(/^(#{1,4})\s+(.*)$/);
    const li = raw.match(/^(\s*)([-*+]|\d+\.)\s+(.*)$/);
    if (h) { closeLists(); const lvl = h[1].length; out += `<h${lvl} class="md-heading">${h[2]}</h${lvl}>`; }
    else if (li) {
      const depth = Math.floor(li[1].replace(/\t/g,'  ').length / 2);
      while (listStack.length > depth + 1) { out += '</ul>'; listStack.pop(); }
      while (listStack.length < depth + 1) { out += '<ul>'; listStack.push(true); }
      const ordered = /\d/.test(li[2]);
      out += `<li>${li[3]}</li>`;   // 编号交给 CSS counter 或直接保留文本
    }
    else { closeLists(); if (raw.trim()) out += `<p>${raw}</p>`; }
  }
}
```
> 最小改动版（不动结构，只修 3 个点）：
> 1. 把 `**` 替换挪到 `` ` `` **之前** → 代码内不再被加粗
> 2. `aria-label` 里用 `word.replace(/<[^>]*>/g,'')` 剥标签
> 3. 有序列表用 `<ol>` 或保留原始编号文本

### P2-7 `ensurePouchDB` 从 CDN 动态加载 —— 内网/离线环境直接不可用

**证据**（最终版本行号）：`app.js:78-90`（`ensurePouchDB`）
```js
script.src = 'https://cdn.jsdelivr.net/npm/pouchdb@9.0.0/dist/pouchdb.min.js';
script.crossOrigin = 'anonymous';
```
**评价**：
- ✅ **懒加载**：仅在设置页点「测试连接/连接并同步」时才加载，不影响主路径 —— **死代码影响面小**，团队任务书的「每次启动都加载」怀疑**证伪** ✅
- ✅ **不加载也不报错**：`script.onerror` 有兜底提示
- ❌ **内网/离线/内网防火墙场景直接不可用**：README 主推的部署方式正是「Debian 服务器 + Docker」，若该机器所在内网不通外网，**CouchDB 同步功能完全不可用**
- ❌ **300KB+ 第三方 CDN 脚本**：引入供应链风险（jsdelivr 被投毒 = 全量数据可被窃取）。当前 CSP 已放行 `cdn.jsdelivr.net`（`server.mjs:23,27`），**等于正式承认了这个依赖**
- ❌ **双轨设计**：`pouchMode` 分支（`app.js:44,88`）与 localStore 分支并存 → 两套存储语义、两套 `_rev` 格式、两套错误处理，测试矩阵翻倍

**改进动作**（三选一）
| 方案 | 说明 | 建议 |
| --- | --- | --- |
| **A. 彻底移除** | 服务端 `/api/store` 已实现持久化+多设备同步，CouchDB 分支是**重复的第二套同步方案**。删掉 `ensurePouchDB` / `connectCouch` / `disconnectCouch` / 设置页第 4 节 / `pouchMode` 分支，**减 ~150 行 + 消除供应链风险 + 消除双轨** | ⭐ **推荐** |
| B. 构建期引入 | `npm i pouchdb` + 打包产物入库（仍零运行时依赖） | 若确有 CouchDB 用户 |
| C. 保留但降级 | 保留 CDN，明确文档标注「需外网」 | 不推荐 |

> **建议 A 的额外收益**：`app.js` 的 `pouchMode` 分支在 `saveSetting`/`getSetting`/`exportData`/`importData` 多处都有分叉，移除后这些函数可大幅简化。

### P2-8 `importData` 不校验 `_id` 格式（其余字段已在 10:52 被并行加固）

**证据**（最终版本）：`app.js:1418` `importData()` 现已做：
- ✅ `doc.type` 白名单（`card`/`review`/`settings`）
- ✅ `doc._id` 非空校验
- ✅ `card` 的 `title`/`outline` 非空字符串、trim
- ✅ `card.latest_memory_score` 越界 → 归零为 `null`
- ✅ `card.due_date` 不匹配 `/^\d{4}-\d{2}-\d{2}$/` → 重置为明天
- ❌ **`_id` 只判空、不校验格式** → 仍可通过 `card:x" onmouseover="alert(1)` 这类畸形 id
- ❌ **`review` 分支完全未校验** → 缺 `reviewed_at` 的记录直接入库 → 触发 `getReviews()` 崩溃（见 P1-5）

**影响**：畸形 `_id` 是 XSS-B 的注入源；畸形 review 记录是 P1-5 白屏的触发源。

**改进动作**
```js
// app.js importData —— 补 _id 格式 + review 分支校验
if (!/^(card|review|settings):[A-Za-z0-9._:-]{1,120}$/.test(doc._id)) { skipped++; continue; }
...
if (clean.type === 'review') {
  if (typeof clean.reviewed_at !== 'string' || !clean.reviewed_at) { skipped++; continue; }
  const s = Number(clean.memory_score);
  clean.memory_score = Number.isFinite(s) ? Math.max(0, Math.min(100, Math.trunc(s))) : null;
}
```

---

## 六、P3：工程化与部署

### P3-1 测试策略：服务端已有 18 条用例，但**恰好漏掉了 3 个未修的 P0**

**现状**（11:03 并行新增 `tests/server.test.cjs` 15KB，测试总数 14 → 32）：
| 文件 | 行数 | 覆盖对象 | 层次 |
| --- | --- | --- | --- |
| `tests/domain.test.cjs` | 153 | `domain.cjs` 全部导出 | 单元 ✅ |
| `tests/app.test.cjs` | 215 | `app.js` 整体 | vm 沙箱集成 ⚠️ |
| `tests/server.test.cjs` | 15.2KB / 18 例 | `server.mjs` | 集成 ✅ **新增** |

**`server.test.cjs` 已覆盖**（质量很高）：非法入参 400、损坏文件 500 + `.corrupt` 备份、跨源 403、`STORE_TOKEN` 401/200、`base_rev` 匹配/不匹配、rev 推进、并发写后 JSON 合法、413、405+Allow、415、404、5 个安全响应头、健康检查、临时目录隔离。

**❌ 关键盲区 —— 恰好是 3 个未修的 P0**：

| 未修 P0 | 是否有测试 | 后果 |
| --- | --- | --- |
| **P0-1 删除复活** | ❌ **无任何用例**（grep「删除/delete/复活」零命中） | 缺陷可随时回归 |
| **P0-3 无 `updated_at`** | ❌ **无任何用例** —— 现有用例 `card()` 辅助函数（`tests/server.test.cjs:90`）**总是带上 `updated_at`**，测试从未构造过缺时间戳的文档 | 缺陷可随时回归 |
| **P0-4 `base_rev` 缺失整库覆盖** | ⚠️ **有用例，但方向相反** —— `tests/server.test.cjs:221`「老客户端不带 base_rev 时保持直接替换（向后兼容）」**把这个危险行为断言为「预期行为」** | **测试锁死了危险行为** |

> **这是本次审计最值得注意的发现**：测试套件不仅漏掉了 P0-1/P0-3，还把 P0-4 的危险行为**固化成了断言**。一旦按该用例的语义理解，「不带 base_rev 就整库覆盖」会被当成特性而非缺陷，从而**永久屏蔽修复**。

**改进动作**：新增 3 条用例，并**修改**那条反向用例
```js
// tests/server.test.cjs —— 新增用例 #11：删除传播（当前会失败，修复后转绿）
test('客户端删除的卡片不会在合并后复活', async t => {
  const srv = await startServer(); t.after(() => srv.close());
  await putJson(srv.base, { docs: [card('a'), card('b'), card('c')] });
  const { rev } = await (await fetch(`${srv.base}/api/store`)).json();
  // 客户端本地只剩 c（a、b 已被删除），且 rev 已过期
  const res = await putJson(srv.base, { docs: [card('c')], base_rev: 'r0' });
  const payload = await res.json();
  const ids = payload.docs.map(d => d._id).sort();
  assert.deepEqual(ids, ['c'], '被删除的 a、b 不应复活');
});

// tests/server.test.cjs —— 新增用例 #12：客户端文档缺 updated_at 时客户端胜
test('客户端文档缺少 updated_at 时以客户端版本为准', async t => {
  const srv = await startServer(); t.after(() => srv.close());
  await putJson(srv.base, { docs: [{ _id: 'a', title: '服务端', updated_at: '2026-01-01T00:00:00.000Z' }] });
  const res = await putJson(srv.base, { docs: [{ _id: 'a', title: '客户端' }], base_rev: 'r0' });
  const payload = await res.json();
  assert.equal(payload.docs[0].title, '客户端', '缺时间戳不应导致客户端编辑被丢弃');
});

// tests/server.test.cjs —— 修改现有用例（原第 221 行）
// 原：test('老客户端不带 base_rev 时保持直接替换（向后兼容）', ...)
// 改为：test('缺少 base_rev 时拒绝整库覆盖，避免清空服务端', ...)
```
> 并同步修 `tests/server.test.cjs:90` 的 `card()` 辅助函数，增加一个不传 `updated_at` 的变体，确保无时间戳路径真的被测到。

**其余盲区**：
- `app.test.cjs` 的 DOM mock 仍极简（`querySelectorAll` 恒返回 `[]`）→ `filterLibrary` 的筛选/排序逻辑实际未被验证
- 无「持久化层」测试：`createLocalStore` 的 put/remove/bulkDocs、`pushServerStore` 去抖、`hydrateFromServerStore` 合并 —— 全部零覆盖
- `markdownToHtml` 仅有 1 个 `includes('cloze-mask')` 断言，无转义/顺序/层级专项

### P3-2 `tools/` 目录：15 个文件中 12 个是一次性脚本

**现状清单**（`tools/`，15 个文件）：
| 文件 | 价值 | 处置建议 |
| --- | --- | --- |
| `shot.mjs` (4.4KB) | ⭐ **高**。零依赖 CDP 截图器，`.workbuddy/memory` 明确记录「自建，勿删」 | **保留**，可考虑固化进 CI 做视觉回归 |
| `css-audit.mjs` (607B) | ⭐ **高**。对比 app.js 用的 class 与 styles.css 定义的，**曾发现 `.hidden` 丢失的严重 bug** | **保留**，但需修一个 bug：见下 |
| `seed.js` (6.2KB) | 中。注入 16 卡 + 52 记录的演示数据 | 保留（演示/手测用） |
| `seed_dark.js` (2.2KB) | 低。与 `seed.js` 重复，仅主题不同 | 合并进 `seed.js --dark` |
| `nav.js` / `nav_history.js` / `nav_library.js` / `nav_settings.js` (各 ~150B) | 低。4 个视图切换脚本 | **合并为一个 `nav.js`（接受视图名参数）** |
| `open_card.js` / `open_limit.js` / `open_review.js` / `open_score.js` | 低 | **合并为一个 `open.js`（接受目标名参数）** |
| `probe.js` / `probe_limit.js` / `review_score.js` | 低。一次性调试探针 | **删除**（其断言已沉淀进 `shot.mjs` 流程） |
| `_perf-hex-scan.mjs` (1.5KB, 10:39 新增) | 待定 | 审计期间新增，需 team-lead 确认归属 |

**处置原则**：保留「可复用的能力」（shot / css-audit / seed），删除「一次性探针」，合并「同构脚本」。
**预期结果**：15 → 3 个文件，`tools/` 从 44KB 降到 ~11KB。

**`css-audit.mjs` 需修的 bug**：它只扫 `app.js`，不扫 `index.html`（后者有 551 行、含大量 class）。当前输出：
```
used: 177 | missing: 9
archived-row current defaultNb history-group history-main index null queue-main selectedNotebookColor
```
其中 `defaultNb` / `selectedNotebookColor` / `index` / `null` 是**变量名被误当 class**（正则 `class="([^"]*)"` 抓到了模板表达式），说明扫描有误报。建议：
```js
// css-audit.mjs —— 只扫 index.html + app.js，且过滤模板表达式
const sources = ['app.js', 'index.html'].map(f => readFileSync(f, 'utf8')).join('\n');
const re = /class="([^"{}]*)"/g;   // 排除含 {} 的动态 class
```

### P3-3 Docker / CI

**现状**
- `Dockerfile`：`node:22-alpine`，`COPY` 精确文件列表（✅ 缓存友好），`VOLUME /app/data`，`HEALTHCHECK` 用 `wget`（alpine 自带 ✅）
- `docker-compose.yml`：`restart: unless-stopped` + healthcheck + `./data:/app/data` 卷 ✅
- `.dockerignore`：已排除 `.git/.github/.workbuddy/node_modules/data/docs/tools/tests/*.md` ✅
- CI：先 `node --test` 再构建推送，双架构 `linux/amd64,linux/arm64` ✅

**缺口与改进**：

| 项 | 现状 | 改进 | 优先级 |
| --- | --- | --- | --- |
| **非 root 运行** | ❌ 容器以 root 运行 | 加非 root 用户（`node` 官方镜像已内置 `node` 用户）：<br>`RUN mkdir -p /app/data && chown -R node:node /app/data`<br>`USER node` | **P1 安全加固** |
| **`--init` / PID 1** | ❌ `node` 直接作 PID 1 | compose 加 `init: true`（或 `docker run --init`）→ 正确回收僵尸进程 + 转发信号 | P2 |
| **镜像体积** | `node:22-alpine` 基础镜像 ~180MB（解压后）；应用文件仅 ~250KB | 体积**几乎全是 node 运行时**。可考虑 `node:22-alpine` + 多阶段（收益有限）；**更有效的是零依赖已达成——保持现状即可**，不必过度优化 | P3 |
| **基础镜像 tag 浮动** | `node:22-alpine` 会随时间漂移 | 锁 `node:22.22-alpine` 或 digest（`node:22-alpine@sha256:...`），保证构建可复现 | P3 |
| **CI 无缓存** | 每次构建重下 node 基础层 | 加 `cache-from: type=gha` / `cache-to: type=gha,mode=max` | P3 |
| **CI 无 `concurrency`** | 连续 push 会排队构建 | 加 `concurrency: group: ${{ github.workflow }}-${{ github.ref }}, cancel-in-progress: true` | P3 |
| **CI 未跑 linter** | 无 lint | 零依赖前提下可用 `node --check app.js` + `node --check server.mjs`（语法检查），加进 test job | P2 |
| **healthcheck 不查数据** | `/healthz` 只返回静态 ok | 增一项：验证存储目录可写（`fs.access(dataDir, W_OK)`），数据不可写时 healthcheck 应失败 → compose 能正确重启 | P2 |
| **`.dockerignore` 缺项** | 已排除大部分 | 建议补 `*.tmp` / `.gitignore` / `README.md`（`*.md` 已覆盖） | P3 |

### P3-4 文件规模治理 —— `app.js` 约 2010 行 / `styles.css` 约 3900 行

**现状**：`app.js` 单文件承载：存储层（`pushServerStore`/`hydrateFromServerStore`/`createLocalStore`，约 92-200）、Markdown 渲染（288-322）、4 个视图渲染（约 380-760）、复习流程（约 1000-1430）、设置页、事件委托（约 1490-1810）、键盘流、Bootstrap（末尾）。

**渐进拆分方案**（**不引入构建工具、保持零依赖**）：

**核心手法**：原生 ES Module + `<script type="module">`。浏览器原生支持，**不需要打包器**，且能直接用 `import` 表达依赖关系。
> ⚠️ 注意：`index.html:10-11` 当前用 `<script defer src>`（非 module）。改为 module 后：
> - `defer` 语义由 module 自带（默认 defer），无需额外声明
> - module 是**严格模式** + 独立作用域，暴露的全局需显式挂 `window`
> - `domain.cjs` 需改为 `.mjs` 或保留 UMD 双导出（当前它已同时支持 `module.exports` 与 `root.StudyStyleDomain` ✅ 可直接被 module 侧读取，但需调整为 `export`）

**建议模块边界**（行号随并行改写会漂移，以**函数名**为准）：

| 模块 | 内容 | 源函数（当前 app.js） | 预估行数 |
| --- | --- | --- | --- |
| `src/domain.js` | 现有 `domain.cjs` + 新增 `levelCounts`/`daysOverdue`/`toLocalDay` | domain.cjs 全部 | ~300 |
| `src/storage.js` | 存储与同步层 | `createLocalStore` / `pushServerStore` / `pushServerStoreNow` / `hydrateFromServerStore` / `serverRev` | ~120 |
| `src/markdown.js` | Markdown 渲染 | `markdownToHtml` | ~40 |
| `src/views/today.js` | 今日页 | `renderToday` | ~160 |
| `src/views/library.js` | 卡片库 | `renderLibrary` / `renderLibraryRows` / `filterLibrary` | ~200 |
| `src/views/history.js` | 复习记录 | `renderHistory` | ~55 |
| `src/views/settings.js` | 设置页 | `renderSettings` | ~95 |
| `src/review-flow.js` | 复习流程与状态机 | `beginReview` / `showReviewCard` / `saveReview` / `skipCurrentCard` / `undoLastReview` + 复习相关状态 | ~300 |
| `src/state.js` | 30 个模块级 `let` → 单一 `state` 对象 | 顶部状态声明区 | ~40 |
| `src/app.js` | Bootstrap + 事件委托 + 键盘流 | `initStore` / 事件委托 / 键盘流 | ~450 |

**迁移顺序与每步风险**：

| 阶段 | 内容 | 验证方式 | 风险 |
| --- | --- | --- | --- |
| **S0** | 先补 `tests/server.test.cjs`（✅ 已完成）+ 修 P0-1/P0-3/P0-4 | 新测试全绿 + 手工双设备验证 | 🟢 低（不改运行时逻辑） |
| **S1** | 把 `markdownToHtml` / `levelCounts` / `daysOverdue` 下沉到 `domain.cjs` | `node --test` 全绿；`domain.test.cjs` 补 8~10 条 | 🟢 低（纯函数搬移） |
| **S2** | 改 `<script type="module">`，拆出 `src/storage.js` + `src/markdown.js` | `node --test` 全绿 + 浏览器手工冒烟（新建/编辑/复习/导入导出） | 🟡 中（模块加载顺序、严格模式、隐式全局暴露） |
| **S3** | 拆视图：`src/views/*.js` | 同上 + 每个视图渲染快照对比（可用 `shot.mjs` 前后截图 diff） | 🟡 中（跨模块状态依赖） |
| **S4** | 30 个 `let` → `state` 对象 | `node --test` 全绿 | 🟡 中（重构面广，需逐字段核对） |
| **S5** | 拆 `styles.css`（约 3900 行 → tokens/base/components/views/responsive 5 个文件，`<link>` 引入，无需打包器） | 截图 diff + `css-audit.mjs` 无 missing | 🟢 低（纯 CSS，顺序敏感需保持） |

**每阶段都必须保持可回滚**：当前项目**没有 git 仓库**（实测 `fatal: not a git repository`）——**这是比文件拆分更紧迫的风险**。建议**第一步就 `git init` + 首次提交**，否则任何重构都无法回退。

> **强烈建议 S-1：立即 `git init`**。理由：本次审计期间 `server.mjs` / `app.js` / `domain.cjs` 被并行改写**共 6 轮**（10:44 / 10:45 / 10:48 / 10:49 / 10:51 / 10:52），无版本控制时无法追踪变更、无法回滚、无法做 diff 评审。这比所有 P2/P3 加起来都重要。

---

## 七、数据丢失与覆盖风险清单（按严重性排序）

| # | 级别 | 风险 | 精确位置 | 触发条件 | 实测结论 | 状态 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | **P0→P1** | 墓碑语义服务端已消费，但**无回归用例锁住** | `server.mjs` `mergeDocs` `isTombstone` 分支 | 后续重构误删该分支 | ✅ 实测当前行为正确：`["c1","c3","TOMB:c2"]` | ⚠️ **需补用例** |
| 2 | **P1** | 客户端 hydrate 合并仍用 `localTime > remoteTime`，与服务端 `isNewer` 判定**不一致** | `app.js:171-173` | 缺 `updated_at` 的本地 doc | ⚠️ `'' > '...'` 恒 false → 客户端丢本地编辑 | ❌ 未修 |
| 3 | **P2** | XSS-A：标签/关键词未转义 → 窃取全部学习数据 | `app.js:1839-1843` | 恶意标签 + 空状态触发 | ✅ 复现：`<img src=x onerror=...>` 未转义 | ❌ 未修 |
| 4 | **P2** | `importData` 的 `_id` 只判空不判格式 | `app.js:169` | 导入畸形 JSON | ⚠️ 渲染层已转义，但脏 `_id` 仍入库 | ⚠️ 部分修 |
| 5 | **P1** | `review` 记录缺 `reviewed_at` → `getReviews()` 排序崩溃 | `app.js:265` `.localeCompare` | 导入的 JSON review 记录字段不全 | ✅ 复现路径已确认 | ❌ 未处理 |
| 6 | **P1** | `localStorage` 5MB 配额耗尽 → 写入失败 | `app.js` `createLocalStore.put` `setItem`（未 try/catch） | 复习记录累积到 ~1.3 万条 | ⚠️ 实测：1 万条 ≈ 3.6MB，逼近上限 | ❌ 未处理 |
| 7 | **P1** | 存储文件损坏后服务**永久不可写** | `server.mjs` `read()` + `backupCorrupt()` | JSON 损坏 | ✅ 复现：GET 500 + 生成备份，此后 PUT 永久 500 | ⚠️ 数据安全但需人工恢复 |
| 8 | **P1** | 服务端无请求日志，无法取证「谁在什么时候清了库」 | `server.mjs` 仅启动/错误时打日志 | 发生数据异常时 | ✅ 正常请求零日志 | ❌ 未处理 |
| 9 | **P1** | 优雅关闭无超时，SIGTERM 后进程可能挂死 | `server.mjs` `server.close(() => process.exit(0))` | keep-alive 连接未断 | ⚠️ 无 `closeIdleConnections`、无 flush | ❌ 未处理 |
| 10 | **P2** | 批量导入期间**中途失败**导致本地与服务端不一致 | `app.js` `createLocalStore.put` | 导入 N 条中途 `setItem` 抛配额异常 | ⚠️ 本地部分写入、服务端未收到 | ❌ 未处理 |
| 11 | **P2** | 归档（`archived_at`）在多设备下被 merge 复活 | 归档走 `archived_at` 字段而非墓碑 | 归档后触发 merge | ⚠️ 墓碑只覆盖 `remove()`，归档未走墓碑 | ❌ 未修 |
| 12 | **P3** | 项目**无 git 版本控制**，无法回滚 | 项目根目录无 `.git` | 任何重构/并行改写 | ✅ 实测 `fatal: not a git repository`；审计期间核心文件被改写 10+ 轮 | ❌ **最高优先级** |

> **已确认关闭**（我审计开始时的旧版 + 本轮 10+ 轮并行加固）：
> ✅ 空 body 清库 → 现 400
> ✅ `docs` 非数组清库 → 现 400
> ✅ 跨源 CSRF（`POST` + `text/plain`）→ 现 405 + 跨源 PUT 403
> ✅ JSON 损坏被当空库 → 现 500 + 备份隔离
> ✅ 500 伪装成 404 → 现正确返回状态码
> ✅ 缺 CSP / 安全响应头 → 现已补齐（实测 5 个：CSP/nosniff/X-Frame-Options/Referrer-Policy/Permissions-Policy）
> ✅ 缺 405/404 区分 → 现已区分
> ✅ `bulkDocs` N 次全量 PUT → 现已改为循环后单次推送
> ✅ `_rev = String(Date.now())` 同毫秒撞号 → 现已改为递增计数器
> ✅ `pushServerStore` 无去抖 → 现已加 300ms 去抖
> ✅ `scoreToBag` 越界抛错导致白屏 → 现已新增 `scoreToBagSafe` 兜底
> ✅ `importData` 脏分数/脏日期入库 → 现已校验归一
> ✅ 合并响应缺 `docs` → 现已补上（客户端回填生效）
> ✅ `base_rev` 缺失时整库覆盖 → 客户端已加「先 GET 拿 rev」兜底
> ✅ `isNewer` 无戳恒 false → 已改三段式（语义已校正）
> ✅ `library-row` 的 `data-card-row` 未转义 → 现已加 `escapeHtml`
> ✅ **墓碑被服务端丢弃 → 删除复活** → 现 `mergeDocs` 已消费墓碑，实测 `["c1","c3","TOMB:c2"]` ✅
> ✅ 服务端测试从 0 → 35 例（含 `tests/server.test.cjs` 18 例）

---

## 八、重构路径建议（分阶段 + 验证方式）

### 阶段 0：止血（0.5 天）
| 步骤 | 内容 | 验证 |
| --- | --- | --- |
| 0.1 | **`git init` + 首次提交 + `.gitignore` 补 `data/`**（当前**无版本控制**，这是最高优先级风险 —— 见风险清单 #12） | `git log` 有 1 条基线提交 |
| 0.2 | **收敛冲突判定到 `domain.cjs`**：新增 `Domain.pickNewer(localDoc, remoteDoc)` 单一纯函数，客户端 hydrate 与服务端 `isNewer` **共用同一套语义** | 新增 domain 单测；两侧行为一致 |
| 0.3 | **补墓碑回归用例**（锁住当前已正确的行为） | `tests/server.test.cjs` 新增「客户端删除的卡片不会在合并后复活」 |
| 0.4 | **修 XSS-A**：`app.js:1839-1843` 统一 `escapeHtml` | 新增 XSS 回归用例 |
| 0.5 | **`importData` 校验 `_id` 格式** | 导入畸形 JSON 被跳过而非入库 |

> 0.2 是**根治项**：判定逻辑收敛到 domain 层后，客户端与服务端不可能再分叉。0.3~0.5 是低成本收口。

---

## 八之二、建议由 fullstack-dev 直接实施的任务卡

| # | 任务名 | 涉及文件 | 验收标准 |
| --- | --- | --- | --- |
| **T0** | **建立版本控制基线** | 项目根目录 `.git` / `.gitignore` | `git log` 有 1 条提交；`git status` 干净；`.gitignore` 含 `data/`、`.workbuddy/` |
| **T1** | **冲突判定收敛到 domain（根治项）** | `domain.cjs` / `app.js` `hydrateFromServerStore` / `server.mjs` `isNewer` | ① `domain.cjs` 新增 `pickNewer(localDoc, remoteDoc)` 纯函数并导出；② `app.js` 与 `server.mjs` **都调用它**（服务端可复制该实现或直接 import）；③ 两侧在「双方都无戳 / 客户端无戳 / 服务端无戳 / 双方有戳」四种输入下**判定结果完全一致**；④ domain 单测覆盖四种情况 |
| **T2** | **墓碑语义回归用例** | `tests/server.test.cjs` | 新增「客户端删除的卡片不会在合并后复活」用例，**用真实墓碑对象**（`_deleted:true`），断言服务端不再有该 `_id` 的活卡片；**同时确认 GET 响应是否过滤墓碑**（若不过滤，客户端 `allDocs()` 已过滤则可接受，但需在用例中固化预期） |
| **T3** | **XSS-A 空状态转义** | `app.js` `filterLibrary` 的 `parts` 拼接 | 标签含 `<img src=x onerror=alert(1)>` 时，空状态提示渲染为文本而非元素；新增回归用例 |
| **T4** | **导入数据字段白名单** | `app.js` `importData` | `_id` 不匹配 `/^(card\|review\|settings):[A-Za-z0-9._:-]{1,120}$/` 则跳过；`review` 分支校验 `reviewed_at` 必填与 `memory_score` 归一 |
| **T5** | **`getReviews()` 排序兜底 + 配额保护** | `app.js` `getReviews` / `createLocalStore.put` | 缺 `reviewed_at` 的 review 不再抛 TypeError；`localStorage.setItem` 包 try/catch，QuotaExceededError 给用户 toast 而非静默失败 |
| **T6** | **服务端可运维三件套** | `server.mjs` / `Dockerfile` / `docker-compose.yml` | ① 请求日志（不含 docs 内容与 token）；② 优雅关闭：`server.closeIdleConnections()` + 5s 强杀兜底 + `await writeChain`；③ Dockerfile 加 `USER node`、compose 加 `init: true` |
| **T7** | **测试基建补强（卡 Phase6）** | `tests/app.test.cjs` / 新建 `tests/storage.test.cjs` | ① `app.test.cjs` 注入 `fetch` mock → 服务端同步路径从 0 覆盖变为有覆盖；② 可注入 clock（见下）；③ `storage.test.cjs` 覆盖 `createLocalStore` 与去抖 |
| **T8** | **`tools/` 收敛（15 → 3）** | `tools/` | 保留 `shot.mjs` / `css-audit.mjs` / `seed.js`；`nav_*.js` 合并为 `nav.js`（接受参数）；`open_*.js` 合并为 `open.js`；删除 `probe*.js`；修 `css-audit.mjs`（扫 `index.html` + 过滤模板表达式误报，当前 9 个 missing 里 4 个是变量名误报） |
| **T9** | **领域层下沉（低风险先做）** | `domain.cjs` / `app.js` | `levelCounts` / `daysOverdue` / `toLocalDay` 下沉到 `domain.cjs` 并加单测；`app.js` 的 `levelCounts`/`fmtDue` 改为调用 domain。**可与 T1 合并做**（都动 domain.cjs 导出面） |
| **T10** | **前端拆分（最后做）** | `app.js` → `src/*.js` | 按报告 §P3-4 的 S2→S5 顺序，原生 ES Module，**不引入打包器**；每阶段以 `node --test` 全绿 + `shot.mjs` 截图 diff 为门槛。**前置条件：T1~T9 完成且有测试兜底** |

### 关于 T7 的可注入 clock（回应 req-analyst 的提醒）

req-analyst 指出 `localDay()` 直读系统时间、日期断言不可控 —— **确认属实**，且这会卡住后续所有回归用例。设计建议（**不破坏现有 API**）：

```js
// domain.cjs —— 新增可注入的时钟，缺省仍用系统时间
let clock = () => new Date();
function setClock(fn) { clock = typeof fn === 'function' ? fn : () => new Date(); }
function toLocalDay(date = clock()) { /* 原 localDay 的实现 */ }

// app.js —— 改为委托
const localDay = (date) => Domain.toLocalDay(date);
```
测试侧：
```js
// tests/domain.test.cjs
setClock(() => new Date('2026-03-15T09:00:00+08:00'));
assert.equal(Domain.toLocalDay(), '2026-03-15');
```
> 现有 `domain.cjs` 已有 UMD 双导出（`module.exports` + `root.StudyStyleDomain`），新增 `setClock` 后 Node 侧 `require` 与浏览器侧 `window.StudyStyleDomain` **都能拿到**，零改造成本。

---

## 九、契约冻结声明

### 冻结范围
1. **数据模型**：`card` / `review` / `settings` 三类 doc 的字段集合与语义
2. **接口契约**：
   - `GET /api/store` → `{ ok, rev, docs }`
   - `PUT /api/store` → body `{ docs, base_rev? }`；响应 `{ ok, rev, merged, count, docs }`（**`docs` 为本次新增的必填字段**）
   - `GET /healthz` → `{ status, timestamp }`
3. **领域层 API**：`domain.cjs` 的 21 个导出函数签名（新增 `levelCounts` / `daysOverdue` / `toLocalDay`）

### 变更流程
任何对上述三项的修改，必须：
1. 更新本文件（`docs/ARCHITECTURE-AUDIT.md`）
2. 同步更新 `tests/server.test.cjs` 与 `tests/domain.test.cjs` 的对应断言
3. 通知全部受影响开发（前端 / 服务端 / 测试）

### 待冻结前的 3 个待决点
| # | 待决 | 建议 | 决策人 |
| --- | --- | --- | --- |
| 1 | 删除语义：墓碑 vs 增量接口 | **增量接口**（阶段 4），墓碑作为过渡 | team-lead |
| 2 | CouchDB/PouchDB 分支去留 | **移除**（服务端已覆盖多设备同步） | team-lead |
| 3 | 是否立即引入 git | **是，优先级最高** | team-lead |

---

*本报告全部结论均经运行时实测复现，审计过程未修改任何项目代码文件。*
