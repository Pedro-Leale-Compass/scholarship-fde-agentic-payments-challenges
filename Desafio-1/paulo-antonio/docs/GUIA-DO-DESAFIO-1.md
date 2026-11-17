# Guia consolidado do Desafio 1: Agente de Pagamentos na AWS

Consolidado em 13/11/2026 para o trabalho individual de Paulo. Este arquivo reúne requisitos, esclarecimentos e pontos de atenção; não afirma que a migração já foi implementada ou testada.

Este guia preserva o levantamento inicial. Para o estado atual em 16/11/2026, consulte
[EVIDENCIAS-E-ENTREGA.md](EVIDENCIAS-E-ENTREGA.md) e o [README](../README.md).
Itens futuros e checkboxes abaixo são do planejamento original, não uma lista atual de pendências.

**Nova orientação de Pedro em 16/11/2026, prevalece sobre os requisitos antigos abaixo:**
frontend apenas local, com README descritivo para executar; backend e autenticação na AWS.
Portanto, a publicação do frontend em S3/CloudFront não é exigida na entrega atual.

Atualização de 14/11/2026: acesso AWS e chamada ao Claude Haiku 4.5 confirmados pelo usuário. Consulte [VALIDACAO-AWS.md](VALIDACAO-AWS.md) para evidências e limitações e [PLANO-DE-IMPLEMENTACAO.md](PLANO-DE-IMPLEMENTACAO.md) para decisões técnicas e etapas.

## 1. Objetivo e forma de trabalho

**Orientação temporária recebida de Pedro em 15/11/2026:** enquanto resolve as permissões do CloudFront, publicar somente o backend e manter o frontend local. Autenticação Cognito e proteção dos endpoints permanecem obrigatórias. Não interpretar isso como dispensa definitiva do CloudFront. Implementação do modo temporário descrita em `infra/README.md` (`--mode backend`).

Migrar para a AWS o chatbot de pagamentos da Fase 1, substituindo o Ollama por um modelo do Amazon Bedrock, executando o agente no Bedrock AgentCore Runtime e criando a infraestrutura como código.

Preservar as regras de catálogo, intenção de compra, compra simulada com cartão ou Pix, limite por usuário e validação da intenção. Não há integração com pagamentos reais no escopo descrito.

- O desafio é individual.
- Desenvolver primeiro no repositório próprio: https://github.com/lhama06/agente-pagamentos-aws
- Ao finalizar, transferir os arquivos para a pasta e branch do repositório de entrega do Pedro, sem copiar a pasta `.git`.
- Não é necessário redesenhar a interface ou criar novas funcionalidades de negócio. A prioridade é a migração, segurança, persistência, infraestrutura e evidências.
- O código atual ainda é a base local da Fase 1. A leitura do código não substitui testes de execução.

## 2. Fontes e tratamento de divergências

Fontes consultadas:

1. Reunião transcrita enviada pelo usuário, especialmente 5:05–20:16, 27:32–33:37 e 51:15–51:48.
2. PDF original enviado: “Desafio 1 — Agente de Pagamentos na AWS.pdf”.
3. Repositório do Pedro: https://github.com/Pedro-Leale-Compass/scholarship-fde-agentic-payments-challenges
   - `README.md`.
   - `desafio_1_sprint_2.pdf`.
   - `login sso.md`.
   - Versão consultada: commit `5f0a31f`, de 10/11/2026.
4. Código da Fase 1: https://github.com/luiztosk/squad-03-desafio-MCP-agentic
   - Principalmente `ollama-tools/src/tools.ts`, `ollama-tools/src/server.ts`, `ollama-chat/src/lib/auth.ts` e `ollama-chat/src/app/api/chat/route.ts`.
   - Base importada para o repositório próprio no commit `4c6e9ce`.

Aplicar os esclarecimentos explícitos do Pedro na reunião, conforme orientação do usuário. Não transformar recomendações em obrigações nem omitir divergências.

