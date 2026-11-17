#!/usr/bin/env bash
# Remove o ambiente inteiro (stack principal e bootstrap):
#   ./infra/destroy.sh
#
# Pede confirmação, porque apaga dados (tabelas DynamoDB, usuários do Cognito).
set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/config.sh"

exigir_comando aws

read -r -p "Apagar as stacks ${STACK_PRINCIPAL} e ${STACK_BOOTSTRAP} em ${AWS_REGION}? Digite '${PREFIXO}' para confirmar: " resposta
[[ "${resposta}" == "${PREFIXO}" ]] || erro "Cancelado."

esvaziar_bucket() {
    local bucket="$1"
    if [[ -n "${bucket}" && "${bucket}" != "None" ]]; then
        log "Esvaziando s3://${bucket}"
        aws s3 rm "s3://${bucket}" --recursive
    fi
}

# Bucket do site: o CloudFormation não apaga bucket com objetos.
esvaziar_bucket "$(output_da_stack "${STACK_PRINCIPAL}" SiteBucketNome 2>/dev/null || true)"

# Log group do agente: criado fora do CloudFormation, então é removido aqui.
# O id do runtime é lido antes de a stack sumir.
AGENTE_ID="$(output_da_stack "${STACK_PRINCIPAL}" AgenteRuntimeId 2>/dev/null || true)"

log "Removendo ${STACK_PRINCIPAL}"
aws cloudformation delete-stack --stack-name "${STACK_PRINCIPAL}"
aws cloudformation wait stack-delete-complete --stack-name "${STACK_PRINCIPAL}"

if [[ -n "${AGENTE_ID}" && "${AGENTE_ID}" != "None" ]]; then
    log "Removendo os logs do agente"
    # MSYS_NO_PATHCONV=1: o Git Bash converteria /aws/... em caminho do Windows.
    MSYS_NO_PATHCONV=1 aws logs delete-log-group --log-group-name "/aws/bedrock-agentcore/runtimes/${AGENTE_ID}-DEFAULT" 2>/dev/null || true
fi

log "Removendo ${STACK_BOOTSTRAP}"
esvaziar_bucket "$(output_da_stack "${STACK_BOOTSTRAP}" ArtefatosBucketNome 2>/dev/null || true)"
aws cloudformation delete-stack --stack-name "${STACK_BOOTSTRAP}"
aws cloudformation wait stack-delete-complete --stack-name "${STACK_BOOTSTRAP}"

log "Ambiente removido. Confira se não sobrou nenhum recurso ${PREFIXO}-* (ex.: log groups)."
