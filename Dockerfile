# syntax=docker/dockerfile:1
#
# agent_search_gateway —— 网关镜像
# 基镜像（MCR）自带 Node.js 与 Playwright 浏览器，版本与 package.json 的
# playwright 依赖严格对齐，避免"库与浏览器版本不一致"的坑。
# 版本变更时此处与 package.json 一起改。
ARG PLAYWRIGHT_IMAGE=mcr.microsoft.com/playwright:v1.62.1-noble

# ---------- 构建 ----------
FROM ${PLAYWRIGHT_IMAGE} AS build
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---------- 运行 ----------
FROM ${PLAYWRIGHT_IMAGE} AS runtime
ENV NODE_ENV=production \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    HOME=/app
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
# 无挂载时的兜底配置（正常由 compose 只读挂载 gateway.yaml）
COPY gateway.yaml.example ./gateway.yaml.example
RUN mkdir -p /data /quota

EXPOSE 3000
# 配置从工作目录的 gateway.yaml 读取（compose 挂载到 /app/gateway.yaml）
CMD ["node", "dist/index.js"]
