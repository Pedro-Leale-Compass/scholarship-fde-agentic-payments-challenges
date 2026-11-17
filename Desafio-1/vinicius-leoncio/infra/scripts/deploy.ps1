param(
  [Parameter(Mandatory = $true)][string]$Profile,
  [Parameter(Mandatory = $true)][ValidatePattern('^[^\s@]+@[^\s@]+\.[^\s@]+$')][string]$BudgetAlertEmail,
  [switch]$DeployFrontend
)

$ErrorActionPreference = 'Stop'
$region = 'us-east-1'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$infraPath = Join-Path $repoRoot 'infra'

if (-not (Get-Command aws -ErrorAction SilentlyContinue)) { throw 'Instale o AWS CLI v2.' }
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) { throw 'Instale Node.js e npm.' }

$env:AWS_PROFILE = $Profile
$env:AWS_DEFAULT_REGION = $region
$env:CDK_DEFAULT_REGION = $region

aws sts get-caller-identity --profile $Profile --region $region --no-cli-pager
if ($LASTEXITCODE -ne 0) { throw 'Não foi possível validar o perfil AWS. Execute aws sso login antes do deploy.' }

& (Join-Path $PSScriptRoot 'prepare-local.ps1')
if ($LASTEXITCODE -ne 0) { throw 'A preparação local do frontend, das Lambdas ou do agente falhou.' }

Push-Location $infraPath
try {
  npm ci
  if ($LASTEXITCODE -ne 0) { throw 'npm ci falhou na pasta infra.' }

  npm run build
  if ($LASTEXITCODE -ne 0) { throw 'A compilação do CDK falhou.' }

  $cdkArgs = @(
    'deploy', '--all', '--profile', $Profile,
    '--parameters', "ViniciusPaymentsBudget:BudgetAlertEmail=$BudgetAlertEmail"
  )
  if ($DeployFrontend) { $cdkArgs += @('--context', 'deployFrontend=true') }

  npx cdk @cdkArgs
  if ($LASTEXITCODE -ne 0) { throw 'O deploy CDK falhou. Consulte os eventos do CloudFormation antes de tentar novamente.' }
} finally {
  Pop-Location
}

Write-Host 'Deploy concluído. Consulte os outputs da stack ViniciusPaymentsSprint2 para configurar o frontend local ou acessar a URL publicada.'
