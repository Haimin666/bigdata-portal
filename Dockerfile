# 基础镜像可由构建参数覆盖:内网无法访问 docker.io 时,
# 用 BASE_IMAGE 指向内部 registry,如 harbor.example.com/library/node:20-alpine。
ARG BASE_IMAGE=node:20-alpine

# ---- build stage ----
FROM ${BASE_IMAGE} AS build
WORKDIR /app
COPY package.json package-lock.json ./
# 依赖源默认用 lock 内 resolved URL(registry.npmmirror.com);
# 内网有私有 npm 源时可传 NPM_REGISTRY 覆盖(如 http://npm.example.com/repository/npm-public/)。
ARG NPM_REGISTRY
RUN if [ -n "$NPM_REGISTRY" ]; then npm config set registry "$NPM_REGISTRY"; fi \
  && npm ci --no-audit --no-fund
COPY . .
RUN npm run build

# ---- runtime stage ----
FROM ${BASE_IMAGE}
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY server ./server
EXPOSE 9910
# --no-deprecation: 与 scripts/dev.mjs 一致,抑制 http-proxy@1.18 的 DEP0060 噪音警告
CMD ["node", "--no-deprecation", "server/index.js"]
