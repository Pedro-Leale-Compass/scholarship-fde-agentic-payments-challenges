#!/usr/bin/env bash
# Cria ou atualiza o ambiente completo com um único comando:
#   ./infra/deploy.sh
#
# Pré-requisitos e passos manuais: README.md, seção "Deploy passo a passo".
# Variáveis opcionais: PREFIXO (default ana-braghim), AWS_PROFILE,
#   MODELO_ID e MODELO_BASE_ID (default: Claude Haiku 4.5, ver template.yaml),
#   SEM_FRONTEND=1 para criar só o backend (sem S3 do site nem CloudFront) e
#   preparar o frontend para rodar localmente:
#     SEM_FRONTEND=1 ./infra/deploy.sh
#   Rodar depois sem a variável acrescenta o hosting à stack existente.
set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/config.sh"

SEM_FRONTEND="${SEM_FRONTEND:-0}"
[[ "${SEM_FRONTEND}" == "0" || "${SEM_FRONTEND}" == "1" ]] || erro "SEM_FRONTEND deve ser 0 ou 1 (recebido: ${SEM_FRONTEND})."

verificar_prerequisitos() {
    log "Verificando pré-requisitos"
    exigir_comando aws
    exigir_comando node
    exigir_comando npm
    exigir_comando python
    # vitest 5 e vite 8 exigem Node 22.12+: sem esta checagem, o erro só apareceria no meio dos testes.
    node -e 'const [a, b] = process.versions.node.split(".").map(Number); process.exit(a > 22 || (a === 22 && b >= 12) ? 0 : 1)' \
        || erro "Node.js $(node --version) é antigo: instale o 22.12 ou mais recente (22 LTS, 24 ou 26)."
    aws sts get-caller-identity --query Account --output text >/dev/null \
        || erro "Credenciais da AWS inválidas. Configure AWS_PROFILE."
}

deploy_bootstrap() {
    log "Stack de bootstrap (${STACK_BOOTSTRAP})"
    aws cloudformation deploy \
        --stack-name "${STACK_BOOTSTRAP}" \
        --template-file "${INFRA_DIR}/bootstrap.yaml" \
        --parameter-overrides "Prefixo=${PREFIXO}" \
        --no-fail-on-empty-changeset
    ARTEFATOS_BUCKET="$(output_da_stack "${STACK_BOOTSTRAP}" ArtefatosBucketNome)"
}

build_artefatos() {
    log "Build dos artefatos"
    rm -rf "${BUILD_DIR}"
    mkdir -p "${BUILD_DIR}"
    # Tools: testes antes do build, para não publicar regra de compra quebrada.
    (cd "${RAIZ_DIR}/tools" && npm ci --no-audit --no-fund && npm test && npm run build)
    build_agente
    # API: mesmos cuidados das tools (testes antes do bundle).
    (cd "${RAIZ_DIR}/api" && npm ci --no-audit --no-fund && npm test && npm run build)
    # Sem frontend publicado, o build do site não é necessário (ele roda com npm run dev).
    if [[ "${SEM_FRONTEND}" == "0" ]]; then
        build_frontend
    fi
}

# Frontend: o build não depende da stack (a configuração é lida em runtime do
# /config.json), então roda antes do deploy e falha cedo. A cópia para
# infra/build/site é feita pelo bash: caminhos /c/... do Git Bash não funcionam
# como argumento para o Node no Windows.
build_frontend() {
    (cd "${RAIZ_DIR}/frontend" && npm ci --no-audit --no-fund && npm test && npm run build)
    rm -rf "${BUILD_DIR}/site"
    cp -r "${RAIZ_DIR}/frontend/dist" "${BUILD_DIR}/site"
    [[ -f "${BUILD_DIR}/site/index.html" ]] || erro "Build do frontend sem index.html."
}

# Agente: testes num venv descartável e zip para Linux ARM64. Só acessa o PyPI;
# os testes usam credenciais falsas e AWS stubada.
build_agente() {
    local venv="${BUILD_DIR}/venv-agente" py
    python -m venv "${venv}"
    py="${venv}/bin/python"
    [[ -x "${py}" ]] || py="${venv}/Scripts/python"   # Windows (Git Bash)
    "${py}" -m pip install --quiet --disable-pip-version-check -r "${RAIZ_DIR}/agent/requirements-dev.txt"
    (cd "${RAIZ_DIR}/agent" && "${py}" -m pytest -q -p no:cacheprovider)
    AGENTE_SHA="$("${py}" "${RAIZ_DIR}/agent/empacotar.py" "${BUILD_DIR}/agent" | tail -n 1)"
    [[ "${AGENTE_SHA}" =~ ^[a-f0-9]{64}$ ]] || erro "Empacotamento do agente não devolveu o SHA-256."
}

