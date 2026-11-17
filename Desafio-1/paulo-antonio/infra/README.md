# Infraestrutura do agente de pagamentos

## Orientação atual do Pedro em 16/11/2026

Publicar somente o backend e a autenticação na AWS; executar o frontend apenas localmente
e entregar um README descritivo de como rodar. Cognito e proteção dos endpoints continuam
obrigatórios. CloudFront não é requisito desta entrega. O modo completo citado abaixo é
uma alternativa legada, não uma pendência de publicação.

Na pasta `infra`, após renovar SSO e conferir a conta:

```powershell
pnpm run deploy --account CONTA_DE_12_DIGITOS --profile desafio-1 --prefix paulo-antonio --mode backend
```

Esse modo publica Cognito, API REST, Lambdas de sessão/ferramentas/chat/histórico, AgentCore Runtime e quatro tabelas DynamoDB. Não cria bucket do frontend, distribuição ou OAC, nem executa upload/invalidação. O bucket privado de artefatos armazena os pacotes de código. O build da interface é feito apenas localmente. CORS fica restrito a `http://127.0.0.1:4173`; usar exatamente esse endereço, não `localhost` ou outra porta.

Se a tentativa anterior terminou em `ROLLBACK_COMPLETE`, confirmar que todos os recursos foram removidos e excluir apenas o registro dessa stack antes de repetir o deploy. Não remover stacks em uso nem o bucket de artefatos.

Depois, na pasta `frontend`:

```powershell
node scripts/preview-local.mjs --aws
```

O servidor lê `.deploy/config.json` real, gerado pelo deploy. Permite conexões apenas à API configurada e ao Cognito regional. Sem `--aws`, continua sendo uma prévia offline com configuração fictícia. O usuário deve ser criado por convite no Cognito; nunca usar as credenciais fictícias do teste de ferramentas como login real.

Na pasta `infra`, verificar o backend com `node scripts/smoke.mjs --backend`. Esse teste
não substitui o login real nem o teste com token expirado. Use `--mode backend` para a
entrega atual; não é necessário usar `--mode full`.

`POST /chat` usa Lambda response streaming por API Gateway; as demais rotas respondem JSON comum. `GET /conversas` recupera o histórico do titular. O runtime usa ZIP Node.js 22 com Haiku 4.5, sem Docker/ECR. Veja `agent/README.md` e `docs/API-PAGAMENTOS.md` na raiz.

## Recursos preparados

O deploy também publica a stack independente `<prefixo>-pagamentos-dados` com quatro tabelas DynamoDB sob demanda: usuários, intenções, transações e conversas. Consulte `docs/DYNAMODB.md` e `agent/README.md` na raiz. A Lambda de sessão continua sem acesso às tabelas; ferramentas acessam somente pagamentos; chat e histórico acessam somente conversas. Ao encerrar o projeto, excluir essa stack separadamente somente após salvar evidências: suas tabelas e registros serão apagados.

- Um bucket privado, com criptografia, bloqueio de acesso público e exigência de HTTPS.
- Uma distribuição CloudFront e um OAC, sem domínio personalizado.
- Um user pool Cognito sem auto cadastro e um app client sem segredo.
- Uma API Gateway REST regional, com autorizador Cognito e validação de audience do ID token.
- Lambdas de sessão, ferramentas, chat e histórico, com roles separadas; a de sessão só escreve logs próprios.
- AgentCore Runtime HTTP com ZIP Node.js 22 e perfil Haiku 4.5, sem DynamoDB direto.
- Grupos de logs por função/runtime, com retenção de uma semana; o grupo do runtime é criado pelo serviço.
- Uma stack auxiliar `<prefixo>-assets` com bucket privado para código e templates de implantação; sem novas roles IAM.

As stacks regionais ficam em `us-east-1`. O perfil de inferência `us.` do Haiku pode
processar chamadas em `us-east-1`, `us-east-2` e `us-west-2`, previstas no IAM.
CloudFront é global. Tags iniciais: `Project=agente-pagamentos-aws` e `Owner=<prefixo>`;
conferir se a coordenação exige tags adicionais.

