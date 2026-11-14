param(
  [string]$BackupDirectory = (Join-Path $PSScriptRoot '..\.local\backups'),
  [ValidateRange(0, 3650)][int]$RetentionDays = 30
)
$ErrorActionPreference = 'Stop'

function Require-Tool([string]$Name, [string]$Override) {
  if ($Override -and (Test-Path -LiteralPath $Override -PathType Leaf)) { return (Resolve-Path -LiteralPath $Override).Path }
  $tool = Get-Command $Name -ErrorAction SilentlyContinue
  if (-not $tool) { throw "$Name is required. Install PostgreSQL client tools or set $($Name.ToUpperInvariant())_PATH." }
  return $tool.Source
}
function Read-QueryOptions([string]$query) {
  $options = @{}
  foreach ($part in $query.TrimStart('?').Split('&', [StringSplitOptions]::RemoveEmptyEntries)) {
    $pair = $part.Split('=', 2)
    $options[[uri]::UnescapeDataString($pair[0])] = if ($pair.Length -gt 1) { [uri]::UnescapeDataString($pair[1]) } else { '' }
  }
  return $options
}

if (-not $env:DATABASE_URL) { throw 'DATABASE_URL is required.' }
$connection = [uri]$env:DATABASE_URL
if ($connection.Scheme -notin @('postgres', 'postgresql')) { throw 'DATABASE_URL must use postgres or postgresql.' }
$parts = Read-QueryOptions $connection.Query
$databaseName = [uri]::UnescapeDataString($connection.AbsolutePath.TrimStart('/'))
if (-not $databaseName) { throw 'DATABASE_URL must include a database name.' }
$pgDump = Require-Tool 'pg_dump' $env:PG_DUMP_PATH
$pgRestore = Require-Tool 'pg_restore' $env:PG_RESTORE_PATH
$old = @{}; foreach ($name in @('PGHOST','PGPORT','PGUSER','PGDATABASE','PGPASSWORD','PGSSLMODE')) { $old[$name] = [Environment]::GetEnvironmentVariable($name, 'Process') }
try {
  $env:PGHOST = $connection.Host
  $env:PGPORT = if ($connection.Port -gt 0) { [string]$connection.Port } else { '5432' }
  $env:PGUSER = [uri]::UnescapeDataString($connection.UserInfo.Split(':')[0])
  $env:PGPASSWORD = if ($connection.UserInfo.Contains(':')) { [uri]::UnescapeDataString($connection.UserInfo.Split(':', 2)[1]) } else { '' }
  $env:PGDATABASE = $databaseName
  if ($parts['sslmode']) { $env:PGSSLMODE = $parts['sslmode'] }
  $directory = [System.IO.Path]::GetFullPath($BackupDirectory)
  New-Item -ItemType Directory -Force -Path $directory | Out-Null
  $stamp = [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssZ')
  $backup = Join-Path $directory "omnihub-$stamp.dump"
  & $pgDump --format=custom --no-owner --no-acl --file $backup --host $env:PGHOST --port $env:PGPORT --username $env:PGUSER --dbname $env:PGDATABASE
  if ($LASTEXITCODE -ne 0) { throw "pg_dump failed with exit code $LASTEXITCODE." }
  & $pgRestore --list $backup | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'pg_restore could not read the generated backup.' }
  $hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $backup).Hash.ToLowerInvariant()
  Set-Content -LiteralPath "$backup.sha256" -Value "$hash  $(Split-Path -Leaf $backup)" -NoNewline
  if ($RetentionDays -gt 0) {
    $cutoff = [DateTime]::UtcNow.AddDays(-$RetentionDays)
    Get-ChildItem -LiteralPath $directory -File -Filter 'omnihub-*.dump' | Where-Object { $_.LastWriteTimeUtc -lt $cutoff } | ForEach-Object {
      Remove-Item -LiteralPath $_.FullName
      Remove-Item -LiteralPath "$($_.FullName).sha256" -ErrorAction SilentlyContinue
    }
  }
  [pscustomobject]@{ backup = $backup; sha256 = $hash; integrity = 'pg_restore --list passed'; retentionDays = $RetentionDays }
} finally {
  foreach ($name in $old.Keys) { [Environment]::SetEnvironmentVariable($name, $old[$name], 'Process') }
}