| Assunto | Divergência | Orientação adotada |
|---|---|---|
| Strands | PDFs e README o listam como obrigatório; Pedro o declarou opcional | Strands é opcional. Bedrock e AgentCore Runtime continuam no escopo. |
| Frontend | PDF original usa Amplify Hosting | Usar S3 + CloudFront, conforme reunião e repositório do Pedro. A biblioteca Amplify Auth pode ser usada sem Amplify Hosting. |
| IaC | Um trecho antigo cita somente CDK/CloudFormation | CDK, CloudFormation ou Terraform são aceitos. |
| Pull request | Documentos pedem PR; Pedro corrigiu verbalmente | Push suficiente, sem PR, conforme reunião, salvo nova orientação expressa. |
| Pasta da entrega | PDF do repositório usa `fellows/<seu-nome>/`; README usa `Desafio-1/<seu-nome>/` | Adotar `Desafio-1/<seu-nome>/`, consistente com o README e a pasta existente. |
| CI/CD | PDF original o lista como extra | Planejar deploy local por IaC, sem pipeline, conforme repositório e reunião. |
| Remoção dos recursos | Documentos dizem após correção; reunião menciona quinta-feira após entrega | Guardar evidências e remover no encerramento combinado. Confirmar data oficial antes da limpeza final. |
| Convite do SSO | Tutorial exige aceite de convite por e-mail | Pedro esclareceu que esse passo não era necessário para as contas da turma. Não confundir com os convites do Cognito da aplicação. |

## 3. Arquitetura esperada

```text
Usuário -> login no Cognito
   |
Frontend estático: CloudFront -> S3 privado (OAC)
   |
   | HTTPS + Authorization: Bearer <token do Cognito>
   v
API Gateway: autenticação e rejeição de token inválido
   |
Lambda do chat: identidade validada e histórico
   |
Agente no Bedrock AgentCore Runtime -> modelo do Bedrock
   |
Lambdas das ferramentas -> DynamoDB
```

- Usar `us-east-1` para todos os recursos do desafio, salvo alteração expressa da coordenação.
- A comunicação entre frontend e backend deve passar pelo API Gateway.
- O chat deve oferecer streaming HTTP ou WebSocket; Pedro não exigiu WebSocket.
- Variações de arquitetura precisam de justificativa na documentação.
- MCP via AgentCore Gateway é opcional, não uma exigência apenas porque a Fase 1 usa MCP.
- Confirmar na documentação oficial, durante a implementação, a compatibilidade entre tipo de API Gateway, streaming, autorizador e integrações. O enunciado combina HTTP API/JWT com streaming, mas não detalha uma configuração técnica validada.

## 4. Frontend e autenticação

### Hospedagem

- Gerar arquivos estáticos: React/Vite ou Next.js com exportação estática são aceitos.
- Reaproveitar a interface atual é possível, mas as rotas de backend do Next.js precisam ser separadas para os serviços AWS.
- Bucket S3 privado, sem website hosting e sem acesso público.
- CloudFront deve acessar o bucket por Origin Access Control (OAC).
- A aplicação fica acessível pela URL HTTPS da distribuição.
- O deploy gera a configuração do frontend, por exemplo `config.json`, contendo URL da API, user pool e app client. Não fixar esses valores no código-fonte.
- CORS da API deve aceitar apenas a origem da aplicação no CloudFront.

### Cognito

- Login obrigatório para o chat.
- Desabilitar auto cadastro no próprio user pool: `AllowAdminCreateUserOnly` ou configuração equivalente da ferramenta IaC.
- Esconder a opção de cadastro na interface; isso sozinho não protege o backend.
- Usuários criados pelo administrador, com convite e senha temporária, seguida de troca no primeiro login.
- Para teste, criar o próprio usuário. Para correção, prever usuário do instrutor; o e-mail ainda precisa ser fornecido.
- Amplify Auth/Authenticator é uma recomendação de biblioteca, não obrigação de hospedagem no Amplify.

## 5. API, agente e identidade

- Expor os endpoints de chat e histórico pelo API Gateway, por exemplo `POST /chat` e `GET /conversas`.
- Validar o JWT do Cognito no API Gateway.
- Token ausente, inválido ou expirado deve resultar em `401`, sem executar a Lambda de chat.
- A Lambda extrai o identificador do usuário do `sub` do token validado.
- Não confiar em `usuario_id` recebido no corpo da requisição ou preenchido pelo modelo.
- Transportar a identidade de forma confiável até a execução das ferramentas.
- Executar o agente no Bedrock AgentCore Runtime, usando modelo do Amazon Bedrock.
- Strands é opcional; a biblioteca ainda não foi escolhida.
- Claude Haiku foi recomendado por custo. Pedro posteriormente indicou Claude Haiku 4.5; o usuário testou `us.anthropic.claude-haiku-4-5-20251001-v1:0` com sucesso. O acesso pela role futura do agente ainda precisa ser validado.
- Se usar outro modelo, justificar no README.
- Enviar o histórico completo da conversa a cada turno e persistir as conversas por usuário.
- Tratar falhas com mensagens compreensíveis, sem expor stack traces ao usuário.

