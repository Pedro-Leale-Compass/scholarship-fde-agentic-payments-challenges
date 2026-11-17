# Evidências e preparação da entrega

Revisão de 17/11/2026. Este índice distingue testes executados, relatos do usuário e
arquivos visuais ainda necessários. Não declara a entrega concluída.

Nova orientação do Pedro: frontend somente local, acompanhado de README descritivo;
backend e autenticação permanecem na AWS. Deploy S3/CloudFront do frontend deixou de
ser requisito desta entrega. O README inclui execução local com backend já existente.

## Capturas reais de 16/11/2026

Frontend local conectado ao backend AWS, sem interceptar respostas ou usar fixtures.
O usuário realizou o login. Nenhuma senha ou token foi registrado.

- [Tela de login](evidencias/login-cognito-local.png) e [acesso confirmado](evidencias/acesso-confirmado.png).
- [API sem autenticação](evidencias/api-sem-autenticacao.png): GET `/v1/sessao` retornou `Unauthorized`; os códigos HTTP estão em [api-401.md](evidencias/api-401.md).
- [Compra Pix recuperada](evidencias/compra-pix-historico.png): cadeira de R$ 1.299,00, saldo histórico R$ 1.801,10.
- [Compra no cartão recuperada](evidencias/compra-cartao-historico.png): cadeira de R$ 1.299,00, saldo R$ 502,10.
- [Recusa por limite](evidencias/limite-excedido-aws.png): nova intenção de uma unidade de PS5, R$ 4.799,00, confirmada por Pix simulado; API retornou `LIMITE_EXCEDIDO` e o saldo permaneceu R$ 502,10.

Pix e cartão são capturas de conversas salvas das compras anteriores, não novas
compras. Após recarregar a página, a sessão foi validada novamente e a conversa do
cartão foi reaberta com a mesma transação e saldo. Isso confirma a recuperação pela
interface; o isolamento entre titulares continua coberto pelo teste administrativo.
Também foi capturada a [recusa por expiração](evidencias/intencao-expirada-aws.png)
da mesma intenção de PS5, após o prazo de três minutos: `INTENCAO_EXPIRADA`, saldo
preservado em R$ 502,10.

O [teste administrativo de intenção inválida](evidencias/intencao-invalida-lambda.md)
registra resposta real `INTENCAO_INVALIDA` e logs da mesma execução Lambda. Não usa
o usuário real e não comprova autenticação Cognito. Permanecem pendentes a captura
visual desse cenário. A correlação de chamadas AgentCore → ferramentas foi coletada
em 17/11 nos [registros reais de auditoria](evidencias/auditoria-ferramentas.md).

## Matriz de comprovação

| Cenário | Resultado e origem | Evidência disponível / pendência |
|---|---|---|
| Login Cognito e API autenticada | Acesso confirmado observado após login e recarga | Capturas de login/acesso acima |
| API sem token / token inválido | Smoke real passou nas oito rotas | `evidencias/api-401.md` e captura da resposta sem autenticação acima |
| Pix | Conversa salva recuperada; saldo histórico R$ 1.801,10 | Captura Pix acima e `evidencias/testes-manuais.md` |
| Cartão | Conversa salva recuperada; saldo R$ 502,10 | Captura cartão acima e `evidencias/testes-manuais.md` |
| Limite excedido | Teste pelo formulário retornou `LIMITE_EXCEDIDO` | Captura da recusa acima; saldo preservado |
| Intenção expirada | Interface retornou `INTENCAO_EXPIRADA` após três minutos | `evidencias/intencao-expirada-aws.png`; saldo preservado |
| Intenção inválida / outro titular | Lambda real recusou intenção inexistente; integração anterior verificou outro titular | `evidencias/intencao-invalida-lambda.md`; evidência textual administrativa, captura visual ainda pendente |
| Duplicidade e concorrência | Testes reais anteriores de DynamoDB e integração do agente passaram | `DYNAMODB.md`, `CHAT-2026-11-16.md` e scripts de integração |
| Histórico completo e isolamento | Integração real leu mensagens/ferramentas salvas; outro titular recebeu 404 | Recuperação pela interface após recarregar confirmada em 16/11; isolamento coberto por teste administrativo |
| Formatação | Build e teste de navegador com API simulada passaram; usuário confirmou aparência correta no chat real | Sem confundir screenshot de fixture com compra real |
| Logs e chamadas de ferramentas | Runtime publicado em 17/11; integração passou e seis pares de eventos foram coletados | `evidencias/auditoria-ferramentas.md` e JSON do CloudWatch; evidência textual real, sem captura visual do console |

