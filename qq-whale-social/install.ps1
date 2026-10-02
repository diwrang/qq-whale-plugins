param([string]$Target = '')
$ErrorActionPreference = 'Stop'

function Get-FullPath([string]$Path) {
    return [IO.Path]::GetFullPath($Path).TrimEnd([IO.Path]::DirectorySeparatorChar)
}

function Assert-NoRedirect([string]$Path) {
    $cursor = [IO.Path]::GetFullPath($Path)
    while ($cursor) {
        if (Test-Path -LiteralPath $cursor) {
            $entry = Get-Item -LiteralPath $cursor -Force
            if (($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw "A directory link is not allowed in an installation path: $cursor"
            }
        }
        $parent = Split-Path -Parent $cursor
        if (!$parent -or $parent -eq $cursor) { break }
        $cursor = $parent
    }
}

function Assert-WithinRoot([string]$Path, [string]$Root) {
    $full = Get-FullPath $Path
    $base = Get-FullPath $Root
    $prefix = $base + [IO.Path]::DirectorySeparatorChar
    if (!$full.Equals($base, [StringComparison]::OrdinalIgnoreCase) -and
        !$full.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Path is outside its installation root: $full"
    }
    Assert-NoRedirect $full
    return $full
}

function Assert-PlainTree([string]$Path, [string]$Root) {
    $full = Assert-WithinRoot $Path $Root
    if (!(Test-Path -LiteralPath $full -PathType Container)) { throw "Not a directory: $full" }
    $pending = New-Object 'System.Collections.Generic.Stack[string]'
    $pending.Push($full)
    while ($pending.Count -gt 0) {
        foreach ($entry in Get-ChildItem -LiteralPath $pending.Pop() -Force) {
            if (($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw "A directory link is not allowed in an extension: $($entry.FullName)"
            }
            if ($entry.PSIsContainer) { $pending.Push($entry.FullName) }
        }
    }
}

function Make-Directory([string]$Path, [string]$Root) {
    $full = Assert-WithinRoot $Path $Root
    [IO.Directory]::CreateDirectory($full) | Out-Null
}

function Move-Checked([string]$Source, [string]$SourceRoot, [string]$Destination, [string]$DestinationRoot) {
    $from = Assert-WithinRoot $Source $SourceRoot
    $to = Assert-WithinRoot $Destination $DestinationRoot
    Assert-PlainTree $from $SourceRoot
    if (Test-Path -LiteralPath $to) { throw "Move destination already exists: $to" }
    Move-Item -LiteralPath $from -Destination $to -ErrorAction Stop
}

try {
    if (!$Target) {
        $suggested = Join-Path $env:LOCALAPPDATA 'Programs\QQ Agent'
        $Target = Read-Host "QQ Agent folder (Enter for $suggested)"
        if (!$Target) { $Target = $suggested }
    }
    $Target = Get-FullPath $Target.Trim('"')
    Assert-NoRedirect $Target
    if (!(Test-Path -LiteralPath $Target -PathType Container)) { throw 'QQ Agent folder does not exist.' }
    $appRoot = $Target
    $packagedRoot = Assert-WithinRoot (Join-Path $Target 'resources\app') $Target
    if (Test-Path -LiteralPath (Join-Path $packagedRoot 'src\plugin-loader.js')) { $appRoot = $packagedRoot }
    $loaderFile = Assert-WithinRoot (Join-Path $appRoot 'src\plugin-loader.js') $appRoot
    $managerFile = Assert-WithinRoot (Join-Path $appRoot 'src\skills\manager.js') $appRoot
    $packageFile = Assert-WithinRoot (Join-Path $appRoot 'package.json') $appRoot
    if (!(Test-Path -LiteralPath $loaderFile -PathType Leaf) -or !(Test-Path -LiteralPath $managerFile -PathType Leaf)) {
        throw 'This folder is not a QQ Agent installation with the extension API.'
    }
    $loader = [IO.File]::ReadAllText($loaderFile, [Text.Encoding]::UTF8)
    $manager = [IO.File]::ReadAllText($managerFile, [Text.Encoding]::UTF8)
    if (!$loader.Contains('createSkillApi') -or !$manager.Contains('runHook')) {
        throw 'This QQ Agent version does not expose the expected extension API.'
    }
    # Windows PowerShell 5.1 must explicitly read BOM-less Chinese JSON as UTF-8.
    $packageText = [IO.File]::ReadAllText($packageFile, [Text.Encoding]::UTF8)
    $package = $packageText | ConvertFrom-Json
    if ($package.name -ne 'qq-agent' -or $package.type -ne 'module') { throw 'Expected the qq-agent ES module application.' }

    $item = 'skills\whale-social'
    $source = Assert-WithinRoot (Join-Path $PSScriptRoot $item) $PSScriptRoot
    Assert-PlainTree $source $PSScriptRoot
    $indexFile = Assert-WithinRoot (Join-Path $source 'index.js') $PSScriptRoot
    $manifestFile = Assert-WithinRoot (Join-Path $source 'skill.json') $PSScriptRoot
    if (!(Test-Path -LiteralPath $indexFile -PathType Leaf) -or !(Test-Path -LiteralPath $manifestFile -PathType Leaf)) {
        throw 'The whale-social package is incomplete.'
    }
    $manifest = [IO.File]::ReadAllText($manifestFile, [Text.Encoding]::UTF8) | ConvertFrom-Json
    if ($manifest.id -ne 'whale-social' -or $manifest.apiVersion -ne 1) { throw 'Unexpected whale-social manifest.' }

    $stamp = (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [guid]::NewGuid().ToString('N').Substring(0,8)
    $stage = Assert-WithinRoot (Join-Path $appRoot ".whale-social-staging-$stamp") $appRoot
    $dataRoot = Join-Path $Target 'data'
    if ($env:QQ_AGENT_DATA_DIR) { $dataRoot = $env:QQ_AGENT_DATA_DIR }
    elseif ($env:QQ_AGENT_PROFILE -match '^\d+$') { $dataRoot = Join-Path $Target "data-$env:QQ_AGENT_PROFILE" }
    $dataRoot = Get-FullPath $dataRoot
    Assert-NoRedirect $dataRoot
    $backup = Assert-WithinRoot (Join-Path $dataRoot "extension-backups\whale-social-$stamp") $dataRoot
    $destination = Assert-WithinRoot (Join-Path $appRoot $item) $appRoot
    if (Test-Path -LiteralPath $destination) { Assert-PlainTree $destination $appRoot }
    $staged = Assert-WithinRoot (Join-Path $stage $item) $stage
    Make-Directory (Split-Path -Parent $staged) $stage
    Copy-Item -LiteralPath $source -Destination $staged -Recurse -ErrorAction Stop
    Assert-PlainTree $staged $stage

    $saved = Assert-WithinRoot (Join-Path $backup $item) $backup
    $moved = $false
    $installed = $false
    try {
        Make-Directory (Split-Path -Parent $destination) $appRoot
        if (Test-Path -LiteralPath $destination) {
            Make-Directory (Split-Path -Parent $saved) $backup
            Move-Checked $destination $appRoot $saved $backup
            $moved = $true
        }
        Move-Checked $staged $stage $destination $appRoot
        $installed = $true
    } catch {
        $installError = $_
        # Keep failed copies for diagnosis and restore only this extension.
        if ($installed) {
            $failed = Assert-WithinRoot (Join-Path $backup "failed\$item") $backup
            Make-Directory (Split-Path -Parent $failed) $backup
            Move-Checked $destination $appRoot $failed $backup
        }
        if ($moved) { Move-Checked $saved $backup $destination $appRoot }
        throw $installError
    }
    Write-Host 'Installed: whale-social (Skills).' -ForegroundColor Green
    Write-Host "App:  $appRoot"
    if ($moved) { Write-Host "Previous extension: $saved" }
    Write-Host 'Restart QQ Agent and enable Whale Social in the Skills console.'
    Write-Host 'Keep this package outside QQ Agent. Rerun after an application upgrade.'
    exit 0
} catch {
    Write-Host "Install failed: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}