## 6. Regras e contratos da Fase 1

### Catálogo existente

| SKU | Produto | Preço em BRL | Categoria |
|---|---|---:|---|
| PS5 | PlayStation 5 | 4.799,00 | game |
| PCGAMER | PC Gamer | 12.499,00 | PC |
| NOTEWORK | Notebook de trabalho | 6.299,00 | PC |
| MONITOR | Monitor 27 polegadas 144 Hz | 1.899,90 | PC |
| CADEIRA | Cadeira gamer | 1.299,00 | moveis |
| LHC | Acelerador de partículas de bancada | 4.200.000.000,00 | lab |

Os limites dos dois usuários de demonstração são R$ 5.000 e R$ 30.000. Na migração, associar os usuários reais ao `sub` do Cognito e definir/documentar a inicialização dos limites. Não reutilizar os UUIDs de demonstração como identidade autenticada.

### Ferramentas obrigatórias

| Ferramenta | Entrada funcional | Resultado |
|---|---|---|
| `listar_catalogo` | `categoria` opcional | `count` e `items`, com SKU, nome, preço, moeda e categoria |
| `registrar_intencao` | `sku`, `quantidade`; identidade confiável adicionada pelo backend | `intencao_id`, `produto_id`, `quantidade`, `valor_total`, `moeda`, `status: pendente`, `expira_em` |
| `realizar_compra` | `intencao_id`, `metodo_pagamento`; identidade confiável adicionada pelo backend | Compra aprovada ou recusada, conforme os contratos abaixo |

Uma Lambda por ferramenta ou uma Lambda com roteamento interno são aceitas. `get_time` e `search_items` existem no projeto antigo, mas não fazem parte das três ferramentas obrigatórias do desafio.

### Intenção

- Criada pelo backend para produto existente no catálogo.
- Validade atual: 180 segundos (3 minutos).
- Valor calculado no backend: preço do catálogo multiplicado pela quantidade.
- Moeda: BRL.
- A intenção fica vinculada ao usuário e começa como `pendente`.
- O modelo não escolhe o identificador nem o valor de uma intenção válida.

### Compra

- Métodos aceitos: `cartao` e `pix`.
- Validar existência, titularidade, status pendente, validade, método e limite disponível.
- O valor vem da intenção persistida, não de um parâmetro do modelo.
- Compra aprovada acumula o gasto, marca a intenção como paga e registra a transação.
- Não pode pagar duas vezes nem ultrapassar o limite por compras concorrentes.
- Não alterar silenciosamente os contratos de argumentos, retornos e erros. A identidade pode estar no contexto interno da ferramenta; nunca deve depender da decisão do modelo.

Retorno aprovado:

```text
status: aprovado
transacao_id, intencao_id, valor, metodo_pagamento, limite_restante, data
```

Retorno recusado:

```text
status: recusado
erro, mensagem
```

| Código | Situação |
|---|---|
| `INTENCAO_INVALIDA` | Intenção ausente, inexistente ou de outro usuário; contexto de usuário inválido |
| `INTENCAO_EXPIRADA` | Prazo de validade vencido |
| `INTENCAO_JA_PAGA` | Intenção já utilizada |
| `LIMITE_EXCEDIDO` | Compra acima do limite restante |
| `METODO_INVALIDO` | Método diferente de cartão/Pix |

## 7. Persistência e pontos de correção

Persistir no DynamoDB:

- Usuários: identificador do Cognito, limite e gasto/saldo disponível.
- Conversas: histórico de cada usuário, com isolamento entre usuários.
- Intenções: produto, quantidade, valor, titular, validade e status.
- Transações: identificador, intenção, valor, método e data.

A modelagem é livre, mas deve explicar tabelas, chaves e acesso no README.

Cuidados identificados na leitura da base:

1. Usuários e intenções vivem em memória. Isso precisa ser substituído por persistência compartilhada.
2. A rota de chat já sobrescreve o `usuario_id` do modelo com o usuário autenticado. Preservar essa proteção na nova arquitetura.
3. As funções antigas possuem fallback para o primeiro usuário quando falta identidade. Remover esse fallback no fluxo AWS.
4. Quantidades inválidas podem virar zero e frações são arredondadas para baixo. Corrigir a validação para não registrar intenções de quantidade zero e documentar o comportamento aceito.
5. Atualização do gasto, pagamento da intenção e registro da transação precisam de consistência conjunta. Planejar transação/escritas condicionais para evitar duplicidade e corrida de limite.
6. A expiração deve ser verificada ao pagar. Se TTL for usado para limpeza, não tratá-lo como substituto dessa validação.
7. Definir representação monetária que evite erros de ponto flutuante, preservando o formato externo esperado pelos contratos.

