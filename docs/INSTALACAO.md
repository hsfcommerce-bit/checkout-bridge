# Instalação do checkout-bridge

Passo a passo para colocar o serviço no ar e ligar as lojas. Os números entre colchetes (por exemplo [SC-13]) apontam para os itens da pesquisa em `docs/research/`, conferida contra a documentação da Shopify em 2026-10-05. Onde a Shopify não documenta um comportamento, o texto diz que ele precisa de teste em loja real: nada aqui foi executado contra uma loja de verdade.

## Antes de começar: hospedagem

O serviço precisa de:

- **Uma URL pública com HTTPS e certificado válido** (`PUBLIC_BASE_URL`). A Shopify só entrega webhooks em HTTPS com certificado verificado [AC-63] e o App Proxy aponta para essa URL. Em `NODE_ENV=production` o serviço se recusa a subir com uma URL `http://`.
- **Disco persistente** para o arquivo SQLite (`DATABASE_PATH`; no Docker, o volume `/app/data`). O banco guarda as lojas, os segredos cifrados, o catálogo sincronizado, os mapeamentos e o histórico de checkouts.
- **Uma única instância do processo.** Limites de taxa, idempotência de checkout (a espera por uma requisição concorrente do mesmo carrinho) e a fila de eventos de catálogo vivem na memória do processo. Duas instâncias atrás de um balanceador aplicariam limites separados e poderiam criar dois carrinhos para o mesmo clique.
- **`TRUSTED_PROXY_HOPS` igual ao número de proxies na frente do processo.** O serviço lê o IP do cliente de `X-Forwarded-For` (ou, na falta, de `X-Real-IP`) para limitar taxa (login do painel e checkout por IP), para o hash de IP das sessões e para o cabeçalho `Shopify-Storefront-Buyer-IP`. Todo proxy no caminho *acrescenta* ao fim desse cabeçalho o IP de quem o chamou e preserva o que já vinha (é o padrão do nginx com `$proxy_add_x_forwarded_for` e do Cloudflare); o item mais à esquerda é escrito pelo próprio cliente e pode ser forjado. Por isso o serviço conta `TRUSTED_PROXY_HOPS` itens a partir da direita e ignora o resto: um nginx, Caddy, Traefik ou Cloudflare na frente, `1` (padrão); CDN + proxy reverso, `2`; processo exposto diretamente, `0`. Nas chamadas pelo App Proxy a própria Shopify acrescenta o IP do comprador [SC-61] e o serviço conta esse salto a mais por conta própria. Quem preferir pode configurar o nginx com `proxy_set_header X-Forwarded-For $remote_addr;` (substitui em vez de acrescentar) e manter `1`. Um valor errado só enfraquece os limites por IP: o limite global de login do painel (30 tentativas por minuto somando todos os IPs) e o limite por loja do proxy continuam valendo.
- **Node.js 24.3 ou mais novo**, ou Docker (o `Dockerfile` usa `node:24-slim`).
- **Backup de `ENCRYPTION_KEY` fora do servidor.** Os segredos das lojas são cifrados com ela; perder a chave significa cadastrar todas as credenciais de novo (ver seção 10).

Variáveis de ambiente: todas estão descritas em `.env.example`. As obrigatórias são `PUBLIC_BASE_URL`, `ENCRYPTION_KEY` e `ADMIN_PASSWORD`; o `.env.example` vem com elas vazias e o serviço se recusa a subir sem elas (e com a senha de exemplo). Como elas chegam ao processo: `npm start` lê o arquivo `.env` do diretório atual, se existir (`node --env-file-if-exists=.env`); no Docker, `docker run --env-file .env`; no systemd, `EnvironmentFile=/caminho/.env` ou `WorkingDirectory=` apontando para o projeto. Fora disso o processo lê apenas o ambiente que recebe. Trocar `ADMIN_PASSWORD` e reiniciar invalida todas as sessões abertas do painel (o banco guarda um HMAC do token com chave derivada da senha); manter a senha mantém as sessões.

## 1. Agrupar as lojas em uma organização Shopify

O serviço se autentica na Admin API de cada loja com o **client credentials grant** de um app criado no Dev Dashboard. Esse tipo de acesso só funciona quando o app e a loja pertencem à **mesma organização Shopify** [SC-23]; com uma loja de outra organização, a Shopify responde `shop_not_permitted`, mesmo que a mesma pessoa seja dona das duas [SC-24, SC-10]. Além disso, um app do Dev Dashboard só pode ser instalado em lojas da organização em que foi criado [SC-10, SC-11].

Para lojas que não são Plus, uma organização é um grupo de lojas com usuários, configurações e cobrança compartilhados. As lojas **não** ficam na mesma organização automaticamente: a pessoa dona precisa agrupá-las [SC-13].

Requisitos para agrupar lojas não Plus [SC-13]:

