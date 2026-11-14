FROM node:22-alpine

WORKDIR /app

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3880
ENV DATA_DIR=/app/data

# 仅复制运行时所需静态与服务端文件（零第三方依赖，镜像极轻量）
COPY package.json server.mjs domain.cjs app.js index.html styles.css manifest.webmanifest sw.js favicon.svg icon.svg apple-touch-icon.png icon-192.png icon-512.png icon-maskable-512.png ./
COPY src ./src
COPY styles ./styles
COPY vendor ./vendor

# 创建持久化数据目录
RUN mkdir -p /app/data

VOLUME ["/app/data"]

EXPOSE 3880

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3880/healthz || exit 1

CMD ["node", "server.mjs"]
