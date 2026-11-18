# Destroy e limpeza de recursos

Verificado em **2026-11-17** contra `package.json` e `scripts/destroy-cleanup.sh`.

## 1. Comando

```bash
cd Desafio-1/luiz-henrique
eval "$(scripts/aws-creds.sh)"
npm run destroy
```

O `npm run destroy` executa:

1. `cdk destroy --force` na stack `Desafio1Stack`;
2. `scripts/destroy-cleanup.sh` para remover órfãos conhecidos.

## 2. O que o cleanup remove

O script usa o prefixo `luiz-henrique`/`Desafio1Stack` para localizar e remover:

- log groups do CloudWatch criados por Lambdas/runtime;
- roles IAM do projeto (com detach/delete de policies inline e gerenciadas);
- recursos e REST APIs do API Gateway do projeto;
- versões `$LATEST` de Lambda que o CloudFormation não apaga diretamente;
- outros recursos órfãos listados no próprio script.

Recursos de outros fellows não devem ser tocados. Se o script for alterado, revise os
filtros por prefixo antes de rodar.

## 3. Verificação após o destroy

```bash
aws resource-explorer-2 list-resources \
  --profile desafio-1 \
  --region us-east-1 \
  --view-arn arn:aws:resource-explorer-2:us-east-1:<account-id>:view/us-east-1/<view-id> \
  --no-paginate --output json
```

Confira no console/CLI que não restou:

- runtime do AgentCore (`bedrock-agentcore-control list-agent-runtimes`);
- repositório/imagens no ECR;
- tabelas DynamoDB `luiz-henrique-*`;
- log groups `/aws/bedrock-agentcore/*` e `/aws/lambda/luiz-henrique-*`;
- roles IAM `luiz-henrique-*`;
- REST API `luiz-henrique-api`.

O Resource Explorer pode ficar defasado por minutos; confirme também pelo serviço
específico.

## 4. Histórico

Os relatórios de ciclos anteriores (`resources-*.json`, `orphans-*.md`) estão em `logs/`,
que é gitignorado. Não são documentação canônica; use-os apenas como evidência
operacional. O `docs/archive/` contém a análise antiga de destroy, se precisar de contexto.
