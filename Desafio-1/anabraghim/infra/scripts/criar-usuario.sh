#!/usr/bin/env bash
# Cria um usuário por convite (o auto cadastro está desabilitado no user pool).
#
#   ./infra/scripts/criar-usuario.sh email@exemplo.com [limite_em_reais]
#
# O Cognito envia ao e-mail o convite com o usuário e uma senha temporária;
# no primeiro login o usuário é obrigado a definir uma nova senha.
set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/../config.sh"

EMAIL="${1:-}"
LIMITE="${2:-500}"

[[ "${EMAIL}" =~ ^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$ ]] \
    || erro "Uso: $0 email@exemplo.com [limite_em_reais]"
LIMITE_CENTAVOS="$(reais_para_centavos "${LIMITE}")" \
    || erro "Limite inválido: '${LIMITE}'. Use um valor em reais, ex.: 500 ou 1250.50"

exigir_comando aws

USER_POOL_ID="$(output_da_stack "${STACK_PRINCIPAL}" UserPoolId)"
TABELA_USUARIOS="$(output_da_stack "${STACK_PRINCIPAL}" UsuariosTabela)"
[[ -n "${USER_POOL_ID}" && "${USER_POOL_ID}" != "None" && -n "${TABELA_USUARIOS}" && "${TABELA_USUARIOS}" != "None" ]] \
    || erro "Stack ${STACK_PRINCIPAL} sem os outputs UserPoolId/UsuariosTabela. Rode ./infra/deploy.sh antes."

log "Criando ${EMAIL} no user pool ${USER_POOL_ID}"
# email_verified=true: o e-mail foi informado pelo administrador, e o convite
# só chega se o endereço existir. Sem isso a recuperação de senha não funciona.
USUARIO_ID="$(aws cognito-idp admin-create-user \
    --user-pool-id "${USER_POOL_ID}" \
    --username "${EMAIL}" \
    --user-attributes Name=email,Value="${EMAIL}" Name=email_verified,Value=true \
    --desired-delivery-mediums EMAIL \
    --query "User.Attributes[?Name=='sub'].Value | [0]" \
    --output text | tr -d '\r')"   # sem o \r da AWS CLI do Windows, que iria para a chave no DynamoDB

log "Usuário criado. usuario_id (sub): ${USUARIO_ID}"

# Put condicional: se o usuário já tiver registro (ex.: já comprou), o saldo dele
# não é sobrescrito. Mudar limite de usuário existente é operação à parte.
AGORA="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
ITEM="{\"usuario_id\":{\"S\":\"${USUARIO_ID}\"},\"limite_total_centavos\":{\"N\":\"${LIMITE_CENTAVOS}\"},\"limite_disponivel_centavos\":{\"N\":\"${LIMITE_CENTAVOS}\"},\"criado_em\":{\"S\":\"${AGORA}\"}}"

status=0
put_item_se_nao_existir "${TABELA_USUARIOS}" usuario_id "${ITEM}" || status=$?
if [[ ${status} -eq 0 ]]; then
    log "Limite de R\$ ${LIMITE} gravado em ${TABELA_USUARIOS}"
else
    log "Usuário já tinha registro em ${TABELA_USUARIOS}; limite existente mantido"
fi