- pelo menos duas lojas;
- a mesma pessoa como dona (store owner) de todas;
- a mesma moeda de cobrança em todas (INR não é aceita).

Caminho [SC-14]: admin da loja > **Configurações > Geral > Transferir loja > Gerenciar > "Mover a loja para uma organização nova ou existente"** > escolher ou criar a organização > Confirmar. Só a pessoa dona vê essa opção. Lojas Plus usam o mecanismo de lojas de expansão em vez disso.

Efeitos colaterais que valem conhecer [SC-15]: a cobrança e os meios de pagamento passam para o nível da organização, as permissões de cobrança e de gestão de usuários passam para a pessoa dona da organização, e a moeda de cobrança da organização nunca mais muda. Ao agrupar, usuários mantêm as permissões da loja, mas perdem as permissões de organização; o acesso ao Dev Dashboard é uma permissão de organização, então quem for criar o app pode precisar receber de novo o papel "App developer" (Desenvolvimento de apps > Desenvolver) [SC-17].

**Agrupe antes de criar o app.** A Shopify não documenta o que acontece com apps já criados quando a loja muda de organização.

Se alguma loja não puder ser agrupada, ela não pode ser ligada por este serviço do jeito como ele está escrito (ele só implementa o client credentials grant). A alternativa documentada pela Shopify é distribuição personalizada com authorization code grant [SC-12, SC-30], que não está implementada.

## 2. Criar o app no Dev Dashboard

Crie o app a partir do admin de uma loja da organização, não de uma organização de Partner: a Shopify indica que apps criados em organização de Partner não conseguem usar client credentials em lojas de produção [RISK-01]; a Central de Ajuda confirma que apps personalizados criados pelo lojista usam esse grant.

Caminho [SC-02, SC-01]: admin da loja > **Configurações > Apps > Desenvolver apps > Criar apps no Dev Dashboard**. No Dev Dashboard: **Apps > Create app > Start from Dev Dashboard**, dê um nome e crie.

Quantos apps criar: o serviço guarda um Client ID e um Client secret **por loja**. O mais simples é um app por loja, cada um com os escopos do papel daquela loja. Um único app para todas as lojas da organização também funciona [SC-10], desde que tenha a união dos escopos; nesse caso digite o mesmo Client ID e secret em cada loja do painel.

### 2.1 Credenciais

Em **Apps > seu app > Settings > Credentials** (a documentação também chama de "App settings") estão o **Client ID** e o **Client secret** [SC-08]. O secret é mostrado só ali; copie-o para colar no painel do serviço. O mesmo secret assina os webhooks e, por inferência da documentação, as requisições do App Proxy [SC-54]; isso precisa de confirmação na primeira requisição real.

### 2.2 Versão do app

Toda configuração do app vive em uma **versão**; o app só pode ser instalado depois que uma versão é lançada [SC-03]. Ao criar a versão (Apps > seu app > Versions > Create a version) [SC-04, SC-41]:

- **App URL**: pode ficar o valor padrão `https://shopify.dev/apps/default-app-home`; o app não tem interface embutida.
- **Webhooks API version**: `2026-10` (a mesma de `SHOPIFY_API_VERSION`). Essa versão define o formato do corpo dos webhooks [SC-07, AC-55].
- **Scopes (Access)**, por papel da loja (o painel do serviço mostra a mesma lista em cada loja):
  - vitrine: `read_products`, `read_inventory`, `write_app_proxy`, `read_orders`;
  - checkout: `read_products`, `read_inventory`, `read_orders`;
  - opcional na vitrine: `read_themes` e `write_themes`, só para o botão "Instalar no tema automaticamente" (sem eles, cole o bloco à mão).

  `read_orders` alimenta a página Vendas e o Dashboard (pedidos, faturamento, reembolsos e cancelamentos das lojas checkout) e, na vitrine, detecta pedidos fechados fora da ponte. O serviço guarda só id, número, data, moeda, totais, status e contagem de itens do pedido; nome, e-mail, telefone e endereço do comprador nunca são gravados. Se o app já estava instalado sem esse escopo, lance uma versão nova e aprove a mudança em cada loja; depois clique em "Conectar" no painel para as assinaturas de webhook de pedido serem criadas. A Shopify pode exigir a aprovação de "dados protegidos do cliente" para apps que recebem webhooks de pedido; para app da própria organização isso não está documentado e precisa de teste em loja real.

  `write_app_proxy` é exigido pela documentação para o app ter App Proxy [SC-48]; há relato de proxy funcionando sem ele, mas a exigência documentada é a regra [RISK-02]. O serviço confere, a cada conexão, se os escopos lidos na resposta do token incluem os exigidos [SC-26].
