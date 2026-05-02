FROM node:22-bookworm-slim AS base

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"

WORKDIR /app

RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json tsconfig.base.json ./
COPY apps/api/package.json apps/api/package.json
COPY packages/markdown/package.json packages/markdown/package.json
COPY packages/shared/package.json packages/shared/package.json

RUN pnpm install --frozen-lockfile

COPY apps/api apps/api
COPY packages/markdown packages/markdown
COPY packages/shared packages/shared

RUN pnpm --filter @marklab/markdown typecheck \
  && pnpm --filter @marklab/shared typecheck \
  && pnpm --filter @marklab/api typecheck

ENV NODE_ENV=production
ENV PORT=3001
EXPOSE 3001

CMD ["pnpm", "--filter", "@marklab/api", "start"]
