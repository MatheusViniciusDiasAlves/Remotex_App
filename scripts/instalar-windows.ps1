<#
.SYNOPSIS
  Instala no Windows tudo o que o RemoteX precisa para rodar e desenvolver localmente.

.DESCRIPTION
  Usa o winget (Gerenciador de Pacotes do Windows) para instalar o que faltar:
    - Git
    - Node.js LTS (>= 20)
    - PostgreSQL 16
  Depois baixa o projeto (se ainda não estiver nele), instala as dependências npm do servidor e
  do RemoteX Host, cria o usuário/banco "remotex_local" no PostgreSQL, gera o arquivo .env.local com
  DATABASE_URL e JWT_SECRET, compila tudo, aplica as migrações e libera a porta 8080 no
  Firewall (rede privada) para o celular conectar pela Wi-Fi.

  Pode ser executado de novo sem problemas: o que já estiver instalado/configurado é mantido.

.EXAMPLE
  # Dentro da pasta do projeto:
  powershell -ExecutionPolicy Bypass -File scripts\instalar-windows.ps1

.EXAMPLE
  # Sem ter o projeto ainda (baixa em %USERPROFILE%\Remotex_App):
  # (o arquivo tem BOM UTF-8 para o Windows PowerShell 5.1 ler os acentos; o irm o mantém, daí o TrimStart)
  & ([scriptblock]::Create((irm https://raw.githubusercontent.com/MatheusViniciusDiasAlves/Remotex_App/claude/laughing-fermi-nok1jq/scripts/instalar-windows.ps1).TrimStart([char]0xFEFF)))

.EXAMPLE
  # Com ferramentas extras (Android Studio + JDK 17 e Docker Desktop):
  powershell -ExecutionPolicy Bypass -File scripts\instalar-windows.ps1 -ComAndroid -ComDocker
#>
[CmdletBinding()]
param(
  # Pasta do projeto (usada só quando o script não é executado de dentro do projeto).
  [string]$Pasta = (Join-Path $HOME 'Remotex_App'),
  # Branch clonado quando o projeto ainda não existe.
  [string]$Branch = 'claude/laughing-fermi-nok1jq',
  [string]$Repositorio = 'https://github.com/MatheusViniciusDiasAlves/Remotex_App.git',
  # Senha do superusuário "postgres". Se o PostgreSQL for instalado agora e ela não for informada,
  # uma senha aleatória é gerada e guardada em .env.local. Se o PostgreSQL já existir, é perguntada.
  [string]$SenhaPostgres = '',
  # Instala também Android Studio + JDK 17 (para gerar o APK com ./gradlew).
  [switch]$ComAndroid,
  # Instala também o Docker Desktop (para o docker compose de deploy/).
  [switch]$ComDocker,
  # Não cria a regra de Firewall para a porta 8080.
  [switch]$SemFirewall,
  # Só instala os programas; não mexe no projeto nem no banco.
  [switch]$SoProgramas
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

$NodeMinimo = 20
$PortaServidor = 8080

# ---------------------------------------------------------------------------------------------
# Utilitários
# ---------------------------------------------------------------------------------------------
function Write-Etapa([string]$Texto) { Write-Host ''; Write-Host "==> $Texto" -ForegroundColor Cyan }
function Write-Ok([string]$Texto) { Write-Host "    OK  $Texto" -ForegroundColor Green }
function Write-Aviso([string]$Texto) { Write-Host "    !!  $Texto" -ForegroundColor Yellow }

function Test-Comando([string]$Nome) { return [bool](Get-Command $Nome -ErrorAction SilentlyContinue) }

function Update-PathDaSessao {
  # Programas recém-instalados alteram o PATH do sistema; traz as mudanças para esta janela.
  $maquina = [Environment]::GetEnvironmentVariable('Path', 'Machine')
  $usuario = [Environment]::GetEnvironmentVariable('Path', 'User')
  $env:Path = (@($maquina, $usuario) | Where-Object { $_ }) -join ';'
}

function Invoke-Nativo {
  # Executa um programa externo e falha se o código de saída não for 0.
  param([Parameter(Mandatory)][string]$Programa, [string[]]$Argumentos = @(), [string]$Descricao = $Programa)
  & $Programa @Argumentos
  if ($LASTEXITCODE -ne 0) { throw "$Descricao falhou (código $LASTEXITCODE)." }
}

function New-Segredo([int]$Bytes = 32) {
  $buffer = New-Object byte[] $Bytes
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  try { $rng.GetBytes($buffer) } finally { $rng.Dispose() }
  return -join ($buffer | ForEach-Object { $_.ToString('x2') })
}

function Test-Admin {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  return (New-Object Security.Principal.WindowsPrincipal $id).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Test-PacoteWinget([string]$Id) {
  $ErrorActionPreference = 'Continue'
  $null = winget list --id $Id -e --accept-source-agreements 2>$null
  return ($LASTEXITCODE -eq 0)
}

function Install-PacoteWinget {
  param([Parameter(Mandatory)][string]$Id, [Parameter(Mandatory)][string]$Nome, [string]$Override = '')
  if (Test-PacoteWinget $Id) { Write-Ok "$Nome já instalado"; return $false }
  Write-Host "    instalando $Nome ($Id)... o Windows pode pedir permissão de administrador."
  $argumentos = @('install', '--id', $Id, '-e', '--silent', '--accept-package-agreements', '--accept-source-agreements')
  if ($Override) { $argumentos += @('--override', $Override) }
  & winget @argumentos
  # -1978335189 (0x8A15002B): nada a atualizar / já instalado.
  if ($LASTEXITCODE -ne 0 -and $LASTEXITCODE -ne -1978335189) { throw "Falha ao instalar $Nome pelo winget (código $LASTEXITCODE)." }
  Update-PathDaSessao
  Write-Ok "$Nome instalado"
  return $true
}

function Get-VersaoNode {
  if (-not (Test-Comando 'node')) { return 0 }
  $v = (& node -v) -replace '^v', ''
  return [int]($v.Split('.')[0])
}

function Find-Psql {
  $cmd = Get-Command 'psql' -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  $candidatos = Get-ChildItem -Path "$env:ProgramFiles\PostgreSQL\*\bin\psql.exe" -ErrorAction SilentlyContinue |
    Sort-Object { [int]($_.Directory.Parent.Name -replace '[^0-9].*$', '') } -Descending
  if ($candidatos) { return $candidatos[0].FullName }
  return $null
}

function Read-EnvLocal([string]$Arquivo) {
  $valores = @{}
  if (Test-Path $Arquivo) {
    foreach ($linha in Get-Content $Arquivo) {
      if ($linha -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$') { $valores[$Matches[1]] = $Matches[2].Trim() }
    }
  }
  return $valores
}

function Write-ArquivoUtf8([string]$Arquivo, [string]$Conteudo) {
  [System.IO.File]::WriteAllText($Arquivo, $Conteudo, (New-Object System.Text.UTF8Encoding $false))
}

# ---------------------------------------------------------------------------------------------
# 1. Programas
# ---------------------------------------------------------------------------------------------
Write-Host 'RemoteX — instalação no Windows' -ForegroundColor White

if ([Environment]::OSVersion.Platform -ne 'Win32NT') { throw 'Este script é para Windows. No Linux use scripts/instalar-linux.sh.' }

Write-Etapa 'Verificando o winget'
if (-not (Test-Comando 'winget')) {
  Write-Aviso 'O winget não foi encontrado. Instale o "Instalador de Aplicativo" (App Installer) pela Microsoft Store:'
  Write-Aviso '  https://apps.microsoft.com/detail/9NBLGGH4NNS1  — depois execute este script de novo.'
  try { Start-Process 'ms-windows-store://pdp/?productid=9NBLGGH4NNS1' } catch { }
  throw 'winget ausente.'
}
Write-Ok 'winget disponível'

Write-Etapa 'Git'
if (Test-Comando 'git') { Write-Ok ("Git já instalado (" + ((& git --version) -replace 'git version ', '') + ')') }
else { $null = Install-PacoteWinget -Id 'Git.Git' -Nome 'Git' }

Write-Etapa "Node.js (>= $NodeMinimo)"
$versaoNode = Get-VersaoNode
if ($versaoNode -ge $NodeMinimo) { Write-Ok ("Node.js já instalado (" + (& node -v) + ')') }
else {
  if ($versaoNode -gt 0) { Write-Aviso "Node.js $versaoNode é antigo; instalando a versão LTS." }
  $null = Install-PacoteWinget -Id 'OpenJS.NodeJS.LTS' -Nome 'Node.js LTS'
  if ((Get-VersaoNode) -lt $NodeMinimo) { throw 'Node.js instalado, mas não aparece nesta janela. Feche o PowerShell, abra outro e execute o script de novo.' }
}

Write-Etapa 'PostgreSQL 16'
$psql = Find-Psql
$postgresInstaladoAgora = $false
if ($psql) { Write-Ok "PostgreSQL já instalado ($psql)" }
else {
  if (-not $SenhaPostgres) { $SenhaPostgres = New-Segredo 12 }
  $null = Install-PacoteWinget -Id 'PostgreSQL.PostgreSQL.16' -Nome 'PostgreSQL 16' `
    -Override "--mode unattended --unattendedmodeui none --superpassword $SenhaPostgres --serverport 5432"
  $postgresInstaladoAgora = $true
  $psql = Find-Psql
}
if (-not $psql) { throw 'Não encontrei o psql.exe depois de instalar o PostgreSQL (procurei em Arquivos de Programas\PostgreSQL).' }

if ($ComAndroid) {
  Write-Etapa 'Android (JDK 17 + Android Studio)'
  $null = Install-PacoteWinget -Id 'EclipseAdoptium.Temurin.17.JDK' -Nome 'JDK 17 (Temurin)'
  $null = Install-PacoteWinget -Id 'Google.AndroidStudio' -Nome 'Android Studio'
  Write-Aviso 'Abra o Android Studio uma vez e conclua o assistente (ele baixa o Android SDK).'
  Write-Aviso 'Depois: abra a pasta android-app no Android Studio, ou rode  cd android-app; .\gradlew.bat assembleDebug'
}

if ($ComDocker) {
  Write-Etapa 'Docker Desktop'
  if ((Install-PacoteWinget -Id 'Docker.DockerDesktop' -Nome 'Docker Desktop')) {
    Write-Aviso 'O Docker Desktop usa o WSL 2 e pode pedir para reiniciar o Windows.'
  }
}

if ($SoProgramas) {
  Write-Host ''
  if ($postgresInstaladoAgora) { Write-Aviso "Senha do usuário 'postgres' do PostgreSQL: $SenhaPostgres  (anote)" }
  Write-Host 'Programas instalados. Execute de novo sem -SoProgramas para preparar o projeto.' -ForegroundColor Green
  return
}

# ---------------------------------------------------------------------------------------------
# 2. Projeto
# ---------------------------------------------------------------------------------------------
Write-Etapa 'Projeto RemoteX'
$raiz = $null
if ($PSScriptRoot) {
  $candidato = Split-Path -Parent $PSScriptRoot
  if ((Test-Path (Join-Path $candidato 'package.json')) -and (Test-Path (Join-Path $candidato 'windows-host'))) { $raiz = $candidato }
}
if (-not $raiz -and (Test-Path (Join-Path (Get-Location) 'windows-host')) -and (Test-Path (Join-Path (Get-Location) 'package.json'))) {
  $raiz = (Get-Location).Path
}
if (-not $raiz) {
  if (Test-Path (Join-Path $Pasta '.git')) {
    Write-Ok "Projeto já baixado em $Pasta"
  }
  else {
    Write-Host "    baixando $Repositorio ($Branch) para $Pasta"
    Invoke-Nativo -Programa 'git' -Argumentos @('clone', '--branch', $Branch, $Repositorio, $Pasta) -Descricao 'git clone'
  }
  $raiz = (Resolve-Path $Pasta).Path
}
Set-Location $raiz
Write-Ok "Pasta do projeto: $raiz"

Write-Etapa 'Dependências npm (servidor e app web)'
Invoke-Nativo -Programa 'npm.cmd' -Argumentos @('ci', '--no-audit', '--no-fund') -Descricao 'npm ci'
Write-Ok 'node_modules da raiz'

Write-Etapa 'Dependências npm (RemoteX Host / Electron)'
Invoke-Nativo -Programa 'npm.cmd' -Argumentos @('--prefix', 'windows-host', 'ci', '--no-audit', '--no-fund') -Descricao 'npm ci (windows-host)'
# Garante o binário do Electron (o postinstall às vezes não baixa, ex.: atrás de proxy).
Invoke-Nativo -Programa 'node' -Argumentos @('windows-host/node_modules/electron/install.js') -Descricao 'download do Electron'
if (-not (Test-Path 'windows-host/node_modules/electron/dist/electron.exe')) { throw 'O Electron não foi baixado (windows-host/node_modules/electron/dist/electron.exe ausente).' }
Write-Ok 'Electron pronto'

# ---------------------------------------------------------------------------------------------
# 3. Banco de dados
# ---------------------------------------------------------------------------------------------
Write-Etapa 'Banco de dados "remotex_local"'
$arquivoEnv = Join-Path $raiz '.env.local'
$envAtual = Read-EnvLocal $arquivoEnv
if (-not $SenhaPostgres -and $envAtual.ContainsKey('POSTGRES_SUPERUSER_PASSWORD')) { $SenhaPostgres = $envAtual['POSTGRES_SUPERUSER_PASSWORD'] }

$servico = Get-Service -Name 'postgresql*' -ErrorAction SilentlyContinue | Select-Object -First 1
if ($servico -and $servico.Status -ne 'Running') {
  Write-Host "    iniciando o serviço $($servico.Name)"
  try { Start-Service $servico.Name } catch { Write-Aviso "Não consegui iniciar $($servico.Name) sem administrador: $($_.Exception.Message)" }
}

$senhaBanco = if ($envAtual['REMOTEX_DB_PASSWORD']) { $envAtual['REMOTEX_DB_PASSWORD'] } else { New-Segredo 16 }
$jwt = if ($envAtual['JWT_SECRET']) { $envAtual['JWT_SECRET'] } else { New-Segredo 32 }

function Invoke-Sql([string]$Sql, [string]$Banco = 'postgres') {
  $ErrorActionPreference = 'Continue'   # no PowerShell 5.1, 2>&1 com 'Stop' interromperia aqui
  $env:PGPASSWORD = $SenhaPostgres
  $saida = & $psql -h 127.0.0.1 -p 5432 -U postgres -d $Banco -v ON_ERROR_STOP=1 -q -t -A -c $Sql 2>&1
  $codigo = $LASTEXITCODE
  Remove-Item Env:\PGPASSWORD -ErrorAction SilentlyContinue
  if ($codigo -ne 0) { throw "psql: $saida" }
  return ($saida | Out-String).Trim()
}

$conectou = $false
for ($tentativa = 1; $tentativa -le 3 -and -not $conectou; $tentativa++) {
  if (-not $SenhaPostgres) {
    $seguro = Read-Host "Senha do usuário 'postgres' do PostgreSQL já instalado" -AsSecureString
    $SenhaPostgres = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($seguro))
  }
  try { $null = Invoke-Sql 'SELECT 1'; $conectou = $true }
  catch {
    $msg = $_.Exception.Message
    if ($msg -match 'password authentication failed|autentica') { Write-Aviso 'Senha incorreta.'; $SenhaPostgres = '' }
    elseif ($tentativa -lt 3) { Write-Aviso "Aguardando o PostgreSQL ficar pronto... ($msg)"; Start-Sleep -Seconds 5 }
    else { throw "Não consegui conectar ao PostgreSQL em 127.0.0.1:5432: $msg" }
  }
}
if (-not $conectou) { throw 'Não consegui conectar ao PostgreSQL com o usuário postgres. Rode de novo com -SenhaPostgres "sua-senha".' }

# Senha só com [0-9a-f] (gerada acima ou lida do .env.local); seguro dentro de aspas simples do SQL.
if ($senhaBanco -notmatch '^[0-9a-fA-F]+$') { $senhaBanco = New-Segredo 16 }
# Usuário/banco próprios do app local (o usuário "remotex" fica livre para os scripts de teste).
if ((Invoke-Sql "SELECT 1 FROM pg_roles WHERE rolname = 'remotex_local'") -eq '1') {
  $null = Invoke-Sql "ALTER ROLE remotex_local WITH LOGIN PASSWORD '$senhaBanco'"
  Write-Ok 'usuário remotex_local atualizado'
}
else {
  $null = Invoke-Sql "CREATE ROLE remotex_local WITH LOGIN PASSWORD '$senhaBanco'"
  Write-Ok 'usuário remotex_local criado'
}
if ((Invoke-Sql "SELECT 1 FROM pg_database WHERE datname = 'remotex_local'") -eq '1') { Write-Ok 'banco remotex_local já existe' }
else { $null = Invoke-Sql 'CREATE DATABASE remotex_local OWNER remotex_local'; Write-Ok 'banco remotex_local criado' }

$conteudoEnv = @"
# Gerado por scripts/instalar-windows.ps1 — NÃO versionar (está no .gitignore).
# Lido por scripts/iniciar-local.ps1.
DATABASE_URL=postgres://remotex_local:$senhaBanco@127.0.0.1:5432/remotex_local
JWT_SECRET=$jwt
PORT=$PortaServidor
REMOTEX_DB_PASSWORD=$senhaBanco
POSTGRES_SUPERUSER_PASSWORD=$SenhaPostgres
"@
Write-ArquivoUtf8 $arquivoEnv ($conteudoEnv -replace "`r`n", "`n")
Write-Ok '.env.local gravado (DATABASE_URL, JWT_SECRET, PORT)'

# ---------------------------------------------------------------------------------------------
# 4. Build e migrações
# ---------------------------------------------------------------------------------------------
Write-Etapa 'Compilando servidor, app web e RemoteX Host'
Invoke-Nativo -Programa 'npm.cmd' -Argumentos @('run', 'build') -Descricao 'npm run build'
Invoke-Nativo -Programa 'npm.cmd' -Argumentos @('--prefix', 'windows-host', 'run', 'build') -Descricao 'build do RemoteX Host'
Write-Ok 'build concluído'

Write-Etapa 'Migrações do banco'
$env:DATABASE_URL = "postgres://remotex_local:$senhaBanco@127.0.0.1:5432/remotex_local"
try { Invoke-Nativo -Programa 'node' -Argumentos @('dist/server/migrate.js') -Descricao 'migrações' }
finally { Remove-Item Env:\DATABASE_URL -ErrorAction SilentlyContinue }
Write-Ok 'banco atualizado'

# ---------------------------------------------------------------------------------------------
# 5. Firewall (celular na mesma Wi-Fi)
# ---------------------------------------------------------------------------------------------
if (-not $SemFirewall) {
  Write-Etapa "Firewall: porta $PortaServidor (rede privada)"
  $nomeRegra = "RemoteX servidor (TCP $PortaServidor)"
  if (Get-NetFirewallRule -DisplayName $nomeRegra -ErrorAction SilentlyContinue) { Write-Ok 'regra já existe' }
  else {
    $comando = "New-NetFirewallRule -DisplayName '$nomeRegra' -Direction Inbound -Protocol TCP -LocalPort $PortaServidor -Action Allow -Profile Private | Out-Null"
    try {
      if (Test-Admin) { Invoke-Expression $comando }
      else { Start-Process powershell -Verb RunAs -Wait -WindowStyle Hidden -ArgumentList @('-NoProfile', '-Command', $comando) }
      if (Get-NetFirewallRule -DisplayName $nomeRegra -ErrorAction SilentlyContinue) { Write-Ok 'regra criada' }
      else { Write-Aviso 'A regra não foi criada (permissão negada?). O Windows perguntará na primeira execução do servidor.' }
    }
    catch { Write-Aviso "Não foi possível criar a regra: $($_.Exception.Message)" }
  }
}

# ---------------------------------------------------------------------------------------------
# Resumo
# ---------------------------------------------------------------------------------------------
$ips = @()
try {
  $ips = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction Stop |
    Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' } |
    Select-Object -ExpandProperty IPAddress
} catch { }

Write-Host ''
Write-Host '============================================================' -ForegroundColor Green
Write-Host ' RemoteX pronto para uso local' -ForegroundColor Green
Write-Host '============================================================' -ForegroundColor Green
Write-Host " Pasta:     $raiz"
Write-Host ' Iniciar:   powershell -ExecutionPolicy Bypass -File scripts\iniciar-local.ps1'
Write-Host '            (abre o servidor e o RemoteX Host)'
foreach ($ip in $ips) { Write-Host " Celular:   http://${ip}:$PortaServidor  (mesma Wi-Fi; também em Ajustes > Servidor no app)" }
Write-Host ' Testes:    npm test'
if ($postgresInstaladoAgora) {
  Write-Host ''
  Write-Aviso "Senha do usuário 'postgres' do PostgreSQL: $SenhaPostgres  (também guardada em .env.local)"
}
