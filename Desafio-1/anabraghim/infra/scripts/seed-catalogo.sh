#!/usr/bin/env bash
# Semeia o catálogo na tabela de produtos. Idempotente: só grava produtos que
# ainda não existem, então rodar de novo não reseta o estoque já vendido.
#
#   ./infra/scripts/seed-catalogo.sh     (chamado automaticamente pelo deploy.sh)
set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/../config.sh"

exigir_comando aws

ARQUIVO="${INFRA_DIR}/seed/produtos.jsonl"
TABELA="$(output_da_stack "${STACK_PRINCIPAL}" ProdutosTabela)"
[[ -n "${TABELA}" && "${TABELA}" != "None" ]] \
    || erro "Stack ${STACK_PRINCIPAL} sem o output ProdutosTabela. Rode ./infra/deploy.sh antes."

log "Semeando catálogo em ${TABELA}"
criados=0
existentes=0
while IFS= read -r item || [[ -n "${item}" ]]; do
    [[ -z "${item// }" ]] && continue
    status=0
    put_item_se_nao_existir "${TABELA}" produto_id "${item}" || status=$?
    if [[ ${status} -eq 0 ]]; then
        criados=$((criados + 1))
    else
        existentes=$((existentes + 1))
    fi
done < "${ARQUIVO}"

echo "Produtos criados: ${criados} · já existentes (mantidos): ${existentes}"
