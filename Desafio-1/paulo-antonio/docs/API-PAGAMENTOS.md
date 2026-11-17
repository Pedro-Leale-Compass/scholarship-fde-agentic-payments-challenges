# Ferramentas na Lambda e teste pela interface

## Rotas

Todas as rotas abaixo usam o autorizador Cognito do API Gateway. O backend utiliza somente `requestContext.authorizer.claims.sub` para identificar o usuário, ignorando IDs e preços enviados no corpo.

| Método e caminho | Função |
|---|---|
| `GET /sessao` | Valida a identidade da sessão |
| `GET /catalogo` | Lista produtos; aceita `categoria` opcional |
| `GET /conta` | Inicializa conta se ausente e retorna limite, gasto e saldo |
| `POST /intencoes` | Recebe `sku` e `quantidade`; cria intenção com valor do catálogo |
| `GET /intencoes/{id}` | Consulta intenção do titular; outro usuário recebe `404` |
| `POST /compras` | Recebe `intencao_id` e `metodo_pagamento`; executa transação simulada |
| `POST /chat` | Conversa e confirmação, via Lambda → AgentCore; streaming NDJSON |
| `GET /conversas` | Lista conversas do titular; `conversationId` recupera o histórico escolhido |

A conta é inserida condicionalmente com R$ 5.000 de limite simulado, a partir do `sub` autenticado, no primeiro acesso à conta ou criação de intenção. Novos logins não restauram saldo. O usuário não escolhe limite nem identidade nos argumentos.

Criação retorna `201`. Compras usam o contrato `aprovado` ou `recusado` com HTTP `200`; requisições malformadas retornam `400`. Falhas de infraestrutura retornam `503` sem corpo interno do SDK. A interface não repete uma compra automaticamente após falha de rede: bloqueia o botão e orienta consultar a intenção. O status persistido resolve a dúvida antes de nova tentativa.

`OPTIONS` permanece público para preflight; não retorna dados. CORS está restrito a `http://127.0.0.1:4173` enquanto o frontend for local. CORS não substitui autenticação.

## Implementação e permissões

`tools/src/lambda.ts` reúne o adaptador DynamoDB e `http-handler.ts`. `tools/scripts/build.mjs` empacota dependências em `tools/build/index.js` para Lambda Node.js 22 ARM64. A instalação aprova explicitamente somente o script de build do esbuild. O deploy instala as dependências travadas, compila a função e publica as stacks de dados/aplicação.

A função `paulo-antonio-pagamentos-tools` tem permissões de leitura/escrita somente nas três tabelas do projeto. Não possui `Scan`, `DeleteItem`, permissões administrativas ou acesso ao Bedrock. Sua role permite logs no próprio grupo, com retenção de sete dias. A Lambda de sessão permanece sem acesso ao DynamoDB. Invocações via API Gateway ficam restritas ao estágio, métodos e caminhos da aplicação.

O agente reutiliza as mesmas regras ao invocar a Lambda por IAM. A interface contém o
chat com streaming e o formulário direto de compras. No chat, o modelo solicita uma
confirmação; somente a ação explícita no botão, validada contra o registro do servidor,
autoriza a chamada de pagamento. Detalhes em `../agent/README.md`.

## Teste manual pela interface local

1. Iniciar `node scripts/preview-local.mjs --aws` na pasta `frontend` e abrir exatamente `http://127.0.0.1:4173`.
2. Entrar com usuário Cognito convidado e aguardar catálogo/limite.
3. Escolher MONITOR, quantidade 1 e clicar em **Preparar compra**.
4. Conferir o valor, selecionar Pix e clicar em **Confirmar compra simulada** antes de três minutos.
5. Em uma conta nova, esperar aprovação de R$ 1.899,90 e saldo R$ 3.100,10.
6. Recarregar a página: o saldo deve continuar salvo. A intenção atual é estado transitório da tela; seu registro permanece no backend.
7. Testar CADEIRA com cartão; em seguida PCGAMER deve recusar por limite insuficiente.

Não há cobrança real. Os limites consumidos na interface são persistentes; não reiniciar saldos apenas para repetir testes. O script de integração usa contas fictícias exclusivas e faz a própria limpeza.

## Validações

Os dois parágrafos seguintes registram a implantação inicial das ferramentas, antes da
integração do chat. O estado atual está no fim desta seção e no índice de evidências.

Em 16/11/2026 a stack de aplicação terminou em `UPDATE_COMPLETE`. O teste real da Lambda passou, incluindo leitura/escrita com sua própria role, Pix aprovado, recusa de duplicidade, isolamento e saldo persistido. Os fixtures foram removidos. As seis rotas rejeitaram token ausente/inválido com `401`; OPTIONS e CORS passaram. Uma primeira consulta imediatamente após o deploy retornou `403` na rota nova; depois da propagação, toda a verificação passou. O fluxo de compra completo pelo navegador com Cognito real ainda deve ser confirmado pelo usuário.

Testes locais: 20 casos das ferramentas/handler e nove de infraestrutura/sessão. A interface foi validada em navegador com respostas simuladas, incluindo recuperação de resposta perdida, botão de pagamento desativado após aprovação e largura de celular. Esses testes não usam credenciais reais nem substituem o fluxo completo com Cognito.

`node infra/scripts/smoke.mjs --backend` verifica as oito rotas protegidas com token ausente e inválido. `node test/lambda.integration.ts --account CONTA` na pasta `tools` invoca a Lambda real com contexto de autorização fictício via SSO administrativo: valida handler, permissões IAM, DynamoDB e regras, mas não comprova autenticação positiva no gateway. Todos os registros dessa execução são exclusivos e removidos ao final.

Atualização posterior: o usuário confirmou compras pelo navegador com login real, tanto
por Pix quanto por cartão, e recusas por limite/expiração no formulário. O chat completo
passou também no teste de integração do agente. O registro atual, com distinção entre
relato e captura visual, está em `EVIDENCIAS-E-ENTREGA.md`.
