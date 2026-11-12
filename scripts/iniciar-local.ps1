<#
.SYNOPSIS
  Inicia o RemoteX localmente no Windows: servidor (API + sinalização + app web) e RemoteX Host.

.DESCRIPTION
  Lê as variáveis de .env.local (criado por scripts\instalar-windows.ps1), abre o servidor em uma
  janela própria, espera ele responder em /api/health e então abre o RemoteX Host.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\iniciar-local.ps1
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\iniciar-local.ps1 -SoServidor
#>
[CmdletBinding()]
param(
  [switch]$SoServidor,
  [switch]$SoHost
)

$ErrorActionPreference = 'Stop'
$raiz = Split-Path -Parent $PSScriptRoot
Set-Location $raiz

$arquivoEnv = Join-Path $raiz '.env.local'
if (-not (Test-Path $arquivoEnv)) { throw '.env.local não encontrado. Execute antes: powershell -ExecutionPolicy Bypass -File scripts\instalar-windows.ps1' }
foreach ($linha in Get-Content $arquivoEnv) {
  if ($linha -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$') {
    $nome = $Matches[1]
    # Segredos do instalador não vão para o ambiente dos processos.
    if ($nome -in @('POSTGRES_SUPERUSER_PASSWORD', 'REMOTEX_DB_PASSWORD')) { continue }
    Set-Item -Path "Env:\$nome" -Value $Matches[2].Trim()
  }
}
if (-not $env:PORT) { $env:PORT = '8080' }
$urlLocal = "http://127.0.0.1:$($env:PORT)"

if (-not $SoHost) {
  if (-not (Test-Path 'dist/server/server.js')) {
    Write-Host '==> Compilando o servidor e o app web' -ForegroundColor Cyan
    & npm.cmd run build
    if ($LASTEXITCODE -ne 0) { throw 'npm run build falhou.' }
  }

  $servico = Get-Service -Name 'postgresql*' -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($servico -and $servico.Status -ne 'Running') {
    Write-Host "==> Iniciando o PostgreSQL ($($servico.Name))" -ForegroundColor Cyan
    try { Start-Service $servico.Name } catch { Write-Host "    Não consegui iniciar o serviço sem administrador: $($_.Exception.Message)" -ForegroundColor Yellow }
  }

  Write-Host "==> Servidor RemoteX em $urlLocal (janela separada)" -ForegroundColor Cyan
  # A nova janela herda DATABASE_URL, JWT_SECRET e PORT desta sessão.
  $null = Start-Process -FilePath 'node' -ArgumentList 'dist/server/server.js' -WorkingDirectory $raiz -PassThru

  $pronto = $false
  for ($i = 0; $i -lt 60 -and -not $pronto; $i++) {
    Start-Sleep -Milliseconds 500
    try { $null = Invoke-RestMethod -Uri "$urlLocal/api/health" -TimeoutSec 2; $pronto = $true } catch { }
  }
  if (-not $pronto) { throw 'O servidor não respondeu em 30 s. Veja a mensagem de erro na janela do servidor.' }
  Write-Host '    servidor no ar' -ForegroundColor Green

  try {
    Get-NetIPAddress -AddressFamily IPv4 -ErrorAction Stop |
      Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' } |
      ForEach-Object { Write-Host "    no celular (mesma Wi-Fi): http://$($_.IPAddress):$($env:PORT)" }
  } catch { }
}

if (-not $SoServidor) {
  Write-Host '==> Abrindo o RemoteX Host' -ForegroundColor Cyan
  if (-not $env:REMOTEX_SERVER) { $env:REMOTEX_SERVER = $urlLocal }
  & npm.cmd --prefix windows-host start
}