- **App proxy** (só faz sentido no app das vitrines; num app compartilhado a configuração não atrapalha as lojas checkout) [SC-40, SC-43, SC-44, SC-45]:
  - **Subpath prefix**: `apps` (os valores aceitos são `a`, `apps`, `community`, `tools`);
  - **Subpath**: `checkout-bridge` (letras, números, `_` e `-`; até 30 caracteres; `admin`, `services`, `password` e `login` são proibidos);
  - **Proxy URL**: `https://<sua-url>/proxy`.

  O caminho na loja fica `https://<vitrine>/apps/checkout-bridge`. Um app só pode ter um proxy [SC-40]. Mudar o Proxy URL numa versão nova vale imediatamente em todas as lojas; mudar prefixo ou subpath só vale para novas instalações [SC-46]. O lojista também pode trocar o caminho por loja em **Configurações > Apps > app > App Proxy URL > Customize URL** [SC-47]; o caminho cadastrado no painel do serviço precisa ser o que está em uso na loja.

Lance a versão (**Release**).

### 2.3 Storefront API da loja checkout

O serviço cria carrinhos na loja checkout pela Storefront API. Há três modos, escolhidos por loja no painel:

- **Sem token** (padrão). A Storefront API aceita criar e ler carrinhos sem credencial, com teto de complexidade de consulta 1.000 [SF-29, SF-30]. É o modo mais simples. Não envia o IP do comprador à Shopify (o cabeçalho só é documentado para token privado) e não lê quantidade em estoque. Qual canal de vendas (publicação) esse acesso enxerga não é documentado [SF-58]: precisa de teste em loja real.
- **Token privado** (`Shopify-Storefront-Private-Token`). É a forma documentada para chamadas feitas por um servidor [SF-34]; com ele o serviço envia o IP real do comprador em `Shopify-Storefront-Buyer-IP`, que a Shopify usa para diferenciar compradores e para a proteção contra bots [SF-43, SF-44]. A forma de obter um token privado sem código é instalar o canal **Headless** na loja checkout e clicar em **Create storefront**: ele gera um token público e um privado, sem validade documentada [SF-38]. Produtos precisam estar publicados no canal Headless para aparecerem [SF-56].
- **Token público** (`X-Shopify-Storefront-Access-Token`). Feito para navegadores; a capacidade é contada por IP do comprador, então chamadas de um único servidor concentram tudo num IP [SF-31]. Existe aqui só como opção; prefira os outros dois.

Se a Shopify responder **HTTP 430** (rejeição de segurança) às chamadas sem token, o serviço emite um alerta pedindo a troca para token privado com o IP do comprador [SF-45].

## 3. Instalar o app nas lojas

No Dev Dashboard, abra o app e clique em **Install app** no cartão *Installs* (ou no menu de três pontos na lista de apps). O link de instalação abre o fluxo de consentimento; escolha a loja e confirme [SC-09]. Repita para cada loja (o mesmo link serve para outras lojas da organização [SC-11]).

Pré-requisitos para o token funcionar depois: versão lançada com os escopos, app instalado na loja, loja e app na mesma organização [SC-23].

**Mudança de escopo**: exige lançar uma versão nova **e** aprovar a mudança em cada loja onde o app está instalado [SC-27]. A documentação diverge sobre a aprovação ser automática para apps da própria organização [SC-28]; trate a aprovação por loja como necessária e confira pelo relatório de conexão do painel.

## 4. Cadastrar as lojas no painel

Abra `https://<sua-url>/admin`, entre com `ADMIN_PASSWORD` e vá em **Lojas > Nova loja**. Campos:

- **Papel**: vitrine ou checkout.
- **Nome**: como a loja aparece no painel e nos alertas.
- **Domínio myshopify.com**: `xxx.myshopify.com` (não o domínio próprio).
- **Client ID** e **Client secret** do app (seção 2.1). O secret é cifrado com `ENCRYPTION_KEY` e nunca é mostrado de volta; ao editar, campo vazio significa "manter".
- **Domínio público** (opcional): preenchido automaticamente na conexão com o domínio principal da loja; só preencha para forçar um valor. Na loja checkout é o host usado no permalink de carrinho e o único host (além do `xxx.myshopify.com`) aceito na URL de checkout devolvida pela Shopify: um valor errado aqui faz toda compra ser recusada com `upstream_rejected` (motivo `checkout_url_host` no log e no alerta).
- **Caminho do App Proxy** (só vitrine): `/apps/checkout-bridge`, igual ao da seção 2.2 (ou ao personalizado na loja).
- **Modo da Storefront API** e **Token** (só checkout): seção 2.3.

Depois de salvar, clique em **Conectar**. O relatório de conexão tem cinco etapas:

