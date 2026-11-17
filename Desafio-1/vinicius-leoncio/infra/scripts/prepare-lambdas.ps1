$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path

foreach ($project in @('tools', 'api')) {
  $projectPath = Join-Path $root $project
  Push-Location $projectPath
  try {
    $tsc = Join-Path $projectPath 'node_modules\.bin\tsc.cmd'
    & $tsc --project tsconfig.lambda.json
    if ($LASTEXITCODE -ne 0) { throw "A compilação da Lambda falhou em $project." }

    $bundle = Join-Path $projectPath 'build\lambda'
    $manifest = if ($project -eq 'tools') { Join-Path $projectPath 'lambda' } else { $projectPath }
    Copy-Item -LiteralPath (Join-Path $manifest 'package.json') -Destination $bundle -Force
    Copy-Item -LiteralPath (Join-Path $manifest 'package-lock.json') -Destination $bundle -Force
    npm ci --omit=dev --prefix $bundle
    if ($LASTEXITCODE -ne 0) { throw "A instalação das dependências de produção falhou em $project." }
  } finally {
    Pop-Location
  }
}

Write-Host 'Assets das Lambdas preparados em tools/build/lambda e api/build/lambda.'
