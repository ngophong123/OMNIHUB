param([Parameter(Mandatory=$true)][string]$BackupFile)
$ErrorActionPreference = 'Stop'
function Require-Tool([string]$Name, [string]$Override) {
  if ($Override -and (Test-Path -LiteralPath $Override -PathType Leaf)) { return (Resolve-Path -LiteralPath $Override).Path }
  $tool = Get-Command $Name -ErrorAction SilentlyContinue
  if (-not $tool) { throw "$Name is required. Install PostgreSQL client tools or set the corresponding *_PATH variable." }
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
if (-not $env:DATABASE_URL) { throw 'DATABASE_URL is required as the PostgreSQL server connection.' }
$backup = (Resolve-Path -LiteralPath $BackupFile).Path
$checksumFile = "$backup.sha256"
if (-not (Test-Path -LiteralPath $checksumFile -PathType Leaf)) { throw 'Backup SHA-256 sidecar is missing.' }
$expectedHash = (Get-Content -LiteralPath $checksumFile -Raw).Trim().Split(' ')[0].ToLowerInvariant()
$actualHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $backup).Hash.ToLowerInvariant()
if ($actualHash -ne $expectedHash) { throw 'Backup integrity check failed: SHA-256 mismatch.' }
$source = [uri]$env:DATABASE_URL
if ($source.Scheme -notin @('postgres', 'postgresql')) { throw 'DATABASE_URL must use postgres or postgresql.' }
$parts = Read-QueryOptions $source.Query
$sourceName = [uri]::UnescapeDataString($source.AbsolutePath.TrimStart('/'))
$stamp = [DateTime]::UtcNow.ToString('yyyyMMddHHmmss')
$targetName = "omnihub_restore_verify_$stamp"
if ($targetName -eq $sourceName -or $targetName -notmatch '^omnihub_restore_verify_[0-9]{14}$') { throw 'Unsafe isolated target database name.' }
$psql = Require-Tool 'psql' $env:PSQL_PATH
$pgRestore = Require-Tool 'pg_restore' $env:PG_RESTORE_PATH
$old = @{}; foreach ($name in @('PGHOST','PGPORT','PGUSER','PGDATABASE','PGPASSWORD','PGSSLMODE')) { $old[$name] = [Environment]::GetEnvironmentVariable($name, 'Process') }
$oldDatabaseUrl = $env:DATABASE_URL
$timer = [Diagnostics.Stopwatch]::StartNew()
try {
  $env:PGHOST = $source.Host
  $env:PGPORT = if ($source.Port -gt 0) { [string]$source.Port } else { '5432' }
  $env:PGUSER = [uri]::UnescapeDataString($source.UserInfo.Split(':')[0])
  $env:PGPASSWORD = if ($source.UserInfo.Contains(':')) { [uri]::UnescapeDataString($source.UserInfo.Split(':', 2)[1]) } else { '' }
  if ($parts['sslmode']) { $env:PGSSLMODE = $parts['sslmode'] }
  $env:PGDATABASE = 'postgres'
  $exists = & $psql --no-psqlrc --tuples-only --no-align --set ON_ERROR_STOP=1 --command "SELECT 1 FROM pg_database WHERE datname = '$targetName'"
  if ($LASTEXITCODE -ne 0) { throw 'Could not verify isolated restore target availability.' }
  if ($exists) { throw 'Isolated restore target already exists; refusing to modify it.' }
  & $psql --no-psqlrc --set ON_ERROR_STOP=1 --command "CREATE DATABASE `"$targetName`""
  if ($LASTEXITCODE -ne 0) { throw 'Could not create isolated restore database.' }
  $env:PGDATABASE = $targetName
  & $pgRestore --exit-on-error --no-owner --no-acl --dbname $targetName $backup
  if ($LASTEXITCODE -ne 0) { throw "Restore failed. The isolated database $targetName was retained for inspection; it was not dropped." }
  $env:DATABASE_URL = "postgresql://$($source.UserInfo)@$($source.Host):$($env:PGPORT)/$targetName"
  if ($parts['sslmode']) { $env:DATABASE_URL += "?sslmode=$([uri]::EscapeDataString($parts['sslmode']))" }
  Push-Location (Join-Path $PSScriptRoot '..')
  try { pnpm.cmd exec prisma migrate status; if ($LASTEXITCODE -ne 0) { throw 'Prisma migration status failed against the isolated restored database.' } }
  finally { Pop-Location }
  $timer.Stop()
  [pscustomobject]@{ backup = $backup; targetDatabase = $targetName; integrity = 'SHA-256 verified'; restore = 'completed'; migrations = 'prisma migrate status passed'; elapsedSeconds = [Math]::Round($timer.Elapsed.TotalSeconds, 2); cleanup = 'database retained; remove only after explicit review' }
} finally {
  foreach ($name in $old.Keys) { [Environment]::SetEnvironmentVariable($name, $old[$name], 'Process') }
  $env:DATABASE_URL = $oldDatabaseUrl
}
