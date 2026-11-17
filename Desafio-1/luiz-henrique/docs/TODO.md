# TODO — Desafio 1 (luiz-henrique)

Lista de tarefas atual. Baseline: tag `v0.0.5` — “history, catalog pricing and websocket scaffold” (`0afba12`).
Plano detalhado: [`PLAN-AGENT-REVAMP.md`](PLAN-AGENT-REVAMP.md).

## 0. Baseline e documentação

- [x] Tag `v0.0.2` criada no commit `d854762`.
- [x] Diagnóstico da reutilização de `intencao_id` registrado no plano.
- [x] `AGENTS.md` atualizado com estado real, custos e comandos.
- [x] Docs canônicos revisados; docs históricos movidos para `docs/archive/`.
- [x] `docs/README.md` como índice (canônico × histórico).
- [x] `README.md` alinhado ao que está implementado (frontend local, sem CloudFront/VPC).
- [x] `docs/STACK.md`, `MODELO-BEDROCK-TOOLS.md`, `MODELO-USUARIOS.md`,
      `DEV-LOCAL-AGENTE.md`, `REQUISITOS-PDF-E-AUDITORIA.md` e `destroy-cleanup.md`
      revisados.

## 1. Paridade local/remota

- [x] Fallback local gera `INT-XXXXXXXX`.
- [x] Fallback local devolve `code`, `status`, `valor_centavos`, `expira_em`.
- [x] Fallback local cancela em `LIMITE_EXCEDIDO`/`INTENCAO_EXPIRADA`.
- [x] Fallback local mantém saldo por usuário.
- [x] `npx tsc --noEmit` no `agent/` passa.
- [x] Smoke test local: servidor sobe em `:3031` e devolve `400 invalid_request` para payload
      vazio, sem chamar o Bedrock.
- [ ] Rodar um fluxo local de duas compras no fallback e registrar o resultado.

## 2. Observabilidade (read-only)

- [x] `npm run check:model` criado (control plane, sem custo de Bedrock).
- [x] `npm run check:logs` criado (CloudWatch, sem criar recursos).
- [x] Rodar `npm run check:model`: runtime v15 `READY`, Haiku 4.5 (2026-11-17).
- [x] Rodar `npm run check:logs`: grupo
      `/aws/bedrock-agentcore/runtimes/luiz_henrique_agent-AD3mRGF7e9-DEFAULT` e Lambdas.
- [x] Confirmar logs do runtime no CloudWatch; documentado em `OPERATIONS.md`.

## 3. Estado autoritativo da intenção

- [x] Adicionar `conversa_id` ao payload do frontend e da Lambda do chat.
- [x] Criar/ler estado em `Conversas` (`pending_intencao_id`, `pending_status`).
- [x] Remover `Usuarios.ultima_intencao_id` do caminho de decisão.
- [x] Remover seed de `state.lastIntencaoId` e override em `realizar_compra`.
- [x] Remover `groundIntencaoIds` e o fallback que prefere estado antigo.
- [x] Implementar guarda de registro e fallback determinístico de registro.
- [x] Remover o fallback de pagamento que usava estado antigo.
- [x] Limpar estado em `paga`/`cancelada`/`expirada`/`indisponível`.

## 4. Tools e dados

- [ ] `registrar_intencao` recebe `itens: [{ produto_id, quantidade }]` e resolve preço no
      catálogo.
- [ ] Adicionar `conversa_id`, `motivo_falha`, `cancelada_em` em `Intencoes`.
- [ ] Separar `INTENCAO_CANCELADA`, `INTENCAO_EXPIRADA` e `INTENCAO_JA_PAGA`.
- [ ] Ajustar IAM mínimo para os novos acessos.
- [x] Parar de ler/escrever `ultima_intencao_id`; campo permanece legado.

## 5. Prompt e testes

- [x] Reescrever o prompt conforme §3.4 do plano (sem ID concreto no exemplo).
- [x] Adicionar teste de regressão: limite excedido → novo produto → novo ID.
- [x] Adicionar teste: ID inválido não é “corrigido” para outro.
- [x] Adicionar teste: registro fabricado é bloqueado.
- [x] Rodar o cenário local sem ARNs (`npm run test:local` passou).
- [ ] Adicionar teste: compra paga → novo produto → novo ID (coberto no local; falta na API).
- [ ] Adicionar teste: duas conversas isoladas (estado já existe; falta cobrir na API).
- [x] Rodar `npm run test:agent` na stack implantada (3/3 em 2026-11-17).

## 6. Evidências e entrega

- [x] Login com usuário válido (JWT) — coberto por `npm run test:agent`.
- [x] `POST /chat` sem token → `401` — coberto por `npm run test:agent`.
- [x] Compra com cartão — coberta por `npm run test:agent`.
- [x] Compra com Pix — coberta por `npm run test:agent`.
- [x] Limite excedido — coberto por `npm run test:agent`.
- [x] `intencao_id` inválido — coberto por `npm run test:agent`.
- [x] Uso real inicial do agente (catálogo, intenção, cartão/Pix, limite).
- [x] Fazer o deploy e rodar `npm run test:agent` (2026-11-17, 3/3 após hardening de IAM/histórico).
- [x] Preencher a tabela de evidências do `README.md` com o resultado dos testes.
- [ ] Convidar o instrutor (`npm run user:invite -- <email> [limite]`).
- [ ] Manter a API acessível até a correção.

## 7. Custos e limpeza

- [ ] Revisar `cdk diff` antes de cada deploy; nenhum serviço novo pago.
- [ ] Acompanhar o orçamento (US$ 20; ~US$ 5 gastos).
- [ ] Evitar chamadas repetidas ao Bedrock; usar fallback local para prompt.
- [ ] Após a correção, rodar `npm run destroy` e verificar órfãos.

## 8. Pendências de requisito

- [ ] Frontend S3 + CloudFront + OAC (bloqueado por SCP nesta conta; decisão registrada).
- [ ] API streaming ou WebSocket completo (PDF pede “Stream ou WebSocket”; WebSocket parcial).
- [x] `GET /conversas` + histórico de mensagens em `Conversas` (testado).
- [x] Resolver preço/produto pelo catálogo em `registrar_intencao` (centavos).
- [ ] Suíte ampla de 100+ casos e caso `REFUSAL-LOOP-01` (ver `TEST-STRATEGY.md`).
- [ ] Redirecionar para catálogo quando o produto não for identificado.
- [x] Capturas de tela da demo em `docs/apresentacao/`.
- [ ] Corrigir a coleção Postman (atualmente quebrada; não é usada nas evidências da §6).
- [ ] Fechar WebSocket `$default` — ver `WS-NEXT.md`.
- [x] Capturar e anexar os prints de 401 e `intencao_id` inválido; as 5 evidências estão inline no `README.md` (§6).
- [ ] Lista de conversas anteriores no menu lateral + botão “Nova conversa” (tipo Gemini/Qwen); hoje o chat reabre sempre a conversa anterior.
- [ ] Painel administrativo / grupo `admins`.
