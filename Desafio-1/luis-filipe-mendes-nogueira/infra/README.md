# Infraestrutura AWS

Esta pasta descreve e publica os recursos da Fase 2 usando **AWS CDK com Python**. Em vez de criar cada serviço manualmente no console, o código define a estrutura da aplicação.

## O que ela cria

- Cognito para login por convite.
- APIs protegidas para sessão, perfil e chat.
- Funções Lambda para as APIs e ferramentas de compra.
- Tabelas DynamoDB para usuários, catálogo, intenções, transações e conversas.
- Runtime do agente no AgentCore, permissões e logs.

O frontend continua local. Esta infraestrutura não publica a interface em S3/CloudFront nesta etapa.

## Arquivos e pastas principais

| Local | Função |
|---|---|
| `app.py` | Inicia a definição da aplicação CDK. |
| `infra/` | Define os recursos e suas conexões. |
| `policies/` | Políticas usadas na preparação das permissões de implantação. |
| `scripts/` | Empacotamento do agente, catálogo inicial, configuração do frontend e validações. |
| `tests/` | Testes da infraestrutura, deploy e regras das ferramentas. |
| `deploy.sh` | Coordena build, publicação AWS e preparação do frontend local. |

## Validar e publicar

Para rodar os testes a partir desta pasta, com o ambiente Python preparado:

```bash
source .venv/bin/activate
python -m unittest discover -s tests -p 'test_*.py' -v
```

Para atualizar o ambiente, a partir da pasta principal do projeto, com Node.js 24, CDK e sessão AWS disponíveis:

```bash
bash infra/deploy.sh NOME_DO_SEU_PERFIL
```

**Substitua `NOME_DO_SEU_PERFIL` pelo nome do perfil configurado no AWS CLI** que tem acesso à conta de destino. Não é o número da conta nem o usuário de login da aplicação.

Para listar os perfis, use `aws configure list-profiles`. Se o acesso usa SSO, entre com `aws sso login --profile NOME_DO_SEU_PERFIL` e confira a conta de destino com `aws sts get-caller-identity --profile NOME_DO_SEU_PERFIL`.

O script publica o backend e gera o frontend local; depois, reconstrua o serviço Docker para incorporar alterações. A preparação inicial, permissões e diagnóstico estão no [README principal](../README.md).

Mantenha os recursos disponíveis até a avaliação. A remoção da stack pode apagar usuários e dados; o procedimento de limpeza também está no guia principal.