Os itens de implementação desta seção são cuidados técnicos derivados da análise; não são novas funcionalidades pedidas pelo professor.

## 8. Permissões, segredos e custos

| Componente | Acesso esperado | Evitar |
|---|---|---|
| Lambda de chat | Invocar AgentCore e ler/gravar conversas | Acesso direto ao modelo e às tabelas de intenções/transações |
| AgentCore Runtime | Invocar modelo escolhido, chamar tools e gravar logs | Acesso direto ao DynamoDB |
| Lambda de tool | Somente operações/tabelas necessárias à sua função | Permissões administrativas ou amplas |
| Bucket frontend | Leitura pela distribuição específica do CloudFront via OAC | Leitura pública |

- Declarar políticas IAM no IaC e restringir ações e recursos.
- Não usar `AdministratorAccess` nem a combinação `Action: *` / `Resource: *`.
- Não incluir credenciais, tokens, chaves ou segredos no código, logs de evidência ou histórico Git.
- Ignorar `.env`, dependências, saída de build, `cdk.out`, `.terraform`, estados Terraform e arquivos de chave.
- Orçamento informado na reunião: US$ 20 por mês. Não foi confirmado bloqueio automático ao atingir o limite.
- Configurar AWS Budgets antes do primeiro deploy. Alerta em US$ 15 foi sugerido na reunião.
- Preferir o modelo barato recomendado e evitar EC2/RDS no desenho deste desafio.
- Aplicar as tags exigidas pelo material/coordenação. A reunião cita Fellowship, mas não fornece chave e valor completos de forma confiável.

## 9. Acesso à AWS e deploy

- Usar AWS CLI v2 e autenticação SSO/IAM Identity Center.
- Não criar access keys permanentes para contornar erro de login.
- A região do SSO pode ser diferente de `us-east-1`; usar o valor fornecido pela coordenação.
- Nome do perfil é local e pode ser curto. O tutorial usa `desafio-1`, mas o perfil real precisa ser confirmado.

Exemplo em PowerShell, ajustando o nome ao perfil existente:

```powershell
aws configure sso
$env:AWS_PROFILE = "desafio-1"
aws sso login
aws sts get-caller-identity
aws s3 ls
```

`aws configure sso` é a configuração inicial, não uma etapa obrigatória em toda execução. Quando a sessão expirar, repetir o login SSO. `aws s3 ls` pode não mostrar nada se não houver buckets; ausência de erro é diferente de falha.

Antes de cada deploy, conferir conta e identidade. Não divulgar a saída com dados da conta sem necessidade. Em WSL sem abertura automática do navegador, o tutorial apresenta `--use-device-code` como alternativa.

### Requisitos de automação

- Escolher CDK, CloudFormation ou Terraform; a escolha ainda está pendente.
- IaC na pasta `infra/`.
- Um comando documentado deve preparar o ambiente inteiro: S3, CloudFront, OAC, Cognito, API, tabelas, Lambdas, agente, roles e permissões, build/upload da interface e invalidação de cache.
- Gerar a configuração de acesso do frontend durante o deploy.
- Usar o nome do aluno como prefixo da stack/recursos, respeitando regras de nomes e unicidade de cada serviço.
- Documentar pré-requisitos e qualquer exceção manual inevitável.
- Fazer a primeira implantação cedo: a reunião recomenda pelo menos dois dias antes do fim, pois permissões podem precisar de suporte da equipe.
- Deploy não deve depender da localização original no computador: precisa continuar funcionando após a transferência para a pasta de entrega.

## 10. Estrutura e transferência final

Estrutura alvo do projeto próprio:

```text
frontend/
api/
agent/
tools/
infra/
docs/
README.md
```

A estrutura atual ainda contém `ollama-chat/` e `ollama-tools/`; a reorganização fará parte da implementação.

No repositório do Pedro:

```text
Branch: fellow/<seu-nome>-desafio-1
Pasta: Desafio-1/<seu-nome>/
```