| Etapa | O que confere | Se falhar |
| --- | --- | --- |
| Credenciais | Pede um token e lê nome, moeda e domínio da loja; confere que o domínio respondido é o cadastrado. Só esta etapa interrompe as demais. | Confira domínio, Client ID e secret, se a versão foi lançada e se o app está instalado nesta loja. `shop_not_permitted`: loja fora da organização do app (seção 1). |
| Escopos | Compara os escopos lidos na resposta do token com os exigidos para o papel. | Adicione os escopos no app, lance versão nova, aprove na loja e conecte de novo. |
| Webhooks | Cria (ou confirma) as assinaturas `products/create`, `products/update`, `products/delete` e `app/uninstalled` apontando para `https://<sua-url>/webhooks/shopify`. | A loja funciona só com a ressincronização periódica até você conectar de novo. |
| Catálogo | Sincroniza produtos e variantes pela Admin API, página a página. Uma sincronização que falha nunca apaga o catálogo anterior. | Confira o escopo `read_products` e conecte de novo. |
| Mapeamentos | Recalcula o casamento de variantes em todas as rotas em que a loja participa. | Informativo; é refeito a cada mudança de catálogo. |

O status final é **Conectada** quando credenciais e catálogo passam e nenhum escopo falta; **Erro** caso contrário, com o primeiro problema no detalhe. **Desativada** é uma decisão manual (botão Desativar) e bloqueia o checkout que passa pela loja.

Duas observações sobre webhooks: assinaturas criadas pela API são apagadas pela Shopify depois de 8 falhas seguidas de entrega (as tentativas se espalham por 4 horas) [AC-64]; "Conectar" as recria. A Shopify envia aviso por e-mail ao endereço de desenvolvedor de emergência do app antes disso: mantenha esse e-mail monitorado. E a Shopify debounce entregas com corpo idêntico e não garante ordem nem entrega [AC-66]; por isso existe a ressincronização completa periódica (`CATALOG_RESYNC_MINUTES`).

## 5. Criar as rotas

Em **Rotas > Nova rota** você liga uma vitrine a uma loja checkout. É a única coisa que decide para onde o comprador vai.

- **Tipo**: `default` (destino da vitrine quando nenhuma rota por país se aplica) ou `country` (destino para compradores dos países listados, códigos ISO 3166-1 alpha-2, por exemplo `BR, PT`). O país vem do contexto de mercado da vitrine (`Shopify.country` no tema), é usado para escolher a rota e vai no carrinho como país do comprador; ele não decide preço.
- **Regra de unicidade** entre rotas ativas de uma vitrine: no máximo uma `default`, e cada país em no máximo uma rota `country`. O painel recusa a segunda. Rotas desativadas não contam.
- **Política de paridade de preço**: `block` (recusa o checkout e alerta quando o preço da loja checkout difere do da vitrine além da tolerância; padrão), `warn` (registra e segue) ou `off` (não compara).
- **Tolerância**: diferença relativa aceita, em porcentagem (0 = preço idêntico).
- **Quantidade máxima por variante** (padrão 50; vale para cada linha e para a soma das linhas que caem na mesma variante da loja checkout, com ou sem personalização: 3 "Ana" + 3 "Bia" da mesma variante precisam de limite >= 6) e **máximo de linhas** (padrão 100; o serviço nunca passa de 100 linhas por checkout, mesmo que a rota permita mais).
- **Estratégia**: `storefront_cart` (carrinho pela Storefront API, conferido linha a linha; padrão) ou `permalink` (link direto de carrinho, sem chamada à Shopify no clique). A diferença está em `docs/ARQUITETURA.md`.
- **Permitir permalink como reserva**: se a Storefront API da loja checkout estiver indisponível (rede, tempo limite, circuito aberto), usar um permalink **na mesma loja checkout**. Recusa da Shopify (erro de validação) nunca cai nesse caminho.

Ao salvar, o mapeamento do par vitrine/checkout é recalculado. Se mudar a tolerância, as divergências são recalculadas (com a menor tolerância entre as rotas do par, também nas decisões manuais). Remover uma rota pede confirmação numa segunda página, com aviso quando a rota está ativa; nada é apagado antes dela.

## 6. Revisar os mapeamentos

Em **Rotas > sua rota > Mapeamentos** está a lista de variantes da vitrine com o destino na loja checkout. O casamento automático usa, nesta ordem, a regra mais confiável que encontrar: **SKU**, **código de barras**, **handle do produto + opções**, **título do produto + opções**. As três primeiras ativam o mapeamento; a última só sugere.

| Status | Significado | O que fazer |
| --- | --- | --- |
| Ativo | Usado no checkout. | Nada, salvo se houver divergência. |
| Sugerido | Casou só por título + opções, regra menos segura. Não é usado no checkout. | Conferir e **Aprovar**, ou **Definir manualmente** outro destino. |
| Conflito | Mais de um candidato na loja checkout (SKU repetido, dois produtos de mesmo título). Não é usado. | **Escolher** um dos candidatos listados. |
| Sem destino | Nenhum candidato. Um item assim no carrinho faz o checkout ser recusado. | Criar a variante na loja checkout (com o mesmo SKU) e sincronizar, ou **Definir manualmente** pelo ID numérico da variante (há uma busca no catálogo do checkout). |
| Desativado | Desligado por você. O item não pode ser vendido pela ponte. | Reativar com uma decisão manual ou **Voltar ao automático**. |

