# Modelo, tool calling e alinhamento com Claude Haiku 4.5

Pesquisa feita em 2026-11-17 (AWS Docs, Anthropic Docs e código do SDK instalado).

## 1. Modelo

- ID usado: `us.anthropic.claude-haiku-4-5-20251001-v1:0`.
- `us.` = perfil de inferência cross-region **só nos EUA** (us-east-1, us-east-2,
  us-west-2). O perfil `global.` também existe e está ACTIVE, mas inclui um ARN global de
  foundation model que pode servir fora dos EUA; por isso usamos `us.`, alinhado à exigência
  de `us-east-1` e à residência de dados.
- Região: `us-east-1`.
- Haiku 4.5 suporta tool use, parallel tool use e strict tool use.

## 2. Formato no Bedrock (Converse / ConverseStream)

O Strands `BedrockModel` monta o request no formato Converse:

```json
{
  "modelId": "us.anthropic.claude-haiku-4-5-20251001-v1:0",
  "system": [{ "text": "..." }],
  "messages": [{ "role": "user", "content": [{ "text": "..." }] }],
  "inferenceConfig": { "temperature": 0 },
  "toolConfig": {
    "tools": [
      {
        "toolSpec": {
          "name": "realizar_compra",
          "description": "...",
          "inputSchema": { "json": { "type": "object", "properties": {}, "required": [] } }
        }
      }
    ],
    "toolChoice": { "auto": {} }
  }
}
```

- `toolChoice` aceita `{ "auto": {} }`, `{ "any": {} }` ou `{ "tool": { "name": "..." } }`.
- Em streaming, a resposta traz `contentBlockStart` com `toolUse`, deltas com o JSON parcial
  e `contentBlockStop`; o Strands monta a chamada e devolve o `toolResult`.
- Sem `toolConfig`, a resposta é só texto. Com `toolConfig`, o modelo pode responder texto
  **ou** `toolUse` (default `auto`).

## 3. O que o código já fazia certo

- `ZodTool` gera `toolSpec` válido (nome, descrição, `inputSchema.json`).
- `BedrockModel` envia `toolConfig` automaticamente quando há tools.
- O runtime recebe `toolUse`, executa a Lambda e devolve `toolResult`; o loop continua até
  o texto final.
- `temperature` e `maxTokens` são campos válidos do `BedrockModelConfig`.

## 4. O que estava faltando (e foi corrigido)

| Ponto | Antes | Agora |
|---|---|---|
| Temperatura | default do modelo | `temperature: 0` (menos variação/alucinação) |
| Descrições das tools | genéricas | dizem quando usar e o que retornam |
| Confirmação de compra | modelo podia dizer "aprovada" sem chamar a tool | guard determinístico: só aceita "aprovada" se `realizar_compra` retornou `ok: true` na mesma invocação |
| Pagamento sem tool call | compra ficava pendente | fallback determinístico: se o usuário confirma pagamento e o modelo não chama a tool, o runtime chama `realizar_compra` com o último `intencao_id` |
| Registro da intenção | modelo às vezes pedia confirmação antes | prompt manda registrar imediatamente |
| Paralelismo | ferramentas podiam ser chamadas em paralelo | prompt pede uma por vez; as tools têm efeito colateral |
| Erros | texto solto | tools retornam `{ ok: false, code }` e o prompt manda reportar o `code` |

## 5. `toolChoice` forçado: por que não usamos

- `{ tool: { name: 'realizar_compra' } }` força a tool em **cada** chamada do loop; depois
  do `toolResult`, o modelo seria forçado a chamar a mesma tool de novo, podendo entrar em
  loop.
- `{ any: {} }` força *alguma* tool, com o mesmo risco.
- Por isso usamos `auto` + prompt explícito + guard + fallback determinístico. O fallback
  cobre exatamente o caso em que o modelo não chama a tool no turno de pagamento.

## 6. Tokens de system prompt para tool use (Haiku 4.5)

- `auto`/`none`: 496 tokens.
- `any`/`tool`: 588 tokens.

Não é um problema de orçamento aqui, mas explica por que o prompt não deve crescer
indefinidamente.

## 7. Validação

`tests/agent.test.mjs` (`npm run test:agent`) cobre:

- 401 sem token.
- Contrato de `realizar_compra`: compra ok, retry (`INTENCAO_JA_PAGA`), saldo
  (`LIMITE_EXCEDIDO`), id inválido (`INTENCAO_INVALIDA`), dono errado, expirada
  (`INTENCAO_EXPIRADA`), método inválido (`METODO_INVALIDO`).
- Fluxo do agente: intenção pendente não pode ser narrada como compra paga; pagamento
  confirmado baixa o saldo; compra acima do limite não é narrada como aprovada.

As asserções usam o estado real do DynamoDB, não só o texto do modelo.

## 8. Referências

