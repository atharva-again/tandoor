FROM golang:1.27-bookworm AS gog-build
ARG GOG_COMMIT=6f910fffac0a359c30430b71a1037f2ccf07453a
RUN GOTOOLCHAIN=auto go install github.com/openclaw/gogcli/cmd/gog@${GOG_COMMIT}

FROM node:24-bookworm-slim AS build
WORKDIR /app
ENV PNPM_VERSION=12.18.0
ENV PNPM_HOME=/root/.local/share/pnpm
ENV PATH=${PNPM_HOME}/bin:${PATH}
ENV SHELL=/bin/bash
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl ca-certificates libatomic1 \
    && rm -rf /var/lib/apt/lists/*
RUN curl -fsSL https://get.pnpm.io/install.sh | sh -
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/brand/package.json ./packages/brand/package.json
COPY packages/marketing-site/package.json ./packages/marketing-site/package.json
RUN pnpm install --frozen-lockfile --filter tandoor...
COPY tsconfig.json ./
COPY packages ./packages
RUN pnpm run protocol:generate && pnpm exec tsc -p tsconfig.json
RUN pnpm install --prod --frozen-lockfile --filter tandoor...

FROM node:24-bookworm-slim AS worker
ENV NODE_ENV=production
WORKDIR /app
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/packages/protocol ./packages/protocol
COPY --from=gog-build /go/bin/gog /usr/local/bin/gog
RUN mkdir -p /tandoor && chown node:node /tandoor
USER node
EXPOSE 50051
CMD ["node", "dist/packages/worker/src/main.js"]