Decisões manuais ficam **travadas**: o casamento automático não as sobrescreve. "Voltar ao automático" destrava a linha e recalcula o par.

**Divergência** é uma diferença entre a variante da vitrine e a variante de destino, calculada sobre o catálogo sincronizado das duas lojas (preço de catálogo na moeda padrão de cada loja). Tipos: **Preço** (fora da tolerância da rota), **Moeda** (lojas com moedas padrão diferentes), **Preço comparativo** ("de/por" presente só de um lado ou diferente), **Título**, **Opções**, **Disponibilidade** (a vitrine vende e o checkout não) e **Status do produto** (o produto do checkout está em rascunho, arquivado ou sumiu). Preço e moeda são as divergências que **bloqueiam** o checkout com política `block`; as outras são aviso para você corrigir o catálogo. O filtro "só divergentes" lista tudo o que precisa de atenção.

## 7. Instalar o script no tema e desligar os botões de compra acelerada

### 7.1 Script

Na página da vitrine, o botão **Instalar no tema automaticamente** grava o bloco no `layout/theme.liquid` do tema publicado (precisa dos escopos `read_themes` e `write_themes` no app; a Shopify pode exigir isenção para escrever em temas, caso em que o painel mostra a recusa). Rodar de novo substitui o bloco antigo pelo atual. A alternativa é a colagem manual descrita abaixo.

Em **Lojas > sua vitrine**, a seção "Instalação na vitrine" traz dois trechos gerados com a configuração daquela loja:

- **Bloco inline**: cole no `theme.liquid`, antes de `</body>`. É o modo recomendado: não depende de uma requisição extra por página.
- **Linha de carregamento** (`<script src="/apps/checkout-bridge/bridge.js" defer>`): carrega o script pelo App Proxy a cada página vista. Depende do proxy estar no ar, e a Shopify não documenta cache de respostas do proxy [SC-68, RISK-04].

O script intercepta o envio do formulário de carrinho cujo botão se chama `checkout` (é assim que Dawn, Horizon e `{% form 'cart' %}` levam ao checkout [CK-01, CK-02, CK-05 a CK-08]), links para a rota `/checkout` exata (com ou sem prefixo de idioma; uma página ou coleção chamada "checkout", como `/pages/checkout`, não conta) e alguns seletores de gavetas de carrinho de apps. Antes de ler o carrinho ele envia os campos `note`, `attributes[...]` e `updates[...]` do formulário para `cart/update.js`, para não perder nota, atributos e quantidades editadas; depois lê `cart.js` e envia só `variant_id`, `quantity`, propriedades e um sinal de assinatura por linha. Em caso de falha, mostra uma mensagem ao comprador e libera o botão. O script gerado pelo painel usa a configuração padrão (`acceleratedButtons: 'hide'`, `onError: 'message'`, sem seletores extras). Se o tema tiver um botão de checkout que o script não reconhece, a configuração aceita seletores CSS adicionais em `extraSelectors`, mas hoje o painel não tem campo para isso: a opção fica para uma versão futura ou para edição manual do bloco inline gerado (o objeto JSON logo depois de `var RAW =`).

Um lembrete sobre o tema: mudar de tema ou publicar outra cópia do tema remove o bloco; recoloque-o e teste de novo (seção 8).

### 7.2 Botões de compra acelerada

Os botões "Comprar agora", Shop Pay, Apple Pay, Google Pay, PayPal e similares levam direto ao checkout **da própria vitrine**, para um item (página de produto) ou para o carrinho inteiro, e criariam o pedido na vitrine com os preços dela [CK-14]. Eles são elementos personalizados com shadow DOM fechado e não têm API para cancelar ou redirecionar o checkout que iniciam [CK-11, CK-12]. O script os esconde por CSS como rede de segurança, mas esconder não é desligar: desligue-os no tema. Temas da Theme Store vêm com eles ligados por padrão [CK-03]. A própria Shopify lista apps que levam a um checkout externo como possivelmente incompatíveis com esses botões [CK-18].

