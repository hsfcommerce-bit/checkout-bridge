#!/bin/zsh
# Roda a checagem de tipos e todos os testes automatizados.
cd "$(dirname "$0")"
export PATH="$PWD/.tools/node/bin:$PATH"
npm run typecheck && node --test "test/**/*.test.ts"
