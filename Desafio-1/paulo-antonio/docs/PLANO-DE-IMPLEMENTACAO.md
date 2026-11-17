# Plano de conclusão do Desafio 1

Atualizado em 16/11/2026. Requisitos de referência: [guia do desafio](GUIA-DO-DESAFIO-1.md).
Estado comprovado e pendências: [evidências e entrega](EVIDENCIAS-E-ENTREGA.md).

## Decisões implementadas

- Trabalho individual no repositório próprio; transferência para o compartilhado somente após revisão.
- TypeScript e AWS CDK; cada pasta é um pacote independente, sem instalação na raiz.
- Frontend Next.js estático com Amplify Authenticator e Cognito por convite.
- Frontend somente local, com README detalhado, por nova orientação do Pedro em 16/11/2026. Backend e Cognito na AWS; CloudFront não é exigido nesta entrega.
- API Gateway REST com autorizador Cognito User Pools e ID token; streaming HTTP de respostas da Lambda.
- AgentCore Runtime com ZIP Node.js 22 ARM64 e AWS SDK, sem Strands obrigatório, Docker/ECR ou MCP Gateway.
- Claude Haiku 4.5 no perfil `us.anthropic.claude-haiku-4-5-20251001-v1:0`.
- Histórico integral por usuário/conversa no DynamoDB; identidade vem do `sub` validado.
- Ferramentas em Lambda; preço e pagamento definidos no backend com transação atômica.
- Confirmação de compra por botão, independente da decisão do modelo.

A REST API foi escolhida para combinar response streaming e autorizador Cognito nativo.
Isso difere de uma HTTP API com JWT Authorizer genérico. A infraestrutura fica em
`us-east-1`; o perfil de inferência dos EUA admite processamento também em `us-east-2`
e `us-west-2`. Essas decisões estão explicadas no README da entrega.

## Concluído e verificado

- [x] Login Cognito, saída e novo acesso confirmados pelo usuário.
- [x] API rejeita token ausente/inválido; oito rotas, CORS para origem local.
- [x] Ferramentas Lambda e quatro tabelas DynamoDB implantadas.
- [x] Regras de quantidade, método, titularidade, expiração, limite e duplicidade cobertas por testes.
- [x] Integração real Lambda → AgentCore → Haiku → ferramentas, confirmação e histórico completo.
- [x] Testes reais de concorrência e isolamento com fixtures, sem consumir saldo do usuário.
- [x] Usuário confirmou catálogo, limite, Pix, cartão, limite insuficiente e expiração.
- [x] Markdown, tabelas e espaçamento do chat corrigidos; usuário confirmou aparência.
- [x] README reúne diagrama, deploy, dados, permissões, decisões e remoção.
- [x] Evidências textuais organizadas; capturas antigas da Fase 1 identificadas como históricas.

## Próximos passos para entrega

1. Completar prints/vídeo atuais de login, API 401, Pix, cartão, limite excedido,
   intenção inválida e logs das ferramentas. Usar conversas já existentes para compras;
   saldo informado após os testes: R$ 502,10. Não restaurar saldo silenciosamente.
2. Confirmar recuperação manual de conversa após atualizar a página. A persistência já
   passou no teste de integração, mas o teste manual de recarregamento não foi explicitado.
3. Validar token expirado e correlacionar rejeições no gateway com ausência de invocação
   da Lambda. São verificações adicionais ainda não demonstradas por evidência atual.
4. Verificar se a evidência de logs atual identifica chamadas de ferramentas. Se não,
   implementar registro de metadados sem prompts, tokens, senhas ou dados bancários.
5. Validar o comando único de deploy a partir da estrutura final. Não confundir deploys
   incrementais já executados com uma instalação limpa. Validar também a execução local
   seguindo o README; não é necessário implantar o frontend.
6. Confirmar e-mail do instrutor, tags exigidas, identificador de pasta/branch e datas.
7. Transferir para `Desafio-1/<seu-nome>/`, branch `fellow/<seu-nome>-desafio-1`, mantendo
   autoria da Fase 1 e sem copiar `.git`, credenciais, dependências ou artefatos temporários.

## Formato da entrega e encerramento

A orientação atual é backend na AWS com Cognito e frontend somente local, com instruções
descritivas no README. Não aguardar CloudFront nem publicar o frontend para esta entrega.
O modo completo permanece no código apenas como alternativa legada.

A limpeza deve ocorrer somente no período combinado, após preservar evidências. Abrange
stack da aplicação, stack de dados, logs AgentCore criados fora da stack e bucket/stack
privados de artefatos. Se o frontend for publicado, incluir bucket, distribuição e OAC.
Não remover recursos compartilhados nem criar uma nova conta para contornar restrições.
