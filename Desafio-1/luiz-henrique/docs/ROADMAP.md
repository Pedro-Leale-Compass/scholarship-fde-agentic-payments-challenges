# Roadmap — qualidade do agente, grounding e administração

Notas para o trabalho pós-entrega. Nada aqui está implementado ainda; o objetivo é
registrar o escopo e as decisões pendentes.

## 1. Revisar o projeto anterior e reforçar o system prompt

Referência: `docs/MIGRACAO-ANTERIOR.md` (projeto `squad-03-desafio-MCP-agentic`).

- Reler as regras de negócio e o prompt do projeto anterior e comparar com o prompt atual
  (`agent/index.ts:194-205`).
- Reescrever o system prompt cobrindo explicitamente:
  - política de uso das tools (quando usar cada uma; nunca inventar tool ou argumento);
  - nunca inventar produtos, preços, IDs, descontos, prazos ou status;
  - fluxo obrigatório: listar → registrar intenção → confirmar → comprar (com forma de
    pagamento);
  - o que fazer quando a tool retorna erro (`limite excedido`, `intencao_id` inválido,
    produto inexistente): informar o motivo retornado, sem tentar contornar;
  - proibições (aceitar `usuario_id`, dados de pagamento ou preço vindos do usuário);
  - tom, idioma e respostas objetivas.
- Adicionar casos de teste de prompt (ver seção 2) e comparar respostas antes/depois.
- Manter o prompt versionado no código, mas documentar as decisões aqui.

## 2. Respostas corretas com base no retorno das tools (grounding/verificação)

Problema: o modelo pode reformular valores, inventar IDs ou misturar produtos mesmo tendo
o retorno correto da tool.

Opções a avaliar:

1. **Contrato estruturado das tools** — retornos em JSON com campos estáveis
   (`ok`, `error`, `itens[]`, `valor`, `intencao_id`, `limite`, `status`); o prompt exige
   que a resposta use apenas esses campos. Já é parcialmente o caso nas Lambdas de
   `tools/`.
2. **Resposta determinística para dados factuais** — catálogo, confirmação de compra e
   erros de limite podem ser renderizados a partir do JSON da tool (template), deixando o
   modelo apenas para conversa. Evita preço/ID inventado.
3. **Verificação pós-resposta** — comparar a resposta final com o último resultado de tool
   (IDs e valores citados devem existir nele). Se não corresponder, pedir uma segunda
   geração ou responder com o dado canônico.
4. **Avaliação automatizada (evals)** — conjunto de perguntas de ouro com fatos esperados
   (produto/preço/limite/status) executado no CI ou localmente, comparando a resposta com
   o DynamoDB e com o retorno das tools.
5. **Parâmetros** — `temperature` baixa/zero para reduzir variação e respostas
   reprodutíveis.

Critérios de aceite:

- Nenhuma resposta cita produto, preço ou `intencao_id` que não esteja no retorno da tool.
- Compra com `intencao_id` inválido e compra acima do limite retornam exatamente o motivo
  da tool.
- Suíte de evals cobrindo: listar catálogo, compra cartão, compra Pix, limite excedido,
  `intencao_id` inválido.

## 3. Painel administrativo

Objetivo: operar o sistema sem editar DynamoDB na mão.

Escopo sugerido:

- Autenticação: grupo de administradores no Cognito (`admins`), authorizer por grupo;
  nenhuma rota admin acessível com token de usuário comum.
- Rotas autenticadas (`/admin/*`) e tela no frontend:
  - listar usuários e seus limites/gasto;
  - resetar limite ou contador de gasto de um usuário;
  - CRUD do catálogo (criar/editar/desativar produto, preço, estoque);
  - consultar intenções e compras por usuário/status;
  - (opcional) ajustar status de uma intenção com auditoria.
- Log de auditoria em tabela DynamoDB: quem alterou, o quê, quando (nunca senhas/tokens).
- IAM de menor privilégio por rota; nada de `*`.
- Testes: rotas admin exigem token de admin; usuário comum recebe `403`; auditoria
  registrada.

Riscos: um painel que altera catálogo/limites precisa de validação server-side e
idempotência para não corromper compras em andamento.

## 4. Limite de gasto por usuário

Decisão (2026-11-17): o limite é **saldo disponível** por usuário, gravado em `Usuarios`
na criação, consumido a cada compra e ajustável por CLI (`user:set-limit` /
`user:reset-limit`). Implementação e detalhes em
`docs/REQUISITOS-PDF-E-AUDITORIA.md` §3.2 e `docs/TODO.md` §11.

Estado atual (anterior à decisão):

- `tools/realizar_compra/index.ts:128` lê `limite` do registro do usuário (ou
  `LIMITE_COMPRA`, default `500`) e rejeita a compra quando `valor > limite`
  (`:130`). É um limite **por compra**, não um teto acumulado.
- Não há contador de gasto por período nem reset; o painel admin precisaria alterar o
  registro do usuário.

Decisões pendentes:

- O limite deve ser por compra, diário, mensal ou acumulado total?
- Janela de reset (diária/mensal) e fuso horário.
- Moeda/arredondamento e se o limite considera impostos/frete.
- O `valor` usado na checagem vem da intenção registrada (fonte da verdade) e não da
  mensagem do usuário.

Se o requisito for gasto acumulado:

- Campos no registro do usuário (ex.: `gasto_atual`, `periodo_inicio`, `limite`).
- Atualização atômica com `ConditionExpression` no DynamoDB
  (`gasto_atual + valor <= limite`) para evitar duas compras concorrentes passarem.
- Idempotência por `intencao_id` para não debitar duas vezes em retry.
- Reset pelo painel admin e/ou job agendado no início do período.
- Exibir saldo/limite restante no chat e no painel.

## 5. Ordem sugerida

1. Prompt + contratos de tool + evals (ganho alto, baixo risco).
2. Verificação pós-resposta/grounding.
3. Limite por usuário definido e implementado no backend.
4. Painel admin (depende do modelo de limite e do catálogo).
