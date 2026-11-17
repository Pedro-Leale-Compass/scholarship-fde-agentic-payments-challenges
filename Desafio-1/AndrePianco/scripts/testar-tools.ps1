<#
  Testa as Lambdas das tools direto na AWS (sem agente), cobrindo os cenarios
  de negocio da Fase 1 e a idempotencia do pagamento.

  Uso (na raiz do repo, depois do deploy com --outputs-file infra/cdk-outputs.json):
    .\scripts\testar-tools.ps1 -Perfil seu-perfil

  Cria dois usuarios de teste na tabela Usuarios e os remove no final.
#>
param(
  [string]$Perfil = $env:AWS_PROFILE,
  [string]$Regiao = "us-east-1"
)
$ErrorActionPreference = "Stop"
$saidas = (Get-Content (Join-Path $PSScriptRoot "..\infra\cdk-outputs.json") -Raw | ConvertFrom-Json).AgentePagamentosBackend
$tmp = Join-Path ([IO.Path]::GetTempPath()) "testar-tools"
New-Item -ItemType Directory -Force $tmp | Out-Null
$utf8 = New-Object System.Text.UTF8Encoding $false
$falhas = 0

function Invocar([string]$fn, [hashtable]$evento) {
  $entrada = Join-Path $tmp ("in-" + [guid]::NewGuid() + ".json")
  $saida = Join-Path $tmp ("out-" + [guid]::NewGuid() + ".json")
  [IO.File]::WriteAllText($entrada, ($evento | ConvertTo-Json -Depth 5 -Compress), $utf8)
  aws lambda invoke --function-name $fn --payload "fileb://$entrada" $saida --profile $Perfil --region $Regiao | Out-Null
  return Get-Content $saida -Raw | ConvertFrom-Json
}

function Conferir([string]$nome, [bool]$ok, $detalhe) {
  if ($ok) { Write-Host "  [OK]    $nome" -ForegroundColor Green }
  else { Write-Host "  [FALHA] $nome -> $($detalhe | ConvertTo-Json -Compress -Depth 5)" -ForegroundColor Red; $script:falhas++ }
}

function PutItem([string]$tabela, [hashtable]$item) {
  $arq = Join-Path $tmp ("item-" + [guid]::NewGuid() + ".json")
  [IO.File]::WriteAllText($arq, ($item | ConvertTo-Json -Depth 5 -Compress), $utf8)
  aws dynamodb put-item --table-name $tabela --item "file://$arq" --profile $Perfil --region $Regiao | Out-Null
}

function ChaveUsuario([string]$id) {
  $arq = Join-Path $tmp ("chave-" + [guid]::NewGuid() + ".json")
  [IO.File]::WriteAllText($arq, (@{ user_id = @{ S = $id } } | ConvertTo-Json -Compress), $utf8)
  return "file://$arq"
}

$A = "teste-usuario-a"; $B = "teste-usuario-b"
PutItem $saidas.TabelaUsuarios @{ user_id = @{ S = $A }; nome = @{ S = "Teste A" }; limite_total = @{ N = "1500" }; limite_disponivel = @{ N = "1500" } }
PutItem $saidas.TabelaUsuarios @{ user_id = @{ S = $B }; nome = @{ S = "Teste B" }; limite_total = @{ N = "300" }; limite_disponivel = @{ N = "300" } }

