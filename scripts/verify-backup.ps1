param()
$ErrorActionPreference = 'Stop'
$backupRoot = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$backupManifest = Get-Content -LiteralPath (Join-Path $backupRoot 'backup-manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$backupCount = 0
foreach ($backupItem in $backupManifest.files) {
    $backupPath = [IO.Path]::GetFullPath((Join-Path $backupRoot $backupItem.path))
    if (!$backupPath.StartsWith($backupRoot.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) {
        throw "Manifest path leaves the backup directory: $($backupItem.path)"
    }
    if (!(Test-Path -LiteralPath $backupPath -PathType Leaf)) {
        throw "Backup file is missing: $($backupItem.path)"
    }
    $backupHash = (Get-FileHash -LiteralPath $backupPath -Algorithm SHA256).Hash
    if ($backupHash -ne $backupItem.sha256) {
        throw "Backup checksum differs: $($backupItem.path)"
    }
    $backupCount++
}
Write-Host "Verified $backupCount backup files."