- **Dawn, página de produto**: editor de tema > template Produto > seção "Informações do produto" > bloco "Botões de compra" > desmarque **"Mostrar botões de checkout dinâmico"** (configuração `show_dynamic_checkout`). Repita em seções "Produto em destaque" [CK-15].
- **Dawn, carrinho**: não há configuração; os botões aparecem sempre que a loja tem meios de pagamento com checkout acelerado. É preciso editar o código: em `sections/main-cart-footer.liquid`, remova o bloco `{% if additional_checkout_buttons %} ... {{ content_for_additional_checkout_buttons }} ... {% endif %}` [CK-17].
- **Horizon, página de produto**: o botão é um bloco estático "Accelerated checkout" dentro do bloco de botões de compra, sem caixa de seleção; blocos estáticos não podem ser removidos, mas podem ser **ocultados** no editor de tema. Oculte-o [CK-15, correção].
- **Horizon, carrinho**: configuração do tema `show_accelerated_checkout_buttons` (grupo Carrinho); desmarque [CK-17].
- **Outros temas**: procure a configuração de botões de checkout dinâmico/acelerado no bloco de botões de compra e no carrinho; se não houver, edite o código. Depois, confira nas páginas renderizadas da vitrine que não existe `<shopify-accelerated-checkout>` nem `<shopify-accelerated-checkout-cart>`.

Outros caminhos que levam ao checkout da vitrine sem passar pelo serviço: links de checkout criados no admin (canal Buy Button) e links de desconto compartilhados. Não os use na vitrine. O serviço não detecta pedidos criados diretamente na vitrine (ele não assina webhooks de pedido); acompanhe a lista de pedidos da vitrine, que deveria ficar vazia.

## 8. Testar

**8.1 Endereço de ping.** Abra `https://<vitrine>/apps/checkout-bridge/ping` no navegador (o painel mostra o link na página da vitrine). A resposta certa é um JSON deste serviço: `{"ok":true,"shop":"xxx.myshopify.com","at":"..."}`. Se vier a página HTML da loja ou um 404, o App Proxy não está configurado nessa loja, o caminho é outro, ou a loja está protegida por senha (ver limitações em `docs/ARQUITETURA.md`). `{"ok":false,"code":"unauthorized"}` indica loja não cadastrada no painel, segredo diferente do do app ou relógio do servidor fora do horário (o timestamp assinado tem janela de 90 s).

**8.2 Botão "Testar rota".** Em **Rotas > sua rota**, o botão cria um carrinho de teste na loja checkout com uma amostra de até 10 variantes mapeadas (uma unidade cada, atributo `bridge_test=1`) e lista o que falhou: variante que não entrou no carrinho (produto não publicado no canal que a Storefront API lê), sem estoque, indisponível para o país da rota, preço diferente da vitrine. Não cria sessão nem redireciona ninguém. Em rota por permalink só os dados em cache são conferidos, porque a Shopify não devolve nada ao montar o link; abra o permalink num navegador para confirmar que o carrinho carrega.

**8.3 Compra real.** Faça pelo menos uma compra completa, de preferência com um produto de teste barato, e repita nos caminhos que a vitrine oferece: página do carrinho, gaveta do carrinho, notificação de item adicionado, compra direta na página de produto, celular. Confira:

- o checkout abriu na **loja checkout** (domínio dela), no idioma da vitrine, com os mesmos itens e quantidades;
- o pedido na loja checkout traz os atributos `bridge_session` e `bridge_source` (nome da vitrine) e, se usados, os parâmetros de atribuição; isto confirma que atributos do carrinho chegam ao pedido, o que a documentação não garante [SF-26, AT-14];
- em **Painel > Sessões** a sessão aparece como criada, com a mesma loja e estratégia;
- **nenhum pedido** foi criado na vitrine;
- se a loja checkout usa Markets ou mais de uma moeda, compre com o país correspondente e confira o preço cobrado;
- se houver pixel ou GA na loja checkout, confira que o evento de compra foi registrado.

Teste também uma falha controlada: desative a rota e clique em finalizar compra. O comprador deve ver a mensagem "O checkout está temporariamente indisponível" e o botão voltar a funcionar.

## 9. Checklist de go-live

- [ ] Todas as lojas na mesma organização; apps criados no Dev Dashboard da organização (não de Partner).
- [ ] Versão lançada com os escopos do papel e instalada em cada loja; App Proxy configurado na vitrine.
- [ ] `PUBLIC_BASE_URL` em https com certificado válido; `/readyz` responde `{"ok":true}`.
- [ ] `ENCRYPTION_KEY` e `ADMIN_PASSWORD` fortes; cópia da chave guardada fora do servidor.
- [ ] Cada loja com status **Conectada** e relatório sem escopo faltando; webhooks criados.
- [ ] Rota `default` ativa por vitrine (e rotas por país, se usadas); teste da rota sem problemas.
- [ ] Mapeamentos sem "Sugerido", "Conflito" e "Sem destino" nos produtos à venda; divergências de preço e moeda zeradas (ou política e tolerância conscientes).
- [ ] Script no `theme.liquid` da vitrine; ping responde JSON; compra real concluída na loja checkout.
- [ ] Botões de compra acelerada desligados na página de produto e no carrinho da vitrine; nenhum `<shopify-accelerated-checkout>` nas páginas.
- [ ] Loja checkout **sem** senha de loja virtual; produtos publicados no canal que a Storefront API lê.
- [ ] `ALERT_WEBHOOK_URL` apontando para um canal que alguém lê; `METRICS_TOKEN` definido se `/metrics` for acessível de fora.
- [ ] Backup do banco agendado (seção 10.1).
- [ ] Uma única instância em execução.

