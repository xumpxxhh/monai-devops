FROM node:24-bookworm-slim AS build
WORKDIR /workspace
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter server db:generate
ENV DEVOPS_BASE_PATH=/devops/
ENV DEVOPS_API_BASE_URL=/api/v1/devops
RUN pnpm build

FROM node:24-bookworm-slim AS server
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /workspace/apps/server
COPY --from=build /workspace /workspace
ENV NODE_ENV=production
ENV APP_ENV=production
ENV GLOBAL_API_PREFIX=api/v1/devops
ENV PORT=3000
EXPOSE 3000
USER node
CMD ["node", "dist/src/main.js"]

FROM scratch AS web-dist
COPY --from=build /workspace/apps/web/dist /
