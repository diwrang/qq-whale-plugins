param([string]$ArchivePath = '')
$ErrorActionPreference = 'Stop'

# 在备份根目录的 dist 中重建安装包。支持传入已下载的 FFmpeg ZIP。
$backupRoot = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$packages = [ordered]@{
    'qq-whale-extensions' = '1.0.2'
    'qq-whale-signature' = '1.0.0'
    'qq-whale-social' = '1.1.1'
    'qq-whale-video-frames' = '1.0.0'
}

function Assert-SafePath([string]$Path, [string]$Root) {
    $full = [IO.Path]::GetFullPath($Path)
    $base = [IO.Path]::GetFullPath($Root).TrimEnd([IO.Path]::DirectorySeparatorChar)
    if (!$full.Equals($base, [StringComparison]::OrdinalIgnoreCase) -and
        !$full.StartsWith($base + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Path is outside the backup workspace: $full"
    }
    $cursor = $full
    while ($cursor) {
        if (Test-Path -LiteralPath $cursor) {
            $entry = Get-Item -LiteralPath $cursor -Force
            if (($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw "Directory links are not allowed: $cursor"
            }
        }
        $parent = Split-Path -Parent $cursor
        if (!$parent -or $parent -eq $cursor) { break }
        $cursor = $parent
    }
    return $full
}

function Get-SafeFiles([string]$Root) {
    $pending = New-Object 'System.Collections.Generic.Stack[string]'
    $pending.Push($Root)
    while ($pending.Count -gt 0) {
        foreach ($entry in Get-ChildItem -LiteralPath $pending.Pop() -Force) {
            [void](Assert-SafePath $entry.FullName $Root)
            if ($entry.PSIsContainer) {
                if ($entry.Name -notin @('.git', 'node_modules', 'data', 'logs', 'cache', 'dist', '.build')) {
                    $pending.Push($entry.FullName)
                }
            } elseif ($entry.Name -notmatch '^(\.env($|\.)|config\.json$|cookies?\.json$|tokens?\.json$|credentials\.json$|secrets\.json$)' -and
                $entry.Extension -notin @('.log', '.mp4', '.webm', '.rdp')) {
                $entry.FullName
            }
        }
    }
}

# 先核对版本，避免把其他目录误打包。
foreach ($packageName in $packages.Keys) {
    $packageRoot = Assert-SafePath (Join-Path $backupRoot $packageName) $backupRoot
    $manifestPath = Assert-SafePath (Join-Path $packageRoot 'package.json') $packageRoot
    $manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($manifest.name -ne $packageName -or $manifest.version -ne $packages[$packageName]) {
        throw "Unexpected source package or version: $packageName"
    }
}
& (Join-Path $PSScriptRoot 'restore-ffmpeg.ps1') -ArchivePath $ArchivePath

$distRoot = Assert-SafePath (Join-Path $backupRoot 'dist') $backupRoot
$buildRoot = Assert-SafePath (Join-Path $backupRoot '.build') $backupRoot
[IO.Directory]::CreateDirectory($distRoot) | Out-Null
[IO.Directory]::CreateDirectory($buildRoot) | Out-Null
$tempRoot = Assert-SafePath (Join-Path $buildRoot ('build-packages-' + [Guid]::NewGuid().ToString('N'))) $buildRoot
[IO.Directory]::CreateDirectory($tempRoot) | Out-Null
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$checksumLines = New-Object 'System.Collections.Generic.List[string]'
try {
    foreach ($packageName in $packages.Keys) {
        $packageRoot = Assert-SafePath (Join-Path $backupRoot $packageName) $backupRoot
        $archiveName = $packageName + '-v' + $packages[$packageName] + '.zip'
        $temporaryArchive = Assert-SafePath (Join-Path $tempRoot $archiveName) $tempRoot
        $zip = [IO.Compression.ZipFile]::Open($temporaryArchive, [IO.Compression.ZipArchiveMode]::Create)
        try {
            foreach ($sourceFile in @(Get-SafeFiles $packageRoot | Sort-Object)) {
                $relativePath = $sourceFile.Substring($packageRoot.Length + 1).Replace('\', '/')
                # 每个 ZIP 保留包名根目录，解压后可直接运行原安装器。
                [void][IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
                    $zip, $sourceFile, $packageName + '/' + $relativePath, [IO.Compression.CompressionLevel]::Optimal)
            }
        } finally { $zip.Dispose() }
        $destination = Assert-SafePath (Join-Path $distRoot $archiveName) $distRoot
        Move-Item -LiteralPath $temporaryArchive -Destination $destination -Force -ErrorAction Stop
        $checksumLines.Add((Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash.ToLowerInvariant() + ' *' + $archiveName)
        Write-Host "Package: $destination"
    }
    $checksumPath = Assert-SafePath (Join-Path $distRoot 'SHA256SUMS.txt') $distRoot
    [IO.File]::WriteAllLines($checksumPath, $checksumLines.ToArray(), (New-Object Text.UTF8Encoding($false)))
    Write-Host "Checksums: $checksumPath"
} finally {
    if (Test-Path -LiteralPath $tempRoot) {
        $cleanupRoot = Assert-SafePath $tempRoot $buildRoot
        foreach ($entry in Get-ChildItem -LiteralPath $cleanupRoot -Force) {
            [void](Assert-SafePath $entry.FullName $cleanupRoot)
            if ($entry.PSIsContainer) { throw "Unexpected directory in package temporary files: $($entry.FullName)" }
        }
        Remove-Item -LiteralPath $cleanupRoot -Recurse -Force -ErrorAction Stop
    }
}
