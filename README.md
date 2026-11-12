# StudyStyle · 间隔复习与科目笔记本系统

遵循认知心理学主动回忆（Blurting / 费曼讲授 / 康奈尔线索）与间隔重复曲线的学习卡片 Web 应用。

- **双端持久化**：除浏览器本地存储外，服务端内置轻量级 JSON 持久化接口（`/api/store` → `./data/studystyle-db.json`）。部署在 Debian Docker 容器中挂载 `./data:/app/data` 后，手机、平板、电脑浏览器打开同一个地址即可自动共享全部科目笔记本、卡片与复习记录，无需额外搭数据库。
- **可选 CouchDB 双向同步**：支持按需连接个人 CouchDB 实例。

---

## 一、通过 GitHub 部署到 Debian Docker（推荐）

### 1. 在本地推送到 GitHub

在项目根目录（`StudyStyle`）执行：

```bash
git init
git add .
git commit -m "feat: StudyStyle interval review with subject notebooks and Docker support"
git branch -M main
git remote add origin https://github.com/laniandott/StudyStyle.git
git push -u origin main
```

> 仓库已内置 GitHub Actions（`.github/workflows/docker-publish.yml`）：每次推送到 `main` 分支都会自动跑完 14 项单元与集成测试，并自动构建 `linux/amd64` 与 `linux/arm64` 双架构镜像发布到 `ghcr.io/laniandott/studystyle:latest`。

---

### 2. 在 Debian 服务器上用 Docker 运行

#### 方式 A：直接 `git clone` + `docker compose` 构建启动（最省心）

在 Debian 上执行：

```bash
git clone https://github.com/laniandott/StudyStyle.git studystyle
cd studystyle

# 后台构建并启动（数据自动持久化在 ./data/studystyle-db.json）
docker compose up -d --build
```

启动后访问：`http://<Debian服务器IP>:3880`

后续在 GitHub 更新代码后，在 Debian 上一键更新：

```bash
cd studystyle
git pull
docker compose up -d --build
```

#### 方式 B：直接拉取 GitHub Actions 自动构建的 GHCR 镜像

如果不想在 Debian 上编译镜像，也可以直接拉取 `ghcr.io` 镜像运行：

```bash
mkdir -p ~/studystyle/data
docker run -d \
  --name studystyle \
  --restart unless-stopped \
  -p 3880:3880 \
  -e TZ=Asia/Shanghai \
  -v ~/studystyle/data:/app/data \
  ghcr.io/laniandott/studystyle:latest
```

---

## 二、环境变量说明

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `HOST` | `0.0.0.0` | 监听地址（容器内须保持 `0.0.0.0`） |
| `PORT` | `3880` | HTTP 监听端口 |
| `DATA_DIR` | `/app/data`（本地为 `./data`） | 服务端自动持久化 JSON 存储目录（`studystyle-db.json`） |
| `TZ` | `Asia/Shanghai` | 容器时区 |

健康检查接口：`GET /healthz` → `{"status":"ok", ...}`

---

## 三、本地直接运行与测试

需要 Node.js 18 或更新版本（零第三方 npm 依赖）：

```bash
# 启动服务
node server.mjs

# 运行单元与集成测试
node --test
```
