# Documentação — Desafio 1 (luiz-henrique)

Última verificação contra o código: **2026-11-17**

Baseline atual: tag `v0.0.3` — “checkout state fixed and validated” (`947da6f`)
Baseline histórico: `v0.0.2` — “chat works sometimes” (`d854762`)

## Status verificado em 2026-11-17

- Runtime: `luiz_henrique_agent-AD3mRGF7e9`, versão 15, `READY`.
- Modelo: `us.anthropic.claude-haiku-4-5-20251001-v1:0` (Claude Haiku 4.5).
- Logs: `/aws/bedrock-agentcore/runtimes/luiz_henrique_agent-AD3mRGF7e9-DEFAULT` e
  `/aws/lambda/luiz-henrique-*`.
- Bug do `v0.0.2` (reutilização de `intencao_id`): corrigido e validado localmente e na
  stack (`npm run test:agent`, 3/3 em 2026-11-17). Evidência histórica em
  `PLAN-AGENT-REVAMP.md` §1.1.

## Comece por aqui

| Documento | Para quê |
|---|---|
| [`../README.md`](../README.md) | Visão geral, como rodar, deploy, modelo, dados e limitações conhecidas |
| [`PLAN-AGENT-REVAMP.md`](PLAN-AGENT-REVAMP.md) | Plano detalhado para corrigir a reutilização de `intencao_id` e o estado do checkout |
| [`STACK.md`](STACK.md) | Arquitetura **implementada** hoje (sem S3/CloudFront/VPC) |
| [`MODELO-BEDROCK-TOOLS.md`](MODELO-BEDROCK-TOOLS.md) | Modelo, tools, fluxo do runtime e falhas conhecidas |
| [`MODELO-USUARIOS.md`](MODELO-USUARIOS.md) | DynamoDB: `Usuarios`, `Conversas`, `Intencoes`, `Catalogo` |
| [`DEV-LOCAL-AGENTE.md`](DEV-LOCAL-AGENTE.md) | Rodar o agente localmente com paridade com o remoto |
| [`REQUISITOS-PDF-E-AUDITORIA.md`](REQUISITOS-PDF-E-AUDITORIA.md) | Requisitos do PDF × estado atual (com prazos e pendências) |
| [`OPERATIONS.md`](OPERATIONS.md) | Deploy, modelo vivo, logs, custos e troubleshooting |
| [`destroy-cleanup.md`](destroy-cleanup.md) | Operação de destroy, limpeza e verificação de órfãos |
| [`TEST-STRATEGY.md`](TEST-STRATEGY.md) | Suíte futura de 100+ casos, métricas e caso de loop de recusa |
| [`TODO.md`](TODO.md) | Lista de tarefas atual (somente tarefas) |

## Documentos históricos

Estão em [`archive/`](archive/README.md) e **não devem ser usados como estado atual**:
planos concluídos, análises de incidentes antigos e notas de migração. Eles foram mantidos
para contexto, com um aviso no topo.

## Convenções

1. Todo doc canônico declara a data da última verificação e aponta para arquivos/linhas do
   código quando afirma comportamento.
2. Mudou código que afeta o doc? Atualize o doc na mesma alteração.
3. Não use `TODO.md` para explicações; ele é só lista de tarefas.
4. Não adicione screenshots/credenciais/ARNs que não sejam públicos. Evidências ficam no
   `README.md` ou em `logs/` quando forem operacionais.
5. Docs históricos vão para `archive/`; não os edite para “parecer atuais”.

## Verificações rápidas (somente leitura)

```bash
npm run check:model   # BEDROCK_MODEL_ID do runtime implantado (control plane, sem custo de Bedrock)
npm run check:logs    # log groups/streams do agente e das Lambdas (CloudWatch)
```

Esses comandos exigem credenciais AWS (`aws sso login --profile desafio-1`). Não criam
recursos e não invocam o modelo. Ver [`OPERATIONS.md`](OPERATIONS.md) para o roteiro
completo.
