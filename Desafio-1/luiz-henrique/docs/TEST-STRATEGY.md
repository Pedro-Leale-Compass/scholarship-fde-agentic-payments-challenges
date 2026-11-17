# Estratégia de testes — agente e checkout

Verificado em **2026-11-17**. Baseline atual: `v0.0.4` (checkout corrigido + hardening de requisitos).

## 1. O que já foi validado

- O agente rodou em uso real e respondeu corretamente aos primeiros pedidos
  (catálogo, registro de intenção, cartão/Pix, limite).
- `npm run test:local` passa com Claude Haiku e fallback em memória.
- `npm run test:agent` passa **3/3** na stack implantada, incluindo:
  - compra com cartão;
  - compra com Pix;
  - limite excedido;
  - `intencao_id` inválido;
  - novo produto depois de intenção cancelada, sem reutilizar o ID.
- Runtime v15, `READY`, modelo `us.anthropic.claude-haiku-4-5-20251001-v1:0`.
- `GET /conversas` e `Conversas.mensagens_json` cobertos pelo teste de integração.
- `registrar_intencao` resolve `produto_id`/quantidade e `preco_centavos` no catálogo.
- WebSocket: parcial; `$connect` funciona, `$default` falha. Ver `WS-NEXT.md`.

Isso cobre o caminho feliz e a regressão principal. Ainda é uma amostra pequena.

## 2. Objetivo da próxima suíte

Criar uma suíte variada de **100+ casos** para descobrir onde o modelo quebra, com
asserções determinísticas no backend (não só no texto da resposta).

Cada caso deve registrar:

- resposta do agente;
- `purchase` (ok/código/status/valor);
- `registered_intencao_id` e `pending_intencao_id`;
- IDs citados na resposta;
- latência;
- tokens/custo aproximado;
- estado final em `Intencoes`/`Usuarios`/`Conversas`.

## 3. Dimensões a cobrir

### Conversa e catálogo

- saudação, escopo (“qual o preço?”, “você vende X?”), recusa fora do escopo;
- catálogo completo, produto único, preço, disponibilidade;
- erros de digitação: `catalogo`, `compprar`, `comrpar`, `cartao`, `pix`, `webcan`;
- sinônimos/apelidos: “monitor”, “tela”, “fone”, “headset”, “cadeira”;
- escolha por número do catálogo, por nome parcial e por nome completo;
- quantidade > 1 e múltiplos produtos (hoje o fluxo é de 1 produto; testar limite);
- troca de produto antes/depois do pagamento;
- pedido de cancelamento;
- conversa nova depois de compra paga/cancelada;
- duas abas na mesma conversa e duas conversas isoladas;
- histórico longo (20+ turnos);
- injeção de prompt (“ignore as regras”, “finja que pagou”).

### Registro de intenção

- produto conhecido → `registrar_intencao` chamado e ID novo;
- produto desconhecido → falha visível + oferta de catálogo (ver §6);
- typo no produto → fallback de registro ou oferta de catálogo;
- dois produtos na mesma frase → pedir esclarecimento, não registrar errado;
- modelo afirma “registrada” sem tool → guarda/fallback;
- modelo copia ID de exemplo → guarda, sem ID inventado;
- registro após intenção paga/cancelada/expirada → novo ID.

### Pagamento

- cartão ok, Pix ok;
- `METODO_INVALIDO`;
- `LIMITE_EXCEDIDO` (saldo insuficiente) e tentativa de novo produto;
- `INTENCAO_EXPIRADA` (forçar expiração);
- `INTENCAO_JA_PAGA` (repetir pagamento);
- `INTENCAO_CANCELADA` (pagar intenção cancelada);
- `INTENCAO_INVALIDA` (ID inexistente, de outro usuário, malformado);
- `INTENCAO_INDISPONIVEL` (mudança concorrente de status);
- usuário inexistente em `Usuarios`;
- duas chamadas simultâneas de pagamento (sem débito duplo);
- fallback de pagamento quando o modelo omite a tool;
- fallback não pode pagar ID antigo do histórico.

### Segurança e isolamento

- chamada sem token → `401` no API Gateway;
- token inválido/expirado;
- `usuario_id` no corpo é ignorado (sempre vem do `sub`);
- intenção de outro usuário → `INTENCAO_INVALIDA`;
- `conversa_id` de outra pessoa → não vaza histórico/estado;
- valores/preços inventados pelo modelo não são aceitos pelo backend;
- falhas de tool não viram stack trace.

## 4. Métricas e asserções

- **ID**: todo ID citado deve existir, pertencer ao usuário e ter sido retornado por uma
  tool nesta conversa.
- **Nenhum ID reutilizado** entre compras distintas.
- **Nenhuma compra duplicada**: saldo e status conferem após retries/concorrência.
- **Nenhum sucesso fabricado**: “aprovada/paga” só com `realizar_compra.ok === true`.
- **Falha visível**: código de erro chega ao usuário em linguagem compreensível.
- **Loop de recusa**: no máximo 1 recusa idêntica consecutiva; depois, oferecer catálogo
  ou pedir esclarecimento.
- **Custo/latência**: limitar chamadas Bedrock por caso; registrar p95.

## 5. Harness