# O AgentCore lê o código direto do S3 (o `cloudformation package` não cobre esse
# recurso). O nome do objeto é o SHA-256 do zip: só há upload e atualização do
# runtime quando o código ou as dependências mudam.
publicar_agente() {
    AGENTE_CHAVE="agente/${AGENTE_SHA}.zip"
    if aws s3api head-object --bucket "${ARTEFATOS_BUCKET}" --key "${AGENTE_CHAVE}" >/dev/null 2>&1; then
        log "Zip do agente já publicado (${AGENTE_CHAVE})"
    else
        log "Publicando o zip do agente (${AGENTE_CHAVE})"
        aws s3 cp "${BUILD_DIR}/agent/agente.zip" "s3://${ARTEFATOS_BUCKET}/${AGENTE_CHAVE}" --only-show-errors
    fi
}

deploy_principal() {
    publicar_agente

    local parametros=(
        "Prefixo=${PREFIXO}"
        "AgenteCodigoBucket=${ARTEFATOS_BUCKET}"
        "AgenteCodigoChave=${AGENTE_CHAVE}"
    )
    # Sempre explícito: sem ele, o CloudFormation manteria o valor do deploy
    # anterior, e um deploy normal depois de um SEM_FRONTEND=1 ficaria sem o site.
    if [[ "${SEM_FRONTEND}" == "1" ]]; then
        parametros+=("ComFrontend=nao")
    else
        parametros+=("ComFrontend=sim")
    fi
    # Sem a variável, o CloudFormation usa o default do template (ou mantém o valor anterior).
    [[ -n "${MODELO_ID:-}" ]] && parametros+=("ModeloId=${MODELO_ID}")
    [[ -n "${MODELO_BASE_ID:-}" ]] && parametros+=("ModeloBaseId=${MODELO_BASE_ID}")

    log "Stack principal (${STACK_PRINCIPAL})"
    aws cloudformation package \
        --template-file "${INFRA_DIR}/template.yaml" \
        --s3-bucket "${ARTEFATOS_BUCKET}" \
        --s3-prefix "${STACK_PRINCIPAL}" \
        --output-template-file "${BUILD_DIR}/template.empacotado.yaml"

    # No Windows, o `package` lê em UTF-8 (AWS_CLI_FILE_ENCODING), mas grava o
    # arquivo empacotado em cp1252, e o `deploy` falharia ao ler em UTF-8.
    # Converte de volta; no Linux/macOS o arquivo já é UTF-8 e nada muda.
    python - "${BUILD_DIR}/template.empacotado.yaml" <<'PY'
import pathlib, sys
arquivo = pathlib.Path(sys.argv[1])
bruto = arquivo.read_bytes()
try:
    bruto.decode("utf-8")
except UnicodeDecodeError:
    arquivo.write_bytes(bruto.decode("cp1252").encode("utf-8"))
    print("template empacotado convertido de cp1252 para UTF-8")
PY

    aws cloudformation deploy \
        --stack-name "${STACK_PRINCIPAL}" \
        --template-file "${BUILD_DIR}/template.empacotado.yaml" \
        --parameter-overrides "${parametros[@]}" \
        --capabilities CAPABILITY_NAMED_IAM \
        --no-fail-on-empty-changeset
}

# O AgentCore cria o log group do runtime sozinho e sem retenção. Ele é criado
# aqui (se ainda não existir) para já nascer com 14 dias, como os das Lambdas.
configurar_logs_agente() {
    local id grupo
    id="$(output_da_stack "${STACK_PRINCIPAL}" AgenteRuntimeId)"
    grupo="/aws/bedrock-agentcore/runtimes/${id}-DEFAULT"
    # MSYS_NO_PATHCONV=1: no Git Bash, um argumento que começa com / (ex.: /aws/...)
    # é convertido em caminho do Windows antes de chegar à AWS CLI.
    MSYS_NO_PATHCONV=1 aws logs create-log-group --log-group-name "${grupo}" >/dev/null 2>&1 || true
    MSYS_NO_PATHCONV=1 aws logs put-retention-policy --log-group-name "${grupo}" --retention-in-days 14
}

# O AWS::ApiGateway::Deployment do template não é recriado quando um método muda.
# Um deployment novo por execução garante que o stage prod sempre reflete o template.
publicar_api() {
    local api
    api="$(output_da_stack "${STACK_PRINCIPAL}" ApiId)"
    log "Publicando a API ${api} no stage prod"
    aws apigateway create-deployment \
        --rest-api-id "${api}" \
        --stage-name prod \
        --description "deploy.sh $(date -u +%Y-%m-%dT%H:%M:%SZ)" >/dev/null
}

