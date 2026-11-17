# Infraestrutura com AWS CDK

A infraestrutura é declarada em AWS CDK/TypeScript. `cdk synth` gera um template a partir do código CDK para revisão; não executa deploy. `cdk deploy` cria recursos AWS e pode gerar cobranças.

## O que o CDK define

- Stack separada de orçamento mensal de US$ 20, com alertas quando o custo real passar de 50% e 75% e quando a previsão passar de 90%. Alertas não interrompem recursos nem garantem teto de cobrança.
- Cognito User Pool sem auto cadastro, autenticação por e-mail e convites.
- Tabelas DynamoDB de pagamento e conversa com cobrança sob demanda e TTL das intenções.
- Lambdas para as três ferramentas, API do chat e validação de token Cognito.
- Acesso do agente limitado ao modelo informado e às Lambdas de ferramenta; API limitada à tabela de conversas e ao Runtime.
- AgentCore Runtime Python 3.12 usando o construct L2 de code asset, que prepara o pacote da pasta local no synth.
- API Gateway REST com authorizer TOKEN, rotas protegidas, CORS limitado a `http://localhost:3000` no modo padrão e integração de resposta STREAM.
- O deploy padrão é somente backend: não cria CloudFront nem bucket de frontend. A hospedagem S3/CloudFront pode ser habilitada depois com `-c deployFrontend=true`, quando a SCP da organização permitir OAC.

## Preparação local (sem conta AWS)

1. Instale Node.js e o `uv` (o Python local pode ser Windows; `uv` resolve e instala wheels para Python 3.12/Linux ARM64).
2. Execute `infra/scripts/prepare-local.ps1` para instalar as dependências travadas, exportar o frontend, preparar os assets TypeScript das Lambdas e empacotar o agente para Linux ARM64. A compilação/empacotamento das Lambdas é feita localmente sem empacotador nativo externo.
3. Entre em `infra/`, execute `npm ci` e `npm run build`. Para revisar primeiro o orçamento isolado, rode `npx cdk --app "npx ts-node --prefer-ts-exts bin/budget-only.ts" synth`. A síntese do backend usa `npx cdk synth`; não precisa de `frontend/out` quando `deployFrontend` está desligado.

As pastas `tools/build/lambda` e `api/build/lambda` são assets locais das Lambdas. A pasta `agent/build/site` recebe dependências compatíveis com Linux ARM64, não bibliotecas compiladas para Windows. O CDK empacota esses diretórios ao sintetizar. O frontend local lê `NEXT_PUBLIC_PAYMENTS_API_URL`, `NEXT_PUBLIC_COGNITO_USER_POOL_ID` e `NEXT_PUBLIC_COGNITO_USER_POOL_CLIENT_ID` de `frontend/.env.local`.

## Etapa que exige conta AWS

A implantação precisa de conta e credenciais AWS, CDK bootstrap na região `us-east-1` e acesso ao modelo Bedrock. O ID configurado é `us.anthropic.claude-haiku-4-5-20251001-v1:0`, conforme o acesso informado pelo coordenador. Esse perfil geográfico pode rotear inferência entre `us-east-1`, `us-east-2` e `us-west-2`; a role do agente recebeu acesso apenas a esse perfil e a esse modelo nessas regiões. A stack principal depende da stack `ViniciusPaymentsBudget`; ao implantar as stacks juntas, CDK cria o orçamento primeiro. Informe o e-mail do alerta e confirme a notificação antes de seguir usando a aplicação. O alerta avisa sobre custos, mas não bloqueia gastos automaticamente.

A stack principal usa `RemovalPolicy.DESTROY` para recursos do desafio e o bucket apaga seu conteúdo durante a remoção. Revise limpeza e retenção antes de uma futura implantação. Após deploy e criação do usuário, use `scripts/provision-user.ps1` para cadastrar o perfil/limite por Cognito `sub`; essa etapa exige AWS CLI autenticada e envia o convite por e-mail.