`paulo-antonio` é uma opção de identificador, ainda não uma escolha final confirmada. Ao transferir, trabalhar somente na própria pasta e preservar as outras entregas. Não copiar `.git`, dependências, credenciais nem artefatos temporários. Seguir o esclarecimento da reunião de que push é suficiente.

## 11. Checklist original de implementação e validação

- [x] Validar acesso inicial por SSO, perfil e região; conferir orçamento existente e verificar o e-mail do aluno (ver registro de validação; permissões de deploy ainda não testadas).
- [ ] Escolher IaC, biblioteca do agente, modelo e configuração compatível de streaming/autenticação.
- [ ] Reorganizar o código sem perder regras e contratos da Fase 1.
- [ ] Publicar frontend estático com S3 privado e CloudFront/OAC.
- [ ] Gerar configuração do frontend no deploy.
- [ ] Configurar Cognito sem auto cadastro e testar convite/primeiro login.
- [ ] Validar token no API Gateway; rejeitar ausente/inválido/expirado antes da Lambda.
- [ ] Executar agente no AgentCore com modelo Bedrock e histórico completo.
- [ ] Executar as três ferramentas em Lambda.
- [ ] Persistir usuários, conversas, intenções e transações no DynamoDB.
- [ ] Impedir uso de intenção de outro usuário e valores/identidades fornecidos pelo modelo.
- [ ] Validar expiração, quantidade, método e limite.
- [ ] Impedir débito duplicado e estouro de limite por concorrência.
- [ ] Revisar menor privilégio, CORS e ausência de segredos.
- [ ] Testar deploy completo reproduzível e documentar remoção.
- [ ] Gerar evidências atuais da AWS; os prints da Fase 1 não comprovam a migração.
- [ ] Finalizar README e transferir para a branch/pasta de entrega.

## 12. README final e evidências

O README da entrega deve conter:

1. Diagrama da arquitetura realmente implementada.
2. Pré-requisitos e passo a passo, incluindo o comando único de deploy.
3. Modelo Bedrock usado e justificativa caso não seja Haiku.
4. Modelagem DynamoDB: tabelas, chaves e finalidade.
5. Resumo das permissões IAM por componente.
6. Evidências em prints ou vídeo curto.
7. Instruções de remoção de todos os recursos.
8. Justificativas de variações e decisões técnicas relevantes.

Evidências exigidas:

- Login funcionando.
- API sem token rejeitada com `401`.
- Compra simulada bem-sucedida com cartão.
- Compra simulada bem-sucedida com Pix.
- Compra recusada por limite excedido.
- `intencao_id` inválido recusado.
- Logs mostrando a execução e chamadas das ferramentas, conforme reunião.

Verificações adicionais recomendadas: token expirado/inválido, intenção expirada, intenção de outro usuário, repetição de pagamento, compras concorrentes e persistência após nova sessão. Não confundir recomendações de teste com novas evidências formalmente exigidas.

## 13. Encerramento e pendências

Antes de remover recursos, salvar evidências e observar o período combinado com a equipe. A reunião menciona entrega na quarta-feira seguinte e limpeza na quinta, mas usa linguagem incerta. Não há data oficial confirmada neste guia.

Executar a remoção pelo IaC e conferir recursos remanescentes:

- Stack e recursos de backend/autenticação.
- Distribuição CloudFront, OAC e bucket com seus objetos.
- Runtime AgentCore e imagens/repositório ECR usados pelo projeto.
- Tabelas DynamoDB e grupos de logs.
- Outros recursos criados fora da stack.

Não assumir que `destroy` remove recursos com política de retenção ou recursos criados fora do IaC. O procedimento deve ser restrito aos recursos deste projeto.

Pendências a resolver na implementação:

- Data oficial de entrega, correção e limpeza.
- E-mail do instrutor para convite no Cognito.
- Nome final para prefixos, pasta e branch.
- Permissões de deploy e das roles da aplicação; perfil `desafio-1` já validado para acesso inicial.
- Biblioteca do agente. CDK TypeScript adotado no plano; Haiku 4.5 confirmado no teste do aluno.
- Validar em implementação a escolha de REST API com Cognito e streaming descrita no plano.
- Modelagem DynamoDB e inicialização dos limites dos usuários.
- Padrão completo de tags.

Extras opcionais, fora da prioridade inicial: AgentCore Gateway/MCP, AgentCore Memory, Bedrock Guardrails e traces do agente no CloudWatch. Configuração de skills de assistentes e conversas sobre Amazon Connect não são requisitos deste desafio.
