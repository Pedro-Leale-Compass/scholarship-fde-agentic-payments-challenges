# Deploy completo do desafio com um unico comando: .\deploy.ps1
# Pre-requisitos: Python 3.12, Node.js, AWS CLI v2, CDK CLI e login feito (aws sso login).

$ErrorActionPreference = "Stop"
$raiz = $PSScriptRoot
$stack = "henrick-desafio-1"

function Checar($etapa) {
    if ($LASTEXITCODE -ne 0) { throw "Falha na etapa: $etapa" }
}

try {
    if (-not $env:AWS_PROFILE) {
        throw "Defina o perfil antes: `$env:AWS_PROFILE = 'desafio-1' e rode 'aws sso login'."
    }
    Write-Host "`n[1/5] Ambiente Python da infraestrutura" -ForegroundColor Cyan
    Set-Location "$raiz\infra"
    if (-not (Test-Path .venv)) { python -m venv .venv; Checar "criar o .venv da infra" }
    & .\.venv\Scripts\Activate.ps1
    python -m pip install --quiet --timeout 120 --retries 10 -r requirements.txt uv
    Checar "instalar as dependencias da infra"

    Write-Host "`n[2/5] Pacote do agente (Linux ARM64)" -ForegroundColor Cyan
    Set-Location "$raiz\agent"
    if (Test-Path build) { Remove-Item -Recurse -Force build }
    uv pip install --python-platform aarch64-manylinux2014 --python-version 3.12 --only-binary :all: --target build -r requirements.txt
    Checar "montar o pacote do agente"
    Copy-Item main.py build\

    Write-Host "`n[3/5] Dependencias da Lambda do chat" -ForegroundColor Cyan
    Set-Location "$raiz\api"
    npm ci --omit=dev
    Checar "instalar as dependencias da Lambda do chat"

    Write-Host "`n[4/5] cdk deploy" -ForegroundColor Cyan
    Set-Location "$raiz\infra"
    cdk deploy
    Checar "cdk deploy"

    Write-Host "`n[5/5] Configuracao do frontend" -ForegroundColor Cyan
    $saidas = aws cloudformation describe-stacks --stack-name $stack --query "Stacks[0].Outputs" --output json | ConvertFrom-Json
    Checar "ler os outputs da stack"
    function Saida($chave) { ($saidas | Where-Object OutputKey -eq $chave).OutputValue }

    @(
        "VITE_USER_POOL_ID=$(Saida 'UserPoolId')"
        "VITE_USER_POOL_CLIENT_ID=$(Saida 'AppClientId')"
        "VITE_API_URL=$(Saida 'ApiUrl')"
    ) | Set-Content -Encoding ascii "$raiz\frontend\.env.local"

    Set-Location "$raiz\frontend"
    npm ci
    Checar "instalar as dependencias do frontend"

    Write-Host "`nDeploy concluido. Para abrir o site: cd frontend; npm run dev" -ForegroundColor Green
}
finally {
    Set-Location $raiz
}