# config.json do frontend a partir dos Outputs (ids públicos do Cognito, sem segredo).
gerar_config_frontend() {
    local destino="$1" pool cliente
    pool="$(output_da_stack "${STACK_PRINCIPAL}" UserPoolId)"
    cliente="$(output_da_stack "${STACK_PRINCIPAL}" UserPoolClientId)"
    [[ "${pool}" =~ ^[a-z]{2}-[a-z]+-[0-9]_[0-9A-Za-z]+$ ]] || erro "UserPoolId inválido nos Outputs: ${pool}"
    [[ "${cliente}" =~ ^[0-9a-z]{20,128}$ ]] || erro "UserPoolClientId inválido nos Outputs: ${cliente}"
    printf '{\n  "userPoolId": "%s",\n  "userPoolClientId": "%s"\n}\n' "${pool}" "${cliente}" > "${destino}"
}

# Publica o site no bucket privado e invalida o CloudFront.
# - assets/ têm hash no nome: cache de 1 ano. index.html e config.json: no-cache,
#   para que um deploy novo apareça no próximo carregamento.
publicar_frontend() {
    local bucket distribuicao site="${BUILD_DIR}/site"
    bucket="$(output_da_stack "${STACK_PRINCIPAL}" SiteBucketNome)"
    distribuicao="$(output_da_stack "${STACK_PRINCIPAL}" DistribuicaoId)"

    gerar_config_frontend "${site}/config.json"

    log "Publicando o site em s3://${bucket}"
    aws s3 sync "${site}/assets" "s3://${bucket}/assets" --delete --only-show-errors \
        --cache-control "public, max-age=31536000, immutable"
    aws s3 sync "${site}" "s3://${bucket}" --delete --only-show-errors \
        --exclude "assets/*" \
        --cache-control "no-cache"

    log "Invalidando o cache do CloudFront (${distribuicao})"
    MSYS_NO_PATHCONV=1 aws cloudfront create-invalidation --distribution-id "${distribuicao}" --paths "/*" >/dev/null

    SITE_URL="$(output_da_stack "${STACK_PRINCIPAL}" SiteUrl)"
}

# Sem CloudFront: deixa o frontend pronto para `npm run dev`. Os dois arquivos são
# ignorados pelo git. O Vite repassa /api para a API publicada (mesmo papel do
# CloudFront), então o login do Cognito e o JWT funcionam igual.
configurar_frontend_local() {
    local api env_local="${RAIZ_DIR}/frontend/.env.local" marca="# gerado por infra/deploy.sh"
    api="$(output_da_stack "${STACK_PRINCIPAL}" ApiUrl)"
    [[ "${api}" =~ ^https://[a-z0-9]+\.execute-api\.[a-z0-9-]+\.amazonaws\.com/prod$ ]] || erro "ApiUrl inválida nos Outputs: ${api}"

    log "Preparando o frontend local (frontend/public/config.json e frontend/.env.local)"
    gerar_config_frontend "${RAIZ_DIR}/frontend/public/config.json"
    # Não sobrescreve um .env.local escrito à mão.
    if [[ -f "${env_local}" ]] && ! grep -qF "${marca}" "${env_local}"; then
        printf '  Aviso: frontend/.env.local já existe e não foi gerado pelo deploy; mantido. Confira: API_URL=%s\n' "${api}"
    else
        printf '%s\nAPI_URL=%s\n' "${marca}" "${api}" > "${env_local}"
    fi
    API_URL_PUBLICADA="${api}"
}

pos_deploy() {
    publicar_api
    configurar_logs_agente
    "${INFRA_DIR}/scripts/seed-catalogo.sh"
    if [[ "${SEM_FRONTEND}" == "1" ]]; then
        configurar_frontend_local
    else
        publicar_frontend
    fi
}

main() {
    verificar_prerequisitos
    deploy_bootstrap
    build_artefatos
    deploy_principal
    pos_deploy
    log "Deploy concluído (${STACK_PRINCIPAL} em ${AWS_REGION})"
    if [[ "${SEM_FRONTEND}" == "1" ]]; then
        printf '\n  Backend publicado, sem CloudFront. API: %s\n' "${API_URL_PUBLICADA}"
        printf '  Para abrir o assistente: cd frontend && npm install && npm run dev  ->  http://localhost:5173\n'
        printf '  Para publicar o site depois: ./infra/deploy.sh (sem SEM_FRONTEND)\n\n'
    else
        printf '\n  Assistente: %s\n\n' "${SITE_URL}"
        printf '  Na primeira criação, o CloudFront pode levar alguns minutos para responder.\n'
    fi
    printf '  Usuários são criados por convite: ./infra/scripts/criar-usuario.sh <email>\n\n'
}

main "$@"
