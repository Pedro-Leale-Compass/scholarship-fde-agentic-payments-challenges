# Agente Strands

`main.py` é o ponto de entrada do AgentCore Runtime. O CDK injeta `BEDROCK_MODEL_ID` e nomes de três Lambdas de ferramentas.

A API envia o `userId` derivado do `sub` validado pelo authorizer, o `conversationId` e todas as mensagens da conversa persistidas no DynamoDB. As ferramentas capturam o contexto confiável e não expõem esses campos como argumentos editáveis pelo modelo.

Dependências: `requirements.txt`. A chamada do modelo e das ferramentas só funciona com recursos e permissões AWS implantados. Para o ZIP, use `infra/scripts/prepare-local.ps1`, que instala dependências alvo Linux ARM64 para Python 3.12.
