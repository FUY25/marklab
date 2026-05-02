FROM node:22-bookworm-slim AS build

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"

WORKDIR /app

RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json tsconfig.base.json ./
COPY apps/web/package.json apps/web/package.json
COPY packages/markdown/package.json packages/markdown/package.json
COPY packages/shared/package.json packages/shared/package.json

RUN pnpm install --frozen-lockfile

COPY apps/web apps/web
COPY packages/markdown packages/markdown
COPY packages/shared packages/shared

ARG VITE_MARKLAB_API_URL=http://127.0.0.1:3001
ARG VITE_MARKLAB_WS_URL=ws://127.0.0.1:3001/collab
ENV VITE_MARKLAB_API_URL=$VITE_MARKLAB_API_URL
ENV VITE_MARKLAB_WS_URL=$VITE_MARKLAB_WS_URL

RUN pnpm --filter @marklab/web build

FROM nginx:1.27-alpine

COPY --from=build /app/apps/web/dist /usr/share/nginx/html

EXPOSE 80

HEALTHCHECK --interval=10s --timeout=3s --retries=12 \
  CMD wget -qO- http://127.0.0.1/ >/dev/null || exit 1
