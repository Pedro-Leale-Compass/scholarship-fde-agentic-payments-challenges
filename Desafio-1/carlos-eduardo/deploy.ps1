$ErrorActionPreference = 'Stop'
$fellow = $PSScriptRoot
$infra = Join-Path $fellow 'infra'
$api = Join-Path $fellow 'api'
$frontend = Join-Path $fellow 'frontend'
$python = Join-Path $fellow '.venv\Scripts\python.exe'

foreach ($command in @('aws', 'cdk', 'docker', 'node', 'npm', 'python')) {
    if (-not (Get-Command $command -ErrorAction SilentlyContinue)) {
        throw "Comando obrigatório não encontrado: $command"
    }
}

$env:AWS_DEFAULT_REGION = 'us-east-1'
$identity = aws sts get-caller-identity --query Account --output text
if ($LASTEXITCODE -ne 0 -or -not $identity) {
    throw 'Não foi possível identificar a conta AWS. Verifique aws configure/SSO.'
}
$env:CDK_DEFAULT_ACCOUNT = $identity
$env:CDK_DEFAULT_REGION = 'us-east-1'

docker info *> $null
if ($LASTEXITCODE -ne 0) {
    throw 'Inicie o Docker Desktop antes de publicar o agente.'
}

if (-not (Test-Path $python)) {
    python -m venv (Join-Path $fellow '.venv')
    if ($LASTEXITCODE -ne 0) { throw 'Não foi possível criar o ambiente Python.' }
}
& $python -m pip install -r (Join-Path $infra 'requirements.txt')
if ($LASTEXITCODE -ne 0) { throw 'Falha ao instalar dependências Python.' }
$env:PATH = "$(Join-Path $fellow '.venv\Scripts');$env:PATH"

if (-not (Test-Path (Join-Path $api 'node_modules'))) {
    npm ci --prefix $api
    if ($LASTEXITCODE -ne 0) { throw 'Falha ao instalar dependências da API.' }
}
if (-not (Test-Path (Join-Path $frontend 'node_modules\.bin\vite.cmd'))) {
    npm install --prefix $frontend
    if ($LASTEXITCODE -ne 0) { throw 'Falha ao instalar dependências do frontend.' }
}
npm run build --prefix $frontend
if ($LASTEXITCODE -ne 0) { throw 'Falha ao compilar o frontend.' }

Push-Location $infra
try {
    cdk bootstrap "aws://$identity/us-east-1"
    if ($LASTEXITCODE -ne 0) { throw 'Falha ao preparar o ambiente CDK.' }
    $stackStatus = aws cloudformation describe-stacks --stack-name fellows-carlos-eduardo --region us-east-1 --query "Stacks[0].StackStatus" --output text 2>$null
    if ($stackStatus -eq 'ROLLBACK_COMPLETE') {
        aws cloudformation delete-stack --stack-name fellows-carlos-eduardo --region us-east-1
        aws cloudformation wait stack-delete-complete --stack-name fellows-carlos-eduardo --region us-east-1
    }
    $outputsPath = Join-Path $fellow 'cdk-outputs.json'
    cdk deploy --require-approval never --outputs-file $outputsPath
    if ($LASTEXITCODE -ne 0) { throw 'Falha no deploy da stack.' }
} finally {
    Pop-Location
}

$outputs = Get-Content $outputsPath -Raw | ConvertFrom-Json
$stack = $outputs.PSObject.Properties['fellows-carlos-eduardo'].Value
if (-not $stack) { throw 'Outputs da stack não encontrados.' }

$env:PRODUCTS_TABLE = $stack.ProductsTable
& $python (Join-Path $fellow 'tools\seed_products.py')
if ($LASTEXITCODE -ne 0) { throw 'Falha ao carregar o catálogo inicial.' }
Remove-Item Env:\PRODUCTS_TABLE

$publicDir = Join-Path $frontend 'public'
if (-not (Test-Path $publicDir)) {
    New-Item -ItemType Directory -Path $publicDir | Out-Null
}
$localConfig = @{
    apiUrl = $stack.ApiUrl
    userPoolId = $stack.UserPoolId
    userPoolClientId = $stack.UserPoolClientId
} | ConvertTo-Json -Compress
$encoding = [System.Text.UTF8Encoding]::new($false)
[System.IO.File]::WriteAllText((Join-Path $publicDir 'config.json'), $localConfig, $encoding)

Write-Host "Deploy concluído: $($stack.CloudFrontUrl)"