O bucket é privado; apenas a interface publicada pelo CloudFront é pública. A interface exige login, e a API rejeita chamadas sem token válido antes de invocar a Lambda. `OPTIONS` permite o preflight de CORS sem login, pois não retorna dados do usuário.

## Pré-requisitos

- Node.js 22 LTS ou posterior compatível com as dependências.
- pnpm 11.25.0 (versão utilizada na validação local).
- AWS CLI v2 e perfil SSO `desafio-1` autenticado.
- Conta esperada conferida com a coordenação e alerta de orçamento verificado.
- Permissões SSO para criar os recursos descritos nesta página. O deploy usa `CliCredentialsStackSynthesizer` e cria um bucket privado próprio de artefatos pela stack `<prefixo>-assets`, definida em `deployment-assets.json`. Não requer bootstrap padrão, novas roles de implantação ou `AdministratorAccess`. Se houver `AccessDenied`, não ampliar permissões por tentativa: encaminhar a falha à coordenação.

Os comandos seguintes partem da pasta `infra/`. Não executar instalações na raiz da base antiga.

```powershell
pnpm install --frozen-lockfile --store-dir ../.pnpm-store
```

Para validação local:

Instalar também as dependências de `tools` e `agent` (`pnpm install --frozen-lockfile --store-dir ../.pnpm-store` em cada pasta) antes do build/teste da infraestrutura, pois o build empacota as Lambdas e o runtime com esbuild. O script de deploy faz essas instalações automaticamente.

```powershell
pnpm run test
```

```powershell
pnpm run synth
```

O synth gera o template local, sem criar recursos. Os testes de template usam uma conta fictícia e não precisam de credenciais AWS.

Para compilar o frontend, executar na pasta `frontend/`:

```powershell
pnpm install --frozen-lockfile --store-dir ../.pnpm-store
pnpm run build
```

## Deploy: somente após revisão do ambiente

Substituir `CONTA_DE_12_DIGITOS` pelo número conferido da conta. Não copiar esse marcador literalmente. A exigência explícita da conta evita deploy acidental em outra conta.

```powershell
pnpm run deploy --account CONTA_DE_12_DIGITOS --profile desafio-1 --prefix paulo-antonio --mode backend
```

O comando:

1. Confere conta e identidade SSO via STS. Se não corresponderem, termina antes de criar recursos.
2. Instala as dependências travadas de frontend, ferramentas e agente, faz o build estático e compila infraestrutura/Lambdas/runtime.
3. Prepara o bucket privado de artefatos via CloudFormation e publica primeiro a stack de dados e depois a aplicação com as credenciais SSO atuais. Ampliações de permissões da aplicação são apresentadas pelo CDK para revisão. Aplica retenção aos logs criados automaticamente pelo AgentCore.
4. Gera `.deploy/config.json` com URL da API, região, user pool e app client, obtidos dos outputs da stack.
5. No modo backend, encerra e orienta executar o frontend local. No modo completo, publica arquivos/configuração no bucket específico do projeto.
6. Somente no modo completo, solicita e aguarda a invalidação do cache CloudFront.

Configuração e HTML não são armazenados em cache pelo CloudFront; `_next/static/*` usa cache para os arquivos versionados. O script não remove objetos antigos durante atualizações. O conteúdo integral do bucket deve ser removido no encerramento do projeto.

O build do frontend não embute credenciais nem depende de conta AWS. Identificadores públicos necessários ao login são gerados no deploy. `.deploy/` não é versionado. Se o upload falhar após criar a stack, corrigir o erro e repetir o comando; não assumir que a stack foi desfeita automaticamente.

## Criar usuário de teste

Na saída do deploy, localizar o user pool. No Cognito, criar um usuário por convite com um e-mail ao qual o aluno tenha acesso e marcar o endereço como verificado apenas quando sua titularidade estiver confirmada. Não habilitar cadastro público.

