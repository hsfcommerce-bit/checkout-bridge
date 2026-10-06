# checkout-bridge: imagem de produção.
# O Node 24 executa os arquivos .ts diretamente (remoção de tipos); não há etapa de build.
FROM node:24-slim

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8787 \
    DATABASE_PATH=/app/data/bridge.db

WORKDIR /app

# Dependências primeiro, para aproveitar o cache de camadas quando só o código muda.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src

# O banco SQLite fica no volume; o diretório precisa pertencer ao usuário que roda o processo.
RUN mkdir -p /app/data && chown -R node:node /app
VOLUME ["/app/data"]

# Usuário sem privilégios já existente na imagem oficial.
USER node

EXPOSE 8787

# A imagem slim não traz curl; a verificação usa o próprio Node. /healthz não toca no banco.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 8787) + '/healthz').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "src/server.ts"]
