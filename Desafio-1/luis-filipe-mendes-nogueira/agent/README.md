# Agente de compras

Esta pasta contém o assistente de IA da Fase 2. Ele entende as mensagens do usuário, consulta eventos e solicita reservas ou compras às ferramentas. Na AWS, ele roda no **Bedrock AgentCore Runtime**, usando Strands e um modelo Claude Haiku pelo Amazon Bedrock.

## Arquivos principais

| Arquivo ou pasta | Para que serve |
|---|---|
| `agente.py` | Monta o agente e configura o modelo. |
| `prompt.py` | Define as instruções de comportamento do assistente. |
| `ferramentas.py` | Liga o agente às três ferramentas Lambda e encaminha a identidade do usuário. |
| `runtime.py` | Recebe as mensagens e devolve a resposta, inclusive por streaming. |
| `tests/` | Verifica identidade, histórico, chamadas de ferramentas e streaming. |

O agente não acessa o banco diretamente nem escolhe o preço dos ingressos. As ferramentas validam os valores e as regras de compra.

## Como validar

Com o ambiente Python desta pasta preparado e ativado:

```bash
python -m unittest discover -s tests -p 'test_*.py' -v
```

Os scripts `tests/testar_modelo.py` e `tests/testar_agente.py` fazem chamadas reais à AWS. Execute-os manualmente, a partir desta pasta e com a sessão AWS disponível:

```bash
python tests/testar_modelo.py
python tests/testar_agente.py
```

Antes de executar, ajuste `profile_name` nos dois scripts para o nome do seu perfil configurado no AWS CLI (exemplo de configuração: `profile_name="NOME_DO_SEU_PERFIL"`). Esse perfil seleciona as credenciais AWS; não é o usuário da aplicação nem o número da conta. Consulte os nomes com `aws configure list-profiles` e, para acesso SSO, autentique com `aws sso login --profile NOME_DO_SEU_PERFIL`.

O primeiro verifica a resposta do modelo; o segundo consulta o catálogo pelas ferramentas do agente. Esses scripts não entram na descoberta automática de `test_*.py`. O empacotamento e a publicação são coordenados por `infra/`.

Veja o [guia geral](../README.md) para preparação e execução do projeto.
