# checkout-bridge

Serviço Node auto-hospedado que liga lojas Shopify de um mesmo lojista: lojas **vitrine** (tema da Loja virtual, onde o comprador navega e monta o carrinho) e lojas **checkout** (onde o pedido é fechado). Quando o comprador clica em finalizar compra na vitrine, um pequeno script do tema envia as linhas do carrinho (só IDs de variante e quantidades, nunca preços) por um App Proxy da Shopify a este serviço. O serviço traduz cada variante da vitrine para a variante correspondente na loja checkout ligada àquela vitrine, cria lá um carrinho pela Storefront API (ou monta um permalink de carrinho), confere o carrinho devolvido e responde com a URL do checkout, para onde o script leva o comprador. O preço cobrado é sempre o do catálogo da loja checkout.

Este código não foi testado em uma loja Shopify real. Os pontos em que a Shopify não documenta um comportamento estão marcados na documentação e nos comentários do código como "precisa de teste em loja real".

## O que o serviço não faz, de propósito

- Não escolhe a loja checkout por volume de vendas, horário, cota, carga ou falha da loja de destino, e não alterna lojas automaticamente. O destino de cada vitrine é o checkout ativo da operação que o lojista monta no painel (Operações › Nova operação); os outros checkouts da operação ficam disponíveis para troca manual. Se a loja checkout ativa estiver fora do ar, o checkout falha e o lojista é alertado; o comprador nunca é desviado para outra loja.
- Não recebe preços do navegador nem os envia à Shopify. A Storefront API não aceita preço na criação do carrinho; o valor vem do catálogo da loja checkout.
- Não grava dados pessoais do comprador: nenhum e-mail, endereço ou IP em claro (só um HMAC do IP, para correlação).
- Não altera catálogo nem pedidos: todos os escopos pedidos à Shopify são de leitura (mais `write_app_proxy`, exigido pela documentação para o App Proxy).

## Requisitos

- Node.js 24.3 ou mais novo (o serviço usa `node:sqlite` e executa TypeScript diretamente, sem build).
- Uma URL pública com HTTPS para o serviço (webhooks e App Proxy exigem).
- Disco persistente para o arquivo SQLite.
- Uma única instância do processo: limites de taxa, idempotência e fila de eventos são em memória.
- Todas as lojas (vitrine e checkout) na mesma organização Shopify, com um app criado no Dev Dashboard dessa organização. O porquê está em [docs/INSTALACAO.md](docs/INSTALACAO.md).

## Início rápido

```sh
# 1. Chave que cifra os segredos das lojas no banco (guarde uma cópia fora do servidor)
openssl rand -base64 32

# 2. Configuração
cp .env.example .env
# edite .env e preencha PUBLIC_BASE_URL, ENCRYPTION_KEY (passo 1) e ADMIN_PASSWORD: elas vêm vazias
# e o serviço se recusa a subir sem elas. TRUSTED_PROXY_HOPS = quantos proxies há na frente (padrão 1).

# 3. Dependências e execução (npm start lê o .env do diretório atual, se existir)
npm install
npm start
# em desenvolvimento, com recarga automática:
npm run dev
```

Rodando como serviço (systemd, PM2 ou similar), o diretório de trabalho precisa ser o do projeto para o `.env` ser encontrado; a alternativa é entregar as variáveis pelo gerenciador (`EnvironmentFile=/caminho/.env` no systemd), já que o processo só lê o ambiente e o `.env` ao lado.

Abra `https://<sua-url>/admin` (ou `http://localhost:8787/admin` em desenvolvimento), entre com `ADMIN_PASSWORD` e siga o passo a passo de [docs/INSTALACAO.md](docs/INSTALACAO.md).

Com Docker:

```sh
docker build -t checkout-bridge .
docker run -d --name checkout-bridge --env-file .env -p 8787:8787 -v checkout-bridge-data:/app/data checkout-bridge
```

O `Dockerfile` roda como usuário sem privilégios, guarda o banco no volume `/app/data` e tem um `HEALTHCHECK` em `/healthz`.

## Teste rápido com duas lojas

Roteiro para quem vai testar com uma loja vitrine e uma loja checkout de verdade:

