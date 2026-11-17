# Validação local da primeira implementação

Data: 14/11/2026. Escopo: frontend estático, Cognito e API de sessão. Nenhum deploy AWS foi executado nesta etapa.

## Checagens executadas

| Checagem | Resultado |
|---|---|
| TypeScript da infraestrutura e Lambda | Compilação concluída |
| Testes da infraestrutura e sessão | 5 testes passaram inicialmente; 6 após adaptar a preparação em 15/11 |
| Síntese CDK | Template CloudFormation gerado sem necessidade de criar recursos |
| Build Next.js estático | Exportação para `frontend/out/` |
| Scripts de deploy e smoke | Sintaxe JavaScript verificada |
| Dependências de produção da nova interface | Auditoria após atualização: zero vulnerabilidades reportadas |
| Revisão visual local | Tela de login verificada em desktop e largura de 390px |

## O que os testes cobrem

- S3 bloqueia acesso público e não usa website hosting.
- CloudFront utiliza OAC com permissão de leitura restrita à distribuição específica.
- Cognito permite apenas usuários criados pelo administrador; app client não contém segredo.
- `GET /sessao` está associado ao autorizador Cognito e há resposta `401` configurada.
- A role de sessão tem somente as ações necessárias para gravar logs, sem política administrativa.
- A Lambda usa a identidade das claims do autorizador e ignora `usuario_id` do corpo.
- Claims ausentes ou inválidas são recusadas, sem fallback para usuário demo.

Na verificação visual, uma configuração fictícia foi fornecida apenas ao navegador de teste. Nenhum login real nem chamada à AWS foi executado. Foram verificados: erro recuperável na ausência de configuração, login sem cadastro, ausência de erros JavaScript e ausência de rolagem horizontal no celular.

## Dependências

A nova interface utiliza Next.js 16.4.6 e React/React DOM 19.3.1. A versão inicial copiada como referência tinha alertas de segurança e foi substituída antes da entrega desta etapa. A auditoria se aplica a `frontend/`, não às pastas legadas `ollama-chat/` e `ollama-tools/`, que não são publicadas pelo novo deploy.

O gerenciador ainda informa um aviso de peer dependency: a dependência transitiva `@xstate/react@3.2.2` do Amplify UI declara suporte até React 18. O build e a tela inicial funcionaram com React 19; convite, troca de senha e autenticação reais precisam ser testados na implantação. Não tratar a revisão visual como comprovação desses fluxos.

## Interpretação das políticas

A política do bucket possui um `Deny` de `s3:*` para conexões sem HTTPS. Isso não concede acesso amplo; proíbe operações inseguras. A leitura autorizada é `s3:GetObject` para o CloudFront específico. O uso de sufixo de objeto/log stream em ARNs é restrito ao recurso do projeto, não uma concessão global `Resource: *`.

## Limitações e próxima verificação

O próximo passo é revisar os recursos em `infra/README.md` e executar o deploy. Em 15/11, foi confirmada a ausência de bootstrap CDK na conta/região. O projeto passou a usar `CliCredentialsStackSynthesizer` com um bucket de artefatos criado por CloudFormation, usando somente as permissões SSO existentes. O teste adicional garante a ausência de dependência da versão do bootstrap e a preparação sem roles administrativas. Depois da implantação, testar o convite, a troca de senha e a API com tokens reais, inclusive expirados. A ausência de execução da Lambda em pedidos recusados deve ser comprovada na AWS.

Não estão implementados nesta etapa: agente no AgentCore, integração com Bedrock, ferramentas de compra em Lambda, DynamoDB ou streaming de chat. Não usar este relatório como evidência de conclusão do desafio completo.
