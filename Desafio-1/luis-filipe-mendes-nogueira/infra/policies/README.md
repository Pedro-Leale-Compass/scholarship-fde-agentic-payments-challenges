# Política de execução do CloudFormation

`cloudformation-execution.json` é a política local proposta para a role de
execução do bootstrap CDK. Editar esse arquivo não atualiza a política IAM
publicada na conta. O deploy da aplicação também não publica esse arquivo.

## AgentCore Runtime

A única permissão com `Resource: "*"` é
`bedrock-agentcore:CreateAgentRuntime`. A tabela IAM da AWS não oferece
restrição por ARN para essa ação. A criação exige a região `us-east-1`
e a tag `Projeto=luis-filipe-mendes-nogueira`. Essa condição não restringe
o nome nem a quantidade de runtimes criados com essa tag. A exceção foi
explicitamente autorizada para este projeto.

Na criação, o AgentCore também verifica a ação dependente
`CreateAgentRuntimeEndpoint` contra o ARN regional `runtime/*`, antes de
atribuir um ID ao runtime. O CloudTrail confirmou esse recurso em
`responseElements.message` na falha de 2026-11-16T02:05:50Z. A tentativa de
2026-11-16T02:24:49Z confirmou a mesma exigência para `TagResource`.
A declaração `DependenciasDaCriacaoDoRuntime` cobre essas duas verificações
com as mesmas condições de região e tag de criação. Simular somente um ARN
com o nome do agente não reproduz essa autorização inicial. Não concedemos
leitura, atualização ou exclusão sobre o ARN regional `runtime/*`.

As ações de leitura, atualização, exclusão e tags são limitadas ao ARN
`runtime/luis_filipe_mendes_nogueira_agent-*`, inclusive o endpoint `DEFAULT`
gerenciado pelo serviço. Não há permissão de invocação do agente nessa política.
`iam:PassRole` para o AgentCore permite somente a role exata do agente e
somente o serviço `bedrock-agentcore.amazonaws.com`.

O schema regional `AWS::BedrockAgentCore::Runtime` exige também a criação
e exclusão da workload identity. Essas ações ficam limitadas ao diretório
`default` da conta/região e às identidades com o prefixo do agente.
O diretório é compartilhado: não concedemos exclusão do diretório.
A criação também aplica tags à identidade interna: o CloudTrail confirmou
essa exigência em 2026-11-16T02:29:55Z. `EtiquetarIdentidadeDoRuntime`
autoriza `TagResource` somente nas identidades com o prefixo do agente.
A tentativa de 2026-11-16T02:35:28Z mostrou que o serviço também autoriza
essa operação contra o ARN do diretório `default`. `TagsDiretorioNaCriacao`
cobre somente esse ARN e exige a tag de solicitação do projeto. Não executamos
uma operação de tags diretamente no diretório nem concedemos sua exclusão.
Os identificadores informativos `Sid` das declarações anteriores foram
encurtados para respeitar o limite de 6.144 caracteres da política gerenciada;
suas ações, recursos e condições foram preservados.

No primeiro uso, a AWS pode criar a service-linked role
`AWSServiceRoleForBedrockAgentCoreRuntimeIdentity`. A permissão cobre somente
esse ARN e exige `iam:AWSServiceName=runtime-identity.bedrock-agentcore.amazonaws.com`.
Essa role é gerenciada pela AWS, pode ser compartilhada com outros projetos e
não deve ser excluída como parte da limpeza deste desafio. Não concedemos
permissão para editá-la ou excluí-la.

Não incluímos as permissões opcionais de VPC, VPC Lattice, KMS ou capacidade
dedicada listadas no schema, porque o runtime usa rede pública e ZIP no bucket
existente do bootstrap. O runtime usa IAM na entrada; a identidade do usuário
virá do backend que valida Cognito. O browser não deve receber credenciais IAM.

A role de execução do agente é separada: ela acessa apenas as três Lambdas,
o perfil Haiku e seus modelos de destino, o objeto ZIP e seus logs. Não recebe
essa exceção global nem permissões diretas no DynamoDB.

## Exceção anterior do API Gateway

`apigateway:TagResource` foi mantida: o provider regional de
`AWS::ApiGatewayV2::Stage` a declarou e a criação já dependeu dela, embora o
IAM Access Analyzer a sinalize como `INVALID_ACTION`. Não ampliar para
`apigateway:*` e não remover sem validar novamente o provider.

## Preparação e publicação

`bash infra/deploy.sh luisfilipe` carrega Node 24 quando necessário, ativa
`infra/.venv`, reconstrói o ZIP ARM64, publica os assets e a stack pelo CDK e
executa a carga condicional do catálogo. Esse comando altera a AWS e pode
gerar cobrança por uso/armazenamento. Não é um comando de validação local.
O ZIP contém apenas `runtime.py`, `agente.py`, `ferramentas.py`, `prompt.py`
e dependências. Cada novo ZIP muda a chave do asset, permitindo atualizar
o código pelo CloudFormation. As versões transitivas resolvidas ficam em
`agent/dist/dependencias.json`; ainda não existe lockfile de todas as dependências.

Os testes e a síntese local não publicam recursos. A validação real da role e
do runtime exige uma implantação posterior e permanece pendente até ela ocorrer.

Fontes:

- https://docs.aws.amazon.com/service-authorization/latest/reference/list_bedrock-agentcore.html
- https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-oauth.html
- https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-get-started-code-deploy-python.html
