FROM node:22-alpine AS build
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.7.0 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/shared/package.json packages/shared/package.json
COPY apps/web/package.json apps/web/package.json
RUN pnpm install --frozen-lockfile
COPY packages/shared packages/shared
COPY apps/web apps/web
ENV VITE_API_BASE_URL=/api
ENV VITE_API_TOKEN=""
RUN pnpm build

FROM nginx:stable-alpine
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
COPY docker/default.conf.template /etc/nginx/templates/default.conf.template
ENV ZENBAR_API_UPSTREAM=http://host.docker.internal:18000
ENV ZENBAR_API_TOKEN=""
EXPOSE 80
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s CMD wget -q -O /dev/null http://127.0.0.1/healthz || exit 1