Abrir a interface local no modo backend (ou a URL CloudFront no modo completo), entrar com a senha temporária recebida e concluir a troca. A interface deve exibir “Acesso confirmado” somente após a API confirmar a mesma identidade do token.

O uso de ID token nesta etapa é intencional: o autorizador Cognito valida o pool e a audience do app client. O identificador vem de `requestContext.authorizer.claims.sub`; campos de usuário enviados no corpo não são usados.

Tokens ficam no armazenamento da sessão da aba pelo Amplify. Sair limpa a sessão local; um JWT já emitido não é necessariamente revogado imediatamente no autorizador. Sua validade foi limitada a 15 minutos. Não prometer revogação instantânea de tokens copiados.

## Validar a implantação

Depois do deploy, na pasta `infra/`:

```powershell
pnpm run smoke --backend
```

No modo backend, esse teste verifica as oito rotas com token ausente/inválido e CORS.
Sem `--backend`, também verifica interface, configuração e bloqueio de acesso público
direto ao S3, depois de uma implantação completa. Não faz chamadas ao Bedrock.

Roteiro manual de conferência (resultados já obtidos e pendências em `docs/EVIDENCIAS-E-ENTREGA.md`):

- Convite e primeiro login com troca de senha.
- Ausência da opção de cadastro.
- Resposta de sessão para usuário autenticado.
- Token expirado rejeitado pelo gateway.
- Ausência de invocações da Lambda nas chamadas rejeitadas pelo gateway, por logs/métricas.
- Logout, novo login, acesso pelo celular e carregamento após atualização da página.

Não salvar tokens em prints, relatórios ou repositório. Os testes locais do handler verificam a defesa adicional da função; somente o teste na AWS comprova a rejeição antes da função.

## Remoção após o período combinado

A remoção apaga usuários do pool, logs e os demais recursos desta etapa. Antes de executá-la, salvar as evidências e conferir conta, prefixo e outputs.

1. Conferir a conta com `aws sts get-caller-identity --profile desafio-1`.
2. Identificar o bucket exato em `.deploy/outputs.json` e confirmar que pertence à stack do projeto.
3. Esvaziar somente esse bucket pelo console ou CLI. O CDK não foi configurado para esvaziar buckets automaticamente.
4. Na pasta `infra/`, executar o comando abaixo e revisar a confirmação:

```powershell
pnpm exec cdk destroy paulo-antonio-pagamentos --profile desafio-1 --context prefix=paulo-antonio
```

Se usou outro prefixo no deploy, usar o mesmo na remoção. CloudFront pode levar alguns minutos para desativar e excluir. Conferir que bucket, distribuição, OAC, pool, API, Lambda, role e logs do projeto foram removidos. Após excluir a stack da aplicação, esvaziar o bucket de artefatos identificado nos outputs da stack `<prefixo>-assets` e excluir essa stack pelo CloudFormation. Ela pertence somente ao projeto. Não apagar recursos compartilhados da conta.

O runtime usa deploy direto de código ZIP, sem ECR. O grupo de logs criado automaticamente
pelo AgentCore tem retenção de sete dias aplicada pelo script de deploy; ele não pertence
à stack e deve ser excluído explicitamente na limpeza final, após salvar as evidências.
Conferir também grupos de logs de runtimes revertidos durante implantação, sempre pelo
prefixo exato do projeto. A stack de dados deve ser removida separadamente após salvar evidências.

## Referências

- [REST API versus HTTP API](https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-vs-rest.html).
- [Cognito com API Gateway REST](https://docs.aws.amazon.com/apigateway/latest/developerguide/apigateway-integrate-with-cognito.html).
- [Cognito authorizer e validação de audience](https://docs.aws.amazon.com/apigateway/latest/developerguide/apigateway-enable-cognito-user-pool.html).
- [CDK: S3 privado com OAC](https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_cloudfront_origins.S3BucketOrigin.html).
- [Authenticator: ocultar cadastro](https://ui.docs.amplify.aws/react/connected-components/authenticator/configuration).
- [CDK usando as credenciais atuais do CLI](https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.CliCredentialsStackSynthesizer.html).