1. **URL pública com HTTPS.** A Shopify precisa alcançar o serviço (App Proxy e webhooks). Para testar na própria máquina, um túnel resolve: `cloudflared tunnel --url http://localhost:8787` dá uma URL `https://....trycloudflare.com`; coloque-a em `PUBLIC_BASE_URL` no `.env` e reinicie.
2. **As duas lojas na mesma organização Shopify** (admin da loja › Configurações › Geral › Transferir loja › organização). Sem isso o token do app não funciona (`shop_not_permitted`).
3. **Lojas › Adicionar Loja**: escolha o tipo e siga o passo a passo que aparece ao lado (criar o app no Dev Dashboard, escopos, App Proxy na vitrine, instalar, copiar Client ID e Client Secret). Ao salvar, o serviço conecta, sincroniza o catálogo e, na vitrine, tenta gravar o script no tema.
4. **Operações › Nova operação**: nome, escolha a vitrine, marque o checkout, Criar Operação. Os produtos são casados por SKU (cadastre o mesmo SKU nas duas lojas).
5. **Na vitrine**, desligue os botões de compra acelerada (Buy it now, Shop Pay) no tema, adicione um produto ao carrinho e clique em finalizar compra: você deve cair no checkout da loja checkout com o mesmo item e o preço de lá.
6. Se algo falhar, a página **Sessões** mostra o motivo de cada tentativa e a **Central da operação** mostra divergências e o botão **Sincronizar produtos**.

## Verificação e testes

```sh
npm run typecheck   # tsc --noEmit
npm test            # node --test "test/**/*.test.ts"
npm run check       # os dois
```

Os testes são determinísticos e não acessam a rede: relógio, `fetch`, temporizadores e aleatoriedade são injetados.

## Mapa do código

| Caminho | O que contém |
| --- | --- |
| `src/types.ts` | Contrato central: tipos de domínio e interfaces ("portas") entre os módulos. Os comentários são parte da especificação. |
| `src/config.ts` | Leitura e validação das variáveis de ambiente (ver `.env.example`). |
| `src/lib/` | Utilitários sem dependência de Shopify: log com censura de segredos, métricas Prometheus, alertas, limitador de taxa, retry/timeout/circuit breaker, criptografia, dinheiro, relógio. |
| `src/db/` | SQLite (`node:sqlite`), migrações e repositórios de lojas, rotas, catálogo, mapeamentos, sessões, auditoria, eventos de webhook, sessões do painel e última execução das tarefas periódicas. |
| `src/shopify/` | Token da Admin API (client credentials), cliente Admin GraphQL (custo e throttling), cliente Storefront (`cartCreate`), verificação da assinatura do App Proxy e do HMAC de webhooks. |
| `src/catalog/` | Sincronização de catálogo, casamento de variantes (SKU, código de barras, handle+opções, título+opções), paridade de preço, escopos exigidos, registro de webhooks, fila de eventos e conexão de loja. |
| `src/checkout/` | Validação do corpo enviado pelo tema, escolha da rota, idempotência, permalink de carrinho e o serviço de checkout em si. |
| `src/theme/` | Script que roda no navegador do comprador (`bridge.client.js`) e sua geração com a configuração da vitrine. |
| `src/routes/` | Rotas HTTP: `/proxy` (App Proxy), `/webhooks`, `/healthz`, `/readyz`, `/metrics` e o painel em `/admin`. |
| `src/admin/` | Autenticação do painel (senha única, sessão em cookie, CSRF). |
| `src/jobs/` | Tarefas agendadas (ressincronização periódica do catálogo, retenção). |
| `src/app.ts`, `src/server.ts` | Composição dos módulos e ponto de entrada (`npm start`). |
| `test/` | Testes (`node:test`), com `test/db-helpers.ts` para um banco em memória já migrado. |
| `docs/research/` | Pesquisa sobre a plataforma Shopify, conferida contra a documentação oficial em 2026-10-05. Os documentos abaixo citam esses arquivos. |

## Documentação

- [docs/INSTALACAO.md](docs/INSTALACAO.md): passo a passo de instalação, da organização Shopify ao go-live e à operação.
- [docs/ARQUITETURA.md](docs/ARQUITETURA.md): componentes, fluxo da requisição, modelo de dados, segurança, estratégias de checkout, limitações e termos da Shopify.
