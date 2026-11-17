# Validação inicial do ambiente AWS

Registro atualizado em 14/11/2026, com base nas saídas de terminal e capturas enviadas por Paulo nesta conversa. Estes testes foram executados pelo usuário. Não constituem teste de deploy ou validação das roles da aplicação.

## Resultado

| Verificação | Evidência observada | Estado |
|---|---|---|
| Perfil CLI | `aws configure list-profiles` retornou `desafio-1` | Confirmado |
| Login SSO | `aws sso login --profile desafio-1` concluiu com sucesso | Confirmado na sessão testada |
| Identidade | STS retornou uma identidade federada `AWSReservedSSO_AlunoAdmin` | Confirmado; identificadores da conta omitidos deste documento |
| Região padrão | `aws configure get region --profile desafio-1` retornou `us-east-1` | Confirmado |
| Listagem S3 | `aws s3 ls --profile desafio-1` terminou sem erro e sem buckets listados | Confirmado; não testa criação de recursos |
| Orçamento | Orçamento mensal existente de US$ 20 | Confirmado no console |
| Alertas | Custo real acima de 80% (US$ 16) e acima de 100% (US$ 20) | Confirmado no console |
| E-mail | Endereço institucional do aluno marcado como verificado | Confirmado; endereço da coordenação ainda pendente na captura |
| Ações automáticas | Nenhuma ação configurada nas telas apresentadas | Não contar com interrupção automática dos gastos |
| Bedrock | Comando `converse` retornou `pong` com Claude Haiku 4.5 | Invocação confirmada |

O custo exibido na captura era US$ 0,43. É uma observação histórica, não o custo atual nem uma previsão do projeto.

## Modelo confirmado

Pedro informou aos participantes que havia liberado Claude Haiku 4.5 e que a primeira chamada poderia iniciar a inscrição, com a seguinte funcionando. O teste do aluno já retornou a resposta esperada.

```text
Região de entrada: us-east-1
Perfil CLI: desafio-1
Identificador utilizado: us.anthropic.claude-haiku-4-5-20251001-v1:0
Mensagem: Reply with exactly: pong
Resposta: pong
```

Não foi necessário concluir o formulário de caso de uso apresentado pelo playground para obter esse resultado pelo CLI. Não concluir, com isso, que todas as contas ou todos os fluxos do console estão liberados.

O identificador `us.` é um perfil de inferência geográfico: a requisição entra em `us-east-1`, mas o Bedrock pode encaminhar o processamento a outras regiões dos EUA. Usar o identificador recomendado pelo Pedro; não afirmar que a execução do modelo fica exclusivamente em `us-east-1`. Os recursos do projeto continuarão provisionados na região exigida. A role do agente precisará das permissões compatíveis com esse perfil e seus modelos de destino.

Referência: [Inferência entre regiões no Bedrock](https://docs.aws.amazon.com/bedrock/latest/userguide/cross-region-inference.html).

## Como repetir o teste no PowerShell

Executar cada bloco separadamente. O teste Bedrock consome tokens; repetir somente quando necessário.

```powershell
aws sso login --profile desafio-1
```

```powershell
aws sts get-caller-identity --profile desafio-1
```

```powershell
Set-Content -Path "$env:TEMP\bedrock-teste.json" -Value '[{"role":"user","content":[{"text":"Reply with exactly: pong"}]}]' -Encoding ascii
```

```powershell
aws bedrock-runtime converse --profile desafio-1 --region us-east-1 --model-id us.anthropic.claude-haiku-4-5-20251001-v1:0 --messages "file://$env:TEMP/bedrock-teste.json" --query "output.message.content[0].text" --output text
```

Se o SSO expirar, refazer o login. Não criar chaves permanentes como alternativa. Não publicar tokens, códigos de autorização ou arquivos de credenciais.

## Ainda não validado

- Criação de infraestrutura por CloudFormation/CDK e permissões de bootstrap.
- Criação/passagem de roles IAM com menor privilégio.
- Publicação S3/CloudFront, Cognito e API Gateway da aplicação.
- Implantação e invocação de um runtime AgentCore.
- Permissões do modelo usando a role do agente, em vez do perfil do aluno.
- Invocação de ferramentas pelo agente e acesso ao DynamoDB.
- Streaming, rejeição de tokens pela API e compras concorrentes.

O acesso inicial está validado; o ambiente completo da aplicação ainda não está implantado.