try {
  Write-Host "listar_catalogo"
  $r = Invocar $saidas.FnListarCatalogo @{ user_id = $A; args = @{} }
  Conferir "lista os 6 produtos" ($r.produtos.Count -eq 6) $r
  $r = Invocar $saidas.FnListarCatalogo @{ user_id = $A; args = @{ categoria = "perifericos" } }
  Conferir "filtra por categoria" ($r.produtos.Count -eq 2) $r
  $r = Invocar $saidas.FnListarCatalogo @{ args = @{} }
  Conferir "recusa sem user_id" ($r.erro -eq "ARGUMENTO_INVALIDO") $r

  Write-Host "registrar_intencao"
  $r = Invocar $saidas.FnRegistrarIntencao @{ user_id = $A; args = @{ produto_id = "prod_999"; quantidade = 1 } }
  Conferir "PRODUTO_INVALIDO" ($r.erro -eq "PRODUTO_INVALIDO") $r
  $r = Invocar $saidas.FnRegistrarIntencao @{ user_id = $A; args = @{ produto_id = "prod_001"; quantidade = 0 } }
  Conferir "quantidade invalida" ($r.erro -eq "ARGUMENTO_INVALIDO") $r
  $r = Invocar $saidas.FnRegistrarIntencao @{ user_id = $A; args = @{ produto_id = "prod_004"; quantidade = 99 } }
  Conferir "ESTOQUE_INSUFICIENTE" ($r.erro -eq "ESTOQUE_INSUFICIENTE") $r
  $i1 = Invocar $saidas.FnRegistrarIntencao @{ user_id = $A; args = @{ produto_id = "prod_003"; quantidade = 2 } }
  Conferir "intencao criada com valor do banco (2 x 189.50 = 379)" ($i1.status -eq "pendente" -and $i1.valor_total -eq 379 -and $i1.intencao_id -match '^int_[0-9a-f]{6}$') $i1

  Write-Host "realizar_compra"
  $r = Invocar $saidas.FnRealizarCompra @{ user_id = $A; args = @{ intencao_id = "int_000000"; metodo_pagamento = "pix" } }
  Conferir "INTENCAO_INVALIDA (id inexistente)" ($r.erro -eq "INTENCAO_INVALIDA") $r
  $r = Invocar $saidas.FnRealizarCompra @{ user_id = $B; args = @{ intencao_id = $i1.intencao_id; metodo_pagamento = "pix" } }
  Conferir "INTENCAO_INVALIDA (intencao de outro usuario)" ($r.erro -eq "INTENCAO_INVALIDA") $r
  $r = Invocar $saidas.FnRealizarCompra @{ user_id = $A; args = @{ intencao_id = $i1.intencao_id; metodo_pagamento = "boleto" } }
  Conferir "METODO_INVALIDO" ($r.erro -eq "METODO_INVALIDO") $r
  $r = Invocar $saidas.FnRealizarCompra @{ user_id = $A; args = @{ intencao_id = $i1.intencao_id; metodo_pagamento = "cartao" } }
  Conferir "compra com cartao aprovada (limite 1500 -> 1121)" ($r.status -eq "aprovado" -and $r.limite_restante -eq 1121 -and $r.metodo_pagamento -eq "cartao") $r
  $r = Invocar $saidas.FnRealizarCompra @{ user_id = $A; args = @{ intencao_id = $i1.intencao_id; metodo_pagamento = "cartao" } }
  Conferir "INTENCAO_JA_PAGA (mesma chamada de novo)" ($r.erro -eq "INTENCAO_JA_PAGA") $r

  $i2 = Invocar $saidas.FnRegistrarIntencao @{ user_id = $A; args = @{ produto_id = "prod_001"; quantidade = 1 } }
  $r = Invocar $saidas.FnRealizarCompra @{ user_id = $A; args = @{ intencao_id = $i2.intencao_id; metodo_pagamento = "pix" } }
  Conferir "compra com pix aprovada (1121 - 249.90 = 871.10)" ($r.status -eq "aprovado" -and $r.limite_restante -eq 871.1 -and $r.metodo_pagamento -eq "pix") $r

  $i3 = Invocar $saidas.FnRegistrarIntencao @{ user_id = $B; args = @{ produto_id = "prod_004"; quantidade = 1 } }
  $r = Invocar $saidas.FnRealizarCompra @{ user_id = $B; args = @{ intencao_id = $i3.intencao_id; metodo_pagamento = "pix" } }
  Conferir "LIMITE_EXCEDIDO (1899 > 300)" ($r.erro -eq "LIMITE_EXCEDIDO") $r

  # Intencao vencida gravada direto no banco (o TTL real e 300s).
  $idVencida = "int_" + -join ((1..6) | ForEach-Object { '{0:x}' -f (Get-Random -Max 16) })
  PutItem $saidas.TabelaIntencoes @{
    intencao_id = @{ S = $idVencida }; user_id = @{ S = $A }; produto_id = @{ S = "prod_003" }; produto_nome = @{ S = "Mouse Vertical Ergo" }
    quantidade = @{ N = "1" }; valor_total = @{ N = "189.5" }; moeda = @{ S = "BRL" }; status = @{ S = "pendente" }
    criada_em = @{ S = "2020-01-01T00:00:00.000Z" }; expira_em = @{ S = "2020-01-01T00:05:00.000Z" }
  }
  $r = Invocar $saidas.FnRealizarCompra @{ user_id = $A; args = @{ intencao_id = $idVencida; metodo_pagamento = "pix" } }
  Conferir "INTENCAO_EXPIRADA" ($r.erro -eq "INTENCAO_EXPIRADA") $r

  Write-Host "idempotencia: 5 pagamentos simultaneos da mesma intencao"
  $i4 = Invocar $saidas.FnRegistrarIntencao @{ user_id = $A; args = @{ produto_id = "prod_005"; quantidade = 1 } }
  $entrada = Join-Path $tmp "concorrente.json"
  [IO.File]::WriteAllText($entrada, (@{ user_id = $A; args = @{ intencao_id = $i4.intencao_id; metodo_pagamento = "cartao" } } | ConvertTo-Json -Compress), $utf8)
  $jobs = 1..5 | ForEach-Object {
    $out = Join-Path $tmp "conc-$_.json"
    Start-Job -ScriptBlock { param($fn, $in, $out, $p, $reg) aws lambda invoke --function-name $fn --payload "fileb://$in" $out --profile $p --region $reg | Out-Null; Get-Content $out -Raw } -ArgumentList $saidas.FnRealizarCompra, $entrada, $out, $Perfil, $Regiao
  }
  $resultados = $jobs | Wait-Job | Receive-Job | ForEach-Object { $_ | ConvertFrom-Json }
  $jobs | Remove-Job
  $aprovadas = @($resultados | Where-Object { $_.status -eq "aprovado" }).Count
  $jaPagas = @($resultados | Where-Object { $_.erro -eq "INTENCAO_JA_PAGA" }).Count
  Conferir "exatamente 1 aprovada e 4 INTENCAO_JA_PAGA (aprovadas=$aprovadas, ja_pagas=$jaPagas)" ($aprovadas -eq 1 -and $jaPagas -eq 4) $resultados

  $u = aws dynamodb get-item --table-name $saidas.TabelaUsuarios --key (ChaveUsuario $A) --consistent-read --profile $Perfil --region $Regiao | ConvertFrom-Json
  $limiteFinal = [double]$u.Item.limite_disponivel.N
  Conferir "limite debitado uma unica vez (871.10 - 329.90 = 541.20; atual $limiteFinal)" ([math]::Abs($limiteFinal - 541.2) -lt 0.001) $u.Item
}
finally {
  foreach ($id in $A, $B) {
    aws dynamodb delete-item --table-name $saidas.TabelaUsuarios --key (ChaveUsuario $id) --profile $Perfil --region $Regiao | Out-Null
  }
  Remove-Item -Recurse -Force $tmp
}

if ($falhas -gt 0) { Write-Host "`n$falhas teste(s) falharam." -ForegroundColor Red; exit 1 }
Write-Host "`nTodos os testes passaram." -ForegroundColor Green
