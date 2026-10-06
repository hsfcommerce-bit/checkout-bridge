#!/bin/zsh
# Sobe o painel usando o Node 24 portátil que está em .tools/node (nada é instalado no sistema).
cd "$(dirname "$0")"
export PATH="$PWD/.tools/node/bin:$PATH"
set -a; [ -f .env ] && source .env; set +a
mkdir -p data
PORTA="${PORT:-8787}"
if lsof -nP -iTCP:"$PORTA" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "Já existe algo escutando na porta $PORTA (provavelmente o checkout-bridge aberto em outro terminal)."
  echo "Use o painel em http://127.0.0.1:$PORTA/admin ou pare a outra instância com Ctrl+C antes de rodar de novo."
  exit 1
fi
echo "Painel em http://127.0.0.1:$PORTA/admin  (senha em .env, variável ADMIN_PASSWORD)"
exec node src/server.ts