## 10. Operação

### 10.1 Backups

O banco é um arquivo SQLite em modo WAL. Há dois jeitos seguros de copiar:

- com o serviço no ar, `sqlite3 data/bridge.db ".backup /caminho/backup-AAAA-MM-DD.db"` (a API de backup do SQLite gera uma cópia consistente);
- com o serviço parado, copiar `bridge.db` junto com `bridge.db-wal` e `bridge.db-shm`, se existirem.

Copiar só o `bridge.db` com o serviço rodando pode gerar um arquivo inconsistente. Guarde também `ENCRYPTION_KEY`: os segredos no banco só se abrem com ela. Para restaurar, pare o serviço, substitua o arquivo, confira `DATABASE_PATH` e suba. Se a chave for trocada, cadastre de novo o Client secret e o token de Storefront de cada loja no painel.

### 10.2 Rotação do Client secret

No Dev Dashboard: **Apps > seu app > Settings > Credentials > Rotate**. O secret antigo e o novo ficam válidos ao mesmo tempo até você revogar o antigo; cada token de acesso fica preso ao secret que o emitiu [SC-31]. Por até uma hora depois da rotação a Shopify ainda assina webhooks com o secret antigo [AC-62]; qual secret assina o App Proxy durante a rotação não é documentado [SC-32].

O serviço guarda **um** secret por loja. Procedimento com menor impacto:

1. Rotacione no Dev Dashboard (sem revogar o antigo) num horário de pouco tráfego.
2. Imediatamente, edite a loja no painel com o novo secret e clique em **Conectar** (novo token emitido com o novo secret).
3. Durante até uma hora, webhooks assinados com o secret antigo serão recusados (401) e repetidos pela Shopify ao longo de 4 horas; a ressincronização periódica cobre o que se perder. Se o App Proxy passar a recusar requisições (`unauthorized` no log, métrica `bridge_proxy_auth_failures_total{reason="bad_signature"}`), ele ainda assina com o antigo: volte o secret antigo no painel por enquanto e tente de novo mais tarde. Este comportamento precisa de teste em loja real.
4. Só depois de confirmar que proxy e webhooks funcionam com o novo secret, revogue o antigo.

### 10.3 Versão da API (bump anual)

O serviço fixa `SHOPIFY_API_VERSION=2026-10` nas chamadas Admin e Storefront. Essa versão é servida até **16 de outubro de 2027** [SC-00]; depois disso a Shopify passa a responder com a versão estável mais antiga ainda acessível, sem erro [SF-03], e o comportamento pode mudar em silêncio. Antes dessa data:

1. leia as notas de lançamento das versões seguintes (campos usados: `ProductVariant.barcode` já está descontinuado na 2026-10 e será removido em alguma versão futura [AC-05]);
2. atualize `SHOPIFY_API_VERSION` e a **Webhooks API version** da versão do app, lance a versão;
3. rode os testes de compra da seção 8.

O cliente da Admin API registra em log quando o cabeçalho `X-Shopify-API-Version` da resposta difere da fixada, no máximo uma vez a cada 10 minutos por loja.

### 10.4 Alertas

Com `ALERT_WEBHOOK_URL` definido, cada alerta é enviado em JSON com os campos `text` (Slack), `content` (Discord), `key`, `severity` (`info`/`warning`/`critical`), `title`, `detail` e `at`. Alertas com a mesma chave são suprimidos por 5 minutos. Sem webhook, os alertas ficam só no log. Os principais:

