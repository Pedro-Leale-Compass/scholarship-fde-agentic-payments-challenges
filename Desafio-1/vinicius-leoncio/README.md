# Agente de Pagamentos na AWS — Vinicius Leoncio

Desafio individual Sprint 2. A base da Sprint 1 foi preservada neste diretório para migrarmos o chatbot local para a arquitetura AWS sem alterar suas regras de negócio.

## Estrutura

- frontend/: interface estática Next.js; Cognito para login e API Gateway para chat.
- tools/: MCP/local da Sprint 1 e handlers cloud para DynamoDB/Lambda.
- agent/: agente Strands para o AgentCore Runtime.
- api/: Lambda do chat, persistência do histórico e integração com AgentCore.
- infra/: stack CDK principal e stack CDK independente de orçamento; deploy não executado.
- docs/: documentação original e notas da migração.

## Plano incremental

1. **Base e regras de negócio:** feito. A base foi copiada para esta pasta; o projeto original permanece intacto.
2. **Persistência e ferramentas:** código cloud criado em tools/src/cloud.ts e tools/src/lambda-handlers.ts, com DynamoDB e compra transacional condicional. Modelo em docs/dynamodb-model.md.
3. **Agente:** código Strands e AgentCore criado em agent/main.py. As ferramentas recebem contexto autenticado fora dos argumentos do modelo.
4. **API:** handler criado em api/src/handler.ts. Lê o sub das claims Cognito, carrega e grava o histórico completo e envia resposta SSE por Lambda response streaming.
5. **Frontend:** migrado para Cognito, consumo da API SSE e build estático. A configuração pública será gerada no deploy.
6. **Infraestrutura:** stacks CDK em infra/ definem Cognito, tabelas, Lambdas, AgentCore, API REST, S3/CloudFront e budget separado. O script infra/scripts/provision-user.ps1 envia convite e registra limite individual; deploy permanece pendente. O authorizer Lambda valida ID tokens Cognito antes do chat. O fluxo envia o evento status cedo, mas espera a resposta completa do agente antes do evento message.
7. **Preparação local:** concluída. `infra/scripts/prepare-local.ps1` exporta o frontend, compila/empacota as Lambdas e prepara o agente para Python 3.12/Linux ARM64. `npm run build` e `npx cdk synth` concluíram localmente, sem credenciais ou criação de recursos AWS.
8. **Validação integrada e evidências:** pendente de AWS. O modelo do coordenador, Claude Haiku 4.5 pelo perfil geográfico dos EUA, foi configurado no CDK. Depois de confirmar o acesso ao modelo na conta, informar o e-mail de alerta e provisionar usuários com os limites definidos, executar os cenários de compra e registrar as evidências. Nenhum recurso AWS será criado sem autorização explícita.

## Regras de negócio

- O valor vem da intenção persistida; não é argumento da ferramenta.
- A intenção precisa pertencer ao usuário autenticado e à conversa atual, estar pendente e dentro da validade.
- O limite é validado no backend; cartão e Pix são aceitos.
- Pagamentos duplicados, corridas no limite e falta de estoque são bloqueados por transação DynamoDB.
- O histórico completo, incluindo tool calls e resultados, segue para o agente em cada turno.
- O chat não aceita userId do corpo da requisição; usa o sub validado pelo API Gateway.

## Próximo passo

A implementação e a síntese locais estão concluídas. O próximo passo é confirmar acesso AWS ao perfil do modelo, escolher o e-mail de alerta e revisar os limites por usuário antes de qualquer deploy. O bootstrap/deploy e os testes integrados exigem conta AWS. Não executar deploy sem aprovação explícita.

## Execução local da base original

A documentação original da Sprint 1 está em docs/sprint1-README.md; o setup do Ollama e o roteiro de testes estão em docs/. Os manifests estão em frontend/package.json e tools/package.json. A versão original ainda depende de Ollama e autenticação local; não representa a arquitetura AWS final.