- `npm run test:local`: agente local + fallback, rápido e barato (Haiku).
- `USE_REAL_TOOLS=1 npm run test:local`: agente local + Lambdas/DynamoDB reais.
- `npm run test:agent`: stack completa via API Gateway.
- Próximo passo: transformar `scripts/local-flow.mjs` em runner data-driven
  (`tests/cases/*.json`), com 100+ casos e relatório de falhas.

Controle de custo:

- rodar a maior parte no fallback local;
- usar usuários de teste com saldo controlado;
- não repetir o mesmo caso sem necessidade;
- manter o orçamento de US$ 20 em vista.

## 6. Caso registrado: loop de recusa e redirecionamento para o catálogo

**Caso:** `REFUSAL-LOOP-01`  
**Origem:** conversa real do usuário em 2026-11-17.  
**Objetivo futuro:** quando o produto não for identificado, o agente deve redirecionar para o
catálogo em vez de repetir a mesma recusa.

Transcrição resumida:

```
user: catalogo
assistant: <catálogo com 8 produtos, pergunta qual produto>

user: comprar headset
assistant: Intenção registrada: Headset com Microfone, R$ 249,90, pendente.
           ID: INT-53341CA7. Cartão ou pix?

user: cartao
assistant: O pagamento não foi concluído (LIMITE_EXCEDIDO): ... a intenção foi cancelada.

user: catalogo
assistant: <catálogo com 8 produtos, pergunta qual produto>

user: compprar webcam
assistant: Não registrei nenhuma intenção nesta mensagem (nenhum ID foi criado).
           Nenhuma cobrança foi feita. Pode repetir qual produto você quer comprar?

user: webcam
assistant: Não registrei nenhuma intenção nesta mensagem (nenhum ID foi criado).
           Nenhuma cobrança foi feita. Pode repetir qual produto você quer comprar?

user: webcam
assistant: Não registrei nenhuma intenção nesta mensagem (nenhum ID foi criado).
           Nenhuma cobrança foi feita. Pode repetir qual produto você quer comprar?
```

**Comportamento atual:** o fallback de registro só casa o nome completo do catálogo
(`Webcam Full HD`); “webcam” sozinho não casa. Sem produto reconhecido, a guarda repete a
mesma recusa.

**Comportamento desejado (mais gentil):**

1. Na primeira falha de identificação, responder algo como:
   “Não consegui identificar esse produto. Quer ver o catálogo para escolher?”
2. Se o usuário pedir catálogo, chamar `listar_catalogo` e apresentar as opções.
3. Se o usuário insistir em “webcam”, aceitar apelido/parcial (`webcam` → `Webcam Full HD`)
   ou pedir confirmação (“Você quer a Webcam Full HD?”).
4. Nunca repetir a mesma recusa duas vezes seguidas; sempre oferecer uma saída
   (catálogo, confirmação ou lista de produtos).

**Asserção futura:**

- no máximo uma recusa idêntica;
- a segunda tentativa sem produto reconhecido deve conter oferta de catálogo ou pergunta de
  confirmação;
- o agente não pode criar/afirmar um ID nesse fluxo.

## 7. Backlog da suíte

- [ ] Runner data-driven com 100+ casos.
- [ ] Caso `REFUSAL-LOOP-01` com apelido `webcam` e redirecionamento para catálogo.
- [ ] Casos de typo (`compprar`, `comrpar`, `cartao`, `pix`).
- [ ] Casos de dois produtos/quantidade.
- [ ] Casos de conversa nova/duas abas/duas conversas.
- [ ] Casos de concorrência no pagamento.
- [ ] Relatório de custo/latência por caso.


## 8. Plano e custo da suíte de 100+

**Não implementar agora.** Este é o orçamento para o próximo ciclo.

Premissas conservadoras:

- 100 casos × 3 turnos = 300 chamadas ao modelo.
- ~2.000 tokens de entrada e ~300 de saída por chamada (histórico cresce).
- Claude Haiku 4.5: ordem de US$ 1/MTok entrada e US$ 5/MTok saída (confirme a tabela
  vigente antes de rodar).
- 2–4 chamadas de tool por caso = 200–400 invocações Lambda/DynamoDB.

Estimativa:

| Item | Cálculo | Custo aproximado |
|---|---|---|
| Entrada Bedrock | 300 × 2.000 = 600k tokens | ~US$ 0,60 |
| Saída Bedrock | 300 × 300 = 90k tokens | ~US$ 0,45 |
| Lambda/DynamoDB/API | 200–400 chamadas | < US$ 0,20 |
| **Total por execução** | | **~US$ 1–1,50** |

Com reexecuções, retries e casos mais longos, reserve **US$ 3–5** para a suíte completa.
O orçamento atual é US$ 20 (≈US$ 5 gastos), então cabe, mas não rode a suíte inteira em
loop.

Estratégia de custo:

1. 20 casos no fallback local para estabilizar o runner.
2. 100 casos no fallback local; ajustar asserts/prompt.
3. 20 casos representativos na stack implantada (inclui `GET /conversas`, tools reais,
   WebSocket quando estiver pronto).
4. Só então rodar os 100+ na stack, em uma janela única.

O runner deve parar em falha de infraestrutura (credencial, 5xx, timeout) e continuar em
falha de comportamento (resposta errada), para não gastar tokens repetindo erro de ambiente.
