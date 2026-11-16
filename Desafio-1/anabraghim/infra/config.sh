#!/usr/bin/env bash
# Configuração compartilhada pelos scripts de infra/. Não contém segredo:
# as credenciais vêm do perfil da AWS CLI (AWS_PROFILE), nunca deste arquivo.

PREFIXO="${PREFIXO:-ana-braghim}"
export AWS_REGION="us-east-1"
export AWS_DEFAULT_REGION="us-east-1"
# No Windows, a AWS CLI lê arquivos (template.yaml) e escreve a saída na
# codificação do sistema (cp1252), não em UTF-8: os acentos do template
# chegavam à AWS corrompidos (ex.: "Olá" virava "OlÃ¡" no e-mail de convite).
export AWS_CLI_FILE_ENCODING="UTF-8"
export AWS_CLI_OUTPUT_ENCODING="UTF-8"

STACK_BOOTSTRAP="${PREFIXO}-bootstrap"
STACK_PRINCIPAL="${PREFIXO}-pagamentos"

INFRA_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RAIZ_DIR="$(cd "${INFRA_DIR}/.." && pwd)"
BUILD_DIR="${INFRA_DIR}/build"

log() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
erro() { printf '\033[1;31mErro: %s\033[0m\n' "$*" >&2; exit 1; }

exigir_comando() {
    command -v "$1" >/dev/null 2>&1 || erro "'$1' não encontrado. Veja o README (Deploy passo a passo, pré-requisitos)."
}

# "500" -> 50000, "1250.5" -> 125050, "1250.50" -> 125050. Sem ponto flutuante:
# os valores em dinheiro são inteiros em centavos em todo o backend.
reais_para_centavos() {
    local valor="$1"
    [[ "${valor}" =~ ^([0-9]+)(\.([0-9]{1,2}))?$ ]] || return 1
    local inteiros="${BASH_REMATCH[1]}"
    local fracao="${BASH_REMATCH[3]:-0}"
    [[ ${#fracao} -eq 1 ]] && fracao="${fracao}0"
    echo $(( 10#${inteiros} * 100 + 10#${fracao} ))
}

# put-item que só grava se a chave ainda não existir. Devolve 0 se gravou,
# 2 se o item já existia; qualquer outro erro encerra o script.
put_item_se_nao_existir() {
    local tabela="$1" chave="$2" item="$3" saida
    if saida="$(aws dynamodb put-item \
        --table-name "${tabela}" \
        --item "${item}" \
        --condition-expression "attribute_not_exists(${chave})" 2>&1)"; then
        return 0
    fi
    if [[ "${saida}" == *ConditionalCheckFailedException* ]]; then
        return 2
    fi
    erro "Falha ao gravar em ${tabela}: ${saida}"
}

# Lê um Output de uma stack já criada.
# tr -d '\r': a AWS CLI do Windows termina a saída com \r\n; o $(...) do bash tira
# só o \n, e o \r estragaria nomes montados a partir do valor (ex.: log groups).
output_da_stack() {
    aws cloudformation describe-stacks \
        --stack-name "$1" \
        --query "Stacks[0].Outputs[?OutputKey=='$2'].OutputValue" \
        --output text | tr -d '\r'
}