- AWS Bedrock Converse API: `conversation-inference.html` e `tool-use.md`.
- Anthropic: "Tool use with Claude" (overview, define tools, handle tool calls).
- SDK local: `@strands-agents/sdk` (`models/bedrock.js`, `tools/types.d.ts`,
  `agent/agent.d.ts`).
## 9. Turnos fabricados (fala do usuário inventada)

Sintoma: a resposta do assistente contém `user: ...` e continua a conversa como se o
usuário tivesse dito algo.

- **Não é específico do Haiku 4.5.** É um modo de falha conhecido do Claude quando o
  histórico chega como texto achatado (`user: ...\nassistant: ...`) em vez de mensagens
  com role: o modelo trata o texto como um transcript e o continua. Há relatos em
  `anthropics/claude-code` issues #94218 e #70315.
- **Causa no nosso caso:** a Lambda montava `prompt` com `role: texto` e o runtime
  ignorava o array `messages` que já era enviado.
- **Mitigações aplicadas:**
  1. O runtime agora usa `messages` estruturados (`MessageData[]`) no `agent.stream`,
     preservando `user`/`assistant`. O `prompt` achatado virou fallback.
  2. Regra no system prompt: responder só à última mensagem e nunca escrever
     `user:`/`assistant:`/`human:`/`ai:`/`system:`.
  3. Sanitizer determinístico `stripFabricatedTurns`: corta a resposta no primeiro turno
     falso; se a resposta inteira for um transcript, devolve uma mensagem neutra.
  4. Teste: `tests/agent.test.mjs` falha se qualquer resposta contiver linha de turno.
- Se o chat atual já tiver uma resposta corrompida no histórico, limpe a conversa
  (estado/localStorage) antes de continuar; o histórico corrompido re-alimenta o modelo.

## 10. IDs inventados e intenções não canceladas

Dois problemas adicionais observados em conversas longas:

1. **ID inventado**: o modelo registrava uma intenção real (ex.: `b5624514-...`) mas
   escrevia outro UUID na resposta, ou usava placeholders como `intencao_1`.
2. **Intenção falha continuava `pendente`**: após `LIMITE_EXCEDIDO`, a intenção ficava
   disponível para reuso e o modelo se confundia.

Mitigações:

- `groundIntencaoIds` (runtime): qualquer UUID da resposta diferente do último
  `intencao_id` real vira o ID real; placeholders `intencao_1`/`intencao-2` também.
- Validação na borda da tool `realizar_compra`: se o ID não é UUID e existe um ID registrado
  na invocação, usa o real; se ainda assim não houver UUID, recusa com
  `INTENCAO_INVALIDA` sem chamar a Lambda.
- `realizar_compra` agora **cancela** a intenção em `LIMITE_EXCEDIDO` e
  `INTENCAO_EXPIRADA` (`status=cancelada`, `motivo_falha`, `cancelada_em`), e devolve
  `status: "cancelada"` no erro.
- Prompt: nunca inventar ID; copiar o UUID retornado; não reutilizar intenções canceladas,
  expiradas ou pagas.
- Histórico limitado a 12 mensagens no API Gateway (conversas longas degradam a aderência).
- Testes: a suíte falha se a resposta contiver um UUID inexistente no DynamoDB e verifica
  que a intenção acima do limite virou `cancelada`.

## 11. Prompt enxuto, IDs curtos e contexto persistido

Pesquisa (Anthropic Docs, Claude Code docs, "Writing effective tools for agents"):

- Tool descriptions detalhadas (3–4 frases) são o fator mais importante; o system prompt
  não deve repetir o que já está na descrição da tool.
- UUIDs são ruins para o modelo copiar; IDs semânticos/curtos reduzem alucinação.
- Prompts de agente devem ter poucas seções claras (identidade, escopo, ferramentas,
  fluxo, regras, exemplo) e evitar listas longas de proibições.
- Conversas longas degradam a aderência; limitar histórico e persistir o estado real
  (não depender da memória do modelo).

Aplicado:

1. **Prompt** reduzido para ~30 linhas em 6 seções (Escopo, Ferramentas, Fluxo, Regras,
   Exemplo), sem as 11 regras anteriores.
2. **IDs curtos**: `registrar_intencao` gera `INT-XXXXXXXX` (8 hex) em vez de UUID. O
   formato UUID antigo continua aceito.
3. **Contexto persistido**: o último `intencao_id` fica em `Usuarios.ultima_intencao_id`.
   O próximo turno recebe esse ID no payload; se o modelo não chamar a tool, o fallback
   usa o ID persistido. Isso corrige a segunda compra após uma compra confirmada.
4. **Histórico**: últimas 12 mensagens; mensagens do guard "A compra ainda não foi
   finalizada" são removidas do histórico para não virarem few-shot de erro.
5. **Grounding**: UUIDs/`INT-...` divergentes e placeholders (`intencao_1`) são trocados
   pelo ID real na resposta.
