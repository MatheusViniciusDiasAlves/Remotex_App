# Imagem do servidor RemoteX (API + sinalização + app web do celular).
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
RUN npm ci
COPY . .
RUN node scripts/build.mjs --prod && npm prune --omit=dev

FROM node:22-alpine
ENV NODE_ENV=production PORT=8080 HOST=0.0.0.0 PUBLIC_DIR=/app/web DOWNLOADS_DIR=/app/downloads
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/dist/server ./dist/server
COPY --from=build /app/android-app/web/dist ./web
RUN mkdir -p /app/downloads && addgroup -S remotex && adduser -S remotex -G remotex && chown -R remotex:remotex /app
USER remotex
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:8080/api/health || exit 1
CMD ["node", "dist/server/server.js"]
