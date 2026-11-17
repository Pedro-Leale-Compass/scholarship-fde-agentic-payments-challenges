# agent/

Agente **Strands Agents (Python 3.12)** no **Amazon Bedrock AgentCore Runtime**, usando o **Claude Haiku** do Bedrock. Conversa com o usuário, chama as 3 tools e tem um teto de 8 iterações por turno.

```bash
python -m venv .venv && .venv/Scripts/pip install -r requirements-dev.txt   # Linux/macOS: .venv/bin/pip
.venv/Scripts/python -m pytest -q          # modelo e Lambdas falsos, credenciais falsas: não acessa a AWS
python empacotar.py ../infra/build/agent   # zip Linux ARM64; a última linha é o SHA-256
```

| Arquivo | Papel |
|---|---|
| [`main.py`](main.py) | Entrypoint do runtime (`BedrockAgentCoreApp`). Valida o payload e transmite os eventos. |
| [`agente/payload.py`](agente/payload.py) | Contrato de entrada e validação. Bytes ↔ `{"__bytes_b64": ...}`. |
| [`agente/execucao.py`](agente/execucao.py) | Monta o `Agent` com o histórico, roda o turno e traduz os eventos do Strands. |
| [`agente/ferramentas.py`](agente/ferramentas.py) | As 3 `@tool`. O `usuario_id` vem do `invocation_state`, nunca dos argumentos. |
| [`agente/lambdas.py`](agente/lambdas.py) | `lambda.invoke({ usuario_id, argumentos })`. Qualquer falha vira `FALHA_NA_FERRAMENTA`. |
| [`agente/prompt.py`](agente/prompt.py) | System prompt: papel do assistente, fluxo de compra e como explicar cada recusa. |
| [`empacotar.py`](empacotar.py) | Zip determinístico para o AgentCore (dependências de `requirements.lock`). |

## Contrato com a Lambda do chat

Entrada (`InvokeAgentRuntime`):

```json
{
  "usuario_id": "<sub do Cognito, tirado do JWT pela Lambda do chat>",
  "mensagens": [
    { "role": "user", "content": [{ "text": "o que tem à venda?" }] },
    { "role": "assistant", "content": [{ "toolUse": { "toolUseId": "t1", "name": "listar_catalogo", "input": {} } }] },
    { "role": "user", "content": [{ "toolResult": { "toolUseId": "t1", "status": "success", "content": [{ "text": "{...}" }] } }] },
    { "role": "assistant", "content": [{ "text": "Temos..." }] },
    { "role": "user", "content": [{ "text": "quero 2 fones" }] }
  ]
}
```

- O histórico vai completo, com `toolUse`/`toolResult`, porque o modelo precisa saber de onde vieram os ids. Nada é cortado (`NullConversationManager`).
- A última mensagem é a nova: do usuário e **só texto**, com até 4000 caracteres. Um `toolResult` forjado nela é recusado.
- Blocos aceitos no histórico: `text`, `toolUse`, `toolResult` e `reasoningContent`. O limite é de 400 mensagens.

Saída: stream SSE com uma linha `data: {...}` por evento.

| Evento | Quando |
|---|---|
| `{"tipo": "texto", "texto": "..."}` | Pedaço da resposta, para exibir em tempo real |
| `{"tipo": "ferramenta", "nome": "listar_catalogo"}` | Uma vez por chamada de tool, para a UI mostrar "consultando..." |
| `{"tipo": "fim", "mensagens_novas": [...]}` | Fim do turno. É o que a Lambda do chat grava no DynamoDB, na ordem: a mensagem do usuário, os `toolUse`/`toolResult` e a resposta. |
| `{"tipo": "erro", "mensagem": "..."}` | Payload inválido, modelo fora do ar, etc. Não há `fim`, então **nada é gravado** e o usuário pode tentar de novo. |

O `fim` sempre termina numa mensagem do assistente. Se o limite de 8 iterações for atingido depois de uma tool, o agente fecha o turno com um pedido para o usuário reformular, para o próximo turno não ser rejeitado pelo Bedrock.

## Segurança

- O `usuario_id` não é parâmetro de nenhuma tool. O schema enviado ao modelo não o contém (há teste para isso), e um `usuario_id` que o modelo coloque nos argumentos é descartado pelo Strands antes da Lambda.
- Se faltar o `usuario_id`, a tool não chama a Lambda.
- Um erro não tratado na Lambda (`FunctionError`), falha do serviço Lambda ou resposta fora do formato viram `FALHA_NA_FERRAMENTA` com mensagem amigável. O detalhe técnico vai só para o log.
- O payload não é logado, porque contém a conversa do usuário.

## Modelo

- **Inference profile:** `us.anthropic.claude-haiku-4-5-20251001-v1:0` (Claude Haiku 4.5). É o parâmetro `ModeloId` do template, e o modelo base `anthropic.claude-haiku-4-5-20251001-v1:0` é o `ModeloBaseId`. O código não depende do modelo: trocar é só mudar os parâmetros.
- **Amostragem:** sem `temperature`/`top_p`. O agente usa o padrão do modelo, que todos os Claude atuais aceitam (os mais novos recusam valores diferentes).
- **Raciocínio:** o modelo pode devolver blocos de raciocínio (`reasoningContent`). Eles voltam ao modelo como ele os produziu, inclusive o conteúdo em bytes, que viaja em base64.

## Empacotamento

O AgentCore Runtime com código (não contêiner) roda Linux ARM64. O `requirements.lock` foi resolvido para essa plataforma com hashes. Isso é necessário porque o pip avalia marcadores como `sys_platform` pelo sistema local, mesmo com `--platform`, e no Windows puxaria o `pywin32`. Para atualizar o lock:

```bash
uv pip compile requirements.txt --python-platform aarch64-manylinux2014 \
  --python-version 3.12 --generate-hashes --no-header -o requirements.lock
```

O zip sai byte a byte igual entre builds. O `deploy.sh` o publica em `s3://<bucket de artefatos>/agente/<sha256>.zip` e passa a chave para a stack, então o runtime só é atualizado quando algo muda.
