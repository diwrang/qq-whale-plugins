param([string]$Target = '')
$ErrorActionPreference = 'Stop'
try {
    if (!$Target) {
        $suggested = Join-Path $env:LOCALAPPDATA 'Programs\QQ Agent'
        $Target = Read-Host "QQ Agent folder (Enter for $suggested)"
        if (!$Target) { $Target = $suggested }
    }
    $Target = [IO.Path]::GetFullPath($Target.Trim('"'))
    if (!(Test-Path -LiteralPath $Target -PathType Container)) { throw 'QQ Agent folder does not exist.' }
    $appRoot = $Target
    $packagedRoot = Join-Path $Target 'resources\app'
    if (Test-Path -LiteralPath (Join-Path $packagedRoot 'src\plugin-loader.js')) { $appRoot = $packagedRoot }
    $loaderFile = Join-Path $appRoot 'src\plugin-loader.js'
    $managerFile = Join-Path $appRoot 'src\skills\manager.js'
    if (!(Test-Path -LiteralPath $loaderFile) -or !(Test-Path -LiteralPath $managerFile)) {
        throw 'This folder is not a QQ Agent installation with the extension API.'
    }
    $loader = [IO.File]::ReadAllText($loaderFile)
    $manager = [IO.File]::ReadAllText($managerFile)
    if (!$loader.Contains('createSkillApi') -or !$manager.Contains('runHook')) {
        throw 'This QQ Agent version does not expose the expected extension API.'
    }
    # Windows PowerShell 5.1 otherwise reads BOM-less UTF-8 as the system ANSI code page.
    $packageText = [IO.File]::ReadAllText((Join-Path $appRoot 'package.json'), [Text.Encoding]::UTF8)
    $package = $packageText | ConvertFrom-Json
    if ($package.type -ne 'module') { throw 'QQ Agent must use ES modules.' }
    $items = @('plugins\whale-relations', 'plugins\whale-owner-controls', 'skills\whale-actions')
    foreach ($item in $items) {
        if (!(Test-Path -LiteralPath (Join-Path $PSScriptRoot "$item\index.js"))) { throw "Missing package file: $item" }
    }
    # Stage complete copies first; only these three extension directories are replaced.
    $stamp = (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [guid]::NewGuid().ToString('N').Substring(0,8)
    $stage = Join-Path $appRoot ".whale-staging-$stamp"
    $dataRoot = Join-Path $Target 'data'
    if ($env:QQ_AGENT_DATA_DIR) { $dataRoot = $env:QQ_AGENT_DATA_DIR }
    elseif ($env:QQ_AGENT_PROFILE -match '^\d+$') { $dataRoot = Join-Path $Target "data-$env:QQ_AGENT_PROFILE" }
    $backup = Join-Path $dataRoot "extension-backups\whale-$stamp"
    foreach ($item in $items) {
        $staged = Join-Path $stage $item
        New-Item -ItemType Directory -Path (Split-Path -Parent $staged) -Force | Out-Null
        Copy-Item -LiteralPath (Join-Path $PSScriptRoot $item) -Destination $staged -Recurse
    }
    $installed = @()
    $moved = @()
    try {
        foreach ($item in $items) {
            $destination = Join-Path $appRoot $item
            New-Item -ItemType Directory -Path (Split-Path -Parent $destination) -Force | Out-Null
            if (Test-Path -LiteralPath $destination) {
                $saved = Join-Path $backup $item
                New-Item -ItemType Directory -Path (Split-Path -Parent $saved) -Force | Out-Null
                Move-Item -LiteralPath $destination -Destination $saved
                $moved += $item
            }
            Move-Item -LiteralPath (Join-Path $stage $item) -Destination $destination
            $installed += $item
        }
    } catch {
        # Preserve failed/new copies for diagnosis, then restore the original folders.
        foreach ($item in $installed) {
            $failed = Join-Path $backup "failed\$item"
            New-Item -ItemType Directory -Path (Split-Path -Parent $failed) -Force | Out-Null
            Move-Item -LiteralPath (Join-Path $appRoot $item) -Destination $failed
        }
        foreach ($item in $moved) { Move-Item -LiteralPath (Join-Path $backup $item) -Destination (Join-Path $appRoot $item) }
        throw
    }
    Write-Host 'Installed: whale-relations, whale-owner-controls (Plugins), whale-actions (Skills).' -ForegroundColor Green
    Write-Host "App:  $appRoot"
    Write-Host "Data: $dataRoot\affection.json"
    Write-Host 'Restart QQ Agent. Check all three extensions in the console.'
    Write-Host 'Keep this package outside QQ Agent. Rerun after an application upgrade.'
    exit 0
} catch {
    Write-Host "Install failed: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}
