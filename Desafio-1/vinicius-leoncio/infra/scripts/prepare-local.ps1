$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$projects = @('frontend', 'tools', 'api')
foreach ($project in $projects) {
  $projectPath = Join-Path $root $project
  Push-Location $projectPath
  try {
    npm ci
    if ($LASTEXITCODE -ne 0) { throw "npm ci falhou em $project." }
    if ($project -eq 'frontend') {
      npm run build
      if ($LASTEXITCODE -ne 0) { throw 'A exportação do frontend falhou.' }
    }
  } finally {
    Pop-Location
  }
}

& (Join-Path $PSScriptRoot 'prepare-lambdas.ps1')
if ($LASTEXITCODE -ne 0) { throw 'A preparação dos assets das Lambdas falhou.' }

$agent = Join-Path $root 'agent'
$agentBuild = Join-Path $agent 'build'
$site = Join-Path $agentBuild 'site'
if (Test-Path $agentBuild) { Remove-Item -LiteralPath $agentBuild -Recurse -Force }
New-Item -ItemType Directory -Force $site | Out-Null
$uv = Get-Command uv -ErrorAction SilentlyContinue
if (-not $uv) { throw 'Instale o uv para resolver as dependências do agente para Linux ARM64.' }
$previousUvCache = $env:UV_CACHE_DIR
$uvCache = if ($previousUvCache) { $previousUvCache } elseif ($env:TEMP) { Join-Path $env:TEMP 'payments-agent-uv-cache' } else { Join-Path $root '.cache\uv' }
New-Item -ItemType Directory -Force $uvCache | Out-Null
$env:UV_CACHE_DIR = $uvCache
uv pip install --target $site --python-version 3.12 --python-platform aarch64-manylinux2014 --only-binary :all: -r (Join-Path $agent 'requirements.txt')
if ($LASTEXITCODE -ne 0) {
  if ($null -eq $previousUvCache) { Remove-Item Env:UV_CACHE_DIR -ErrorAction SilentlyContinue } else { $env:UV_CACHE_DIR = $previousUvCache }
  throw 'A instalação das dependências Linux ARM64 para o agente falhou.'
}
if ($null -eq $previousUvCache) { Remove-Item Env:UV_CACHE_DIR -ErrorAction SilentlyContinue } else { $env:UV_CACHE_DIR = $previousUvCache }
Copy-Item -LiteralPath (Join-Path $agent 'main.py') -Destination $site
Write-Host "Frontend exportado em $root\frontend\out e agente preparado em $site; o CDK cria o asset no synth."
