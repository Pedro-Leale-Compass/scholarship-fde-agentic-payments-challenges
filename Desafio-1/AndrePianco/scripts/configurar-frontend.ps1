<#
  Gera frontend/.env.local a partir das saidas do deploy (infra/cdk-outputs.json).
  Nenhum valor e segredo (user pool id, client id publico e URL da API), mas
  o arquivo e ignorado pelo git porque muda a cada ambiente.

  Uso (na raiz do repo): .\scripts\configurar-frontend.ps1
#>
$ErrorActionPreference = "Stop"
$raiz = Split-Path $PSScriptRoot -Parent
$saidas = (Get-Content (Join-Path $raiz "infra\cdk-outputs.json") -Raw | ConvertFrom-Json).AgentePagamentosBackend

$conteudo = @"
VITE_USER_POOL_ID=$($saidas.UserPoolId)
VITE_USER_POOL_CLIENT_ID=$($saidas.UserPoolClientId)
VITE_API_URL=$($saidas.ApiUrl)
"@
$destino = Join-Path $raiz "frontend\.env.local"
[IO.File]::WriteAllText($destino, $conteudo, (New-Object System.Text.UTF8Encoding $false))
Write-Host "Gerado $destino"