Os screenshots em `docs/screenshots/` são herdados da Fase 1. Não foram renomeados ou
apresentados como provas da AWS. Os registros textuais aqui não substituem prints/vídeo
quando esse formato for exigido pelo Pedro.

## Testes reproduzíveis

Com dependências instaladas em cada projeto:

| Pasta | Comando | Alcance |
|---|---|---|
| `tools/` | `pnpm test` | 20 testes locais de regras e handler |
| `agent/` | `pnpm test` | 10 testes locais de agente/chat e privacidade dos logs |
| `infra/` | `pnpm test` | 10 testes de template e sessão; também compila pacotes |
| `frontend/` | `pnpm run build` | Exportação estática e TypeScript |
| `infra/` | `node scripts/smoke.mjs --backend` | Rejeição 401 e CORS nas rotas reais |
| `tools/` | `node test/dynamo.integration.ts --account CONTA` | Persistência e concorrência no DynamoDB real |
| `tools/` | `node test/lambda.integration.ts --account CONTA` | Lambda real, permissões, regras e dados |
| `agent/` | `node test/aws.integration.ts --account CONTA` | Lambda → AgentCore → Haiku → ferramentas, histórico e confirmação |

Integrações usam SSO, conferem a conta e criam fixtures isoladas, removidas ao final.
Não usam o saldo do usuário Cognito. Chamadas reais podem consumir recursos AWS.
Os testes administrativos não substituem autenticação positiva no navegador; esta foi
relatada pelo usuário ao realizar as compras no chat. Não repetir toda a bateria apenas
para formatar documentação.

## Roteiro curto para capturar a demonstração

1. Mostrar login e acesso confirmado, sem exibir senha, código de recuperação ou token.
2. Pedir catálogo e limite; mostrar a tabela formatada.
3. Usar conversas salvas das compras já realizadas para mostrar Pix e cartão. Não há
   saldo suficiente para repetir uma cadeira na conta atual (R$ 502,10 informado).
4. Mostrar a recusa por limite no formulário; registrar a resposta.
5. Testar uma intenção inexistente com chamada autenticada e guardar somente o corpo
   `recusado` / `INTENCAO_INVALIDA`, ocultando Authorization. Não usar token no comando
   versionado nem em print. Este teste ainda precisa de captura atual.
6. Recarregar a página, abrir uma conversa salva e conferir histórico e saldo.
7. Capturar a evidência 401 sem login e os logs do projeto que demonstrem execução.
   Se os logs atuais não identificarem chamadas das ferramentas, falta instrumentação
   de metadados; não afirmar que START/END prova qual ferramenta foi chamada.

## Pendências antes da transferência

- [x] Arquitetura, modelo, dados, permissões, deploy e limpeza documentados no README.
- [x] Pagamentos e chat validados por testes reais e relatos manuais, com limites da comprovação descritos.
- [x] Capturar login, acesso, Pix, cartão e recusa por limite.
- [x] Capturar expiração e registrar resposta real de intenção inválida com logs da execução administrativa.
- [x] Coletar correlação AgentCore → ferramentas nos logs após publicação e integração real.
- [ ] Completar captura visual de intenção inválida e do console de logs, caso exigida nesse formato.
- [x] Confirmar recuperação pela interface do histórico após recarregar.
- [ ] Testar token expirado e verificar métricas de não invocação da Lambda em requisições rejeitadas; checagens adicionais ainda pendentes.
- [ ] Validar execução local e deploy do backend pelo comando documentado a partir da estrutura final de entrega. CloudFront não é necessário.
- [x] Preparar localmente branch `fellow/paulo-antonio-desafio-1` e pasta `Desafio-1/paulo-antonio/`.
- [x] Criar acessos convidados de Pedro e Gabriel no Cognito, nos e-mails fornecidos pelo aluno (17/11/2026). AWS aceitou envio dos convites; ambos habilitados em `FORCE_CHANGE_PASSWORD`. Recebimento e primeiro login ainda não confirmados. Nenhuma senha registrada no projeto.
- [ ] Confirmar tags obrigatórias e datas de entrega/limpeza.
- [ ] Transferir ao repositório compartilhado, preservando outras entregas.

Destino previsto: branch `fellow/<seu-nome>-desafio-1`, pasta `Desafio-1/<seu-nome>/`.
`paulo-antonio` já é prefixo dos recursos, mas o identificador final da entrega deve ser
confirmado. Copiar apenas arquivos versionados da implementação (`frontend`, `api`, `agent`,
`tools`, `infra`, `docs`, README e arquivos de configuração necessários); preservar a
atribuição da Fase 1. Não copiar `.git`, `node_modules`, `.pnpm-store`, `.deploy`, `.aws`,
`cdk.out`, builds, senhas ou tokens. Não publicar a entrega como completa antes das pendências.
