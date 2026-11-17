param(
  [Parameter(Mandatory = $true)][string]$UserPoolId,
  [Parameter(Mandatory = $true)][string]$PaymentsTableName,
  [Parameter(Mandatory = $true)][ValidatePattern('^[^\s@]+@[^\s@]+\.[^\s@]+$')][string]$Email,
  [Parameter(Mandatory = $true)][ValidateRange(0, 1000000)][decimal]$LimitBRL
)
$ErrorActionPreference = 'Stop'
if (-not (Get-Command aws -ErrorAction SilentlyContinue)) { throw 'AWS CLI não foi encontrado.' }
$created = & aws cognito-idp admin-create-user `
  --user-pool-id $UserPoolId `
  --username $Email `
  --user-attributes "Name=email,Value=$Email" "Name=email_verified,Value=true" `
  --desired-delivery-mediums EMAIL `
  --output json
if ($LASTEXITCODE -ne 0) { throw 'Cognito não criou o usuário. Verifique o pool e as permissões.' }
$user = $created | ConvertFrom-Json
$sub = ($user.User.Attributes | Where-Object Name -eq 'sub').Value
if (-not $sub) { throw 'Cognito não retornou o sub do usuário.' }
$profile = @{
  PK = @{ S = "USER#$sub" }
  SK = @{ S = 'PROFILE' }
  entity = @{ S = 'Profile' }
  userId = @{ S = $sub }
  availableLimit = @{ N = $LimitBRL.ToString('0.00', [Globalization.CultureInfo]::InvariantCulture) }
  createdAt = @{ S = [DateTime]::UtcNow.ToString('o') }
} | ConvertTo-Json -Compress -Depth 5
$written = & aws dynamodb put-item `
  --table-name $PaymentsTableName `
  --item $profile `
  --condition-expression 'attribute_not_exists(PK)' `
  --output json
if ($LASTEXITCODE -ne 0) { throw "Usuário $Email foi criado, mas o perfil não foi gravado. O sub é $sub; corrija o perfil antes de liberar o acesso." }
Write-Host "Usuário convidado e limite de R$ $LimitBRL cadastrado no backend."