| Alerta | Severidade | Significado |
| --- | --- | --- |
| Vitrine sem rota ativa | crítico | Checkout recusado porque nenhuma rota atende o comprador. |
| Preço na loja checkout diferente da vitrine | crítico | Rota com política `block` recusou o checkout. Corrija o preço ou ajuste a tolerância. |
| Variante sem par ativo / destino fora do catálogo | aviso | Item do carrinho sem mapeamento utilizável. Revise os mapeamentos. |
| Variante sumiu do carrinho sem aviso de estoque | crítico | Provável produto não publicado no canal que a Storefront API lê. |
| Carrinho trouxe itens não pedidos | crítico | A loja checkout tem alguma automação alterando carrinhos. |
| Storefront API indisponível: circuito aberto | crítico | A loja checkout não responde; o checkout dela fica fora do ar até voltar. Não há desvio para outra loja. |
| HTTP 430 da Storefront API | crítico | Rejeição de segurança; use token privado com IP do comprador. |
| Storefront API recusou o acesso | crítico | Token inválido ou escopos `unauthenticated_*` ausentes. |
| Loja checkout congelada, bloqueada ou inativa | crítico | A Storefront API respondeu HTTP 402/423 ou `SHOP_INACTIVE`. Regularize a loja na Shopify; o checkout dela fica fora do ar até lá. |
| A loja checkout recusou itens do carrinho (regra de quantidade, plano de venda, variante não aplicável, validação de checkout) | aviso | `userErrors` determinístico do `cartCreate`: o comprador recebe `quantity_exceeded`, `selling_plan_unsupported`, `variant_unavailable` ou `checkout_validation` e o lojista precisa agir (regras de quantidade da variante e limite da rota, mapeamento da variante, Function de validação instalada na loja checkout). Um alerta por loja e por classe a cada 5 minutos. |
| A Shopify recusou o checkout da rota | aviso | `upstream_rejected` numa rota: `userErrors` do `cartCreate` (mapeamento para variante inválida, regra de quantidade), carrinho truncado, loja inativa, URL inválida ou URL de checkout fora do host da loja checkout (`checkout_url_host`; confira o domínio público cadastrado). O motivo vem em `detail`. Um alerta por rota a cada 5 minutos. |
| App desinstalado na loja | crítico | A loja perdeu o token; reinstale o app e conecte de novo. |
| Falha ao processar webhook | aviso | A entrega foi marcada como vista e não será reprocessada; a ressincronização cobre. |
| Sincronização de catálogo falhou | aviso | O catálogo anterior foi mantido. Veja o detalhe na página da loja e conecte de novo. |
| Falha de token/escopos da Admin API | crítico | Credenciais, organização ou instalação. Veja o relatório de conexão. |

### 10.5 Métricas e logs

`GET /metrics` devolve texto Prometheus; com `METRICS_TOKEN` definido exige `Authorization: Bearer <token>`. Métricas principais: `bridge_checkout_requests_total{result,code}` e `bridge_checkout_request_ms` (rota do proxy), `bridge_checkout_sessions_total{result,strategy,code}` e `bridge_checkout_ms` (serviço), `bridge_checkout_permalink_fallback_total`, `bridge_checkout_parity_warnings_total`, `bridge_proxy_auth_failures_total{reason}`, `bridge_proxy_rate_limited_total{scope}`, `bridge_storefront_requests_total`, `bridge_storefront_circuit_state{store}`, `bridge_admin_token_requests_total`, `bridge_catalog_sync_total`, `bridge_catalog_variants`, `bridge_mappings{status}`, `bridge_mappings_divergent`, `bridge_catalog_queue_pending`, `bridge_webhooks_total{topic,result}`.

Logs saem em JSON (pino) no nível `LOG_LEVEL`. Segredos, tokens, senhas, URL do webhook de alertas e IP do comprador são censurados por nome de campo; a query string do proxy (que traz a assinatura) e o corpo das requisições nunca são logados; URLs de checkout (que podem trazer a chave do carrinho) também não. Cada requisição tem um `requestId`, devolvido no cabeçalho `X-Request-Id`, para correlacionar com o log; erros inesperados (resposta 500) saem no log com esse `requestId`, o nome, a mensagem e o stack do erro, enquanto a resposta ao cliente é genérica.

`GET /healthz` responde sem tocar no banco (vida do processo); `GET /readyz` confere o banco e responde 503 se ele não estiver acessível. A Shopify fica fora das duas de propósito: uma loja fora do ar não pode tirar o serviço do balanceador.

### 10.6 Rotinas automáticas

- Ressincronização completa de catálogo a cada `CATALOG_RESYNC_MINUTES` (padrão 6 h; 0 desliga). Cobre webhooks perdidos e mudanças que não geram webhook. Pode ser disparada à mão em **Lojas > loja > Sincronizar catálogo** (se o recálculo dos mapeamentos falhar depois dela, a sincronização continua válida e o erro aparece na mensagem do painel e na auditoria). O instante da última rodada concluída fica no banco (tabela `job_runs`): depois de um reinício a próxima rodada é agendada para o tempo que faltava (no mínimo 2 minutos após a partida), não para um intervalo inteiro, então um processo reiniciado com frequência continua ressincronizando.
- Expurgo de sessões de checkout e auditoria mais antigas que `RETENTION_DAYS` (padrão 90), de eventos de webhook com mais de 7 dias e de sessões do painel expiradas: 1 minuto após cada partida e, depois, a cada 24 h. Na mesma rodada, a URL do checkout e o id do carrinho das sessões de checkout já expiradas são apagados (a URL leva a chave do carrinho); o resto da sessão fica até o fim da retenção.
- Tokens da Admin API renovados antes de expirar (5 minutos antes das 24 h).
