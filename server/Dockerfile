# Forge server — Bun + bun:sqlite. Sin dependencias npm: sqlite es nativo de Bun.
FROM oven/bun:1-slim
WORKDIR /app

# Solo el código del server.
COPY package.json ./
COPY src ./src

# La DB (índice + seq) y el vault canónico viven en /data, que se monta como volumen
# para sobrevivir redeploys. El token admin de arranque se pasa por env (FORGE_TOKEN),
# o se crean tokens con el CLI: `bun run src/tokens.ts add <nombre> <rol>`.
ENV FORGE_DB=/data/forge.db \
    FORGE_VAULT=/data/vault \
    PORT=4321
RUN mkdir -p /data/vault

EXPOSE 4321
CMD ["bun", "run", "src/index.ts"]
