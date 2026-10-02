param([string]$ArchivePath = '')
$ErrorActionPreference = 'Stop'

# 锁定依赖版本与校验值。可用 -ArchivePath 从本地 ZIP 离线恢复。
$backupRoot = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$archiveUrl = 'https://www.gyan.dev/ffmpeg/builds/packages/ffmpeg-9.0.2-essentials_build.zip'
$archiveHash = '60F467265B1E312373DBCD92200C2618A74850F98D3D078E94296BB3FA2047BA'
$toolHashes = [ordered]@{
    'ffmpeg.exe' = '3256173F3F8BFFD7DF12227C68ADF68025EDB1832273A9530688A7BB1ED8EDEC'
    'ffprobe.exe' = 'F0D36ECBBDD3BCFAC3EFA078C96C7271C2E68B3810595552AC3B7F17E9A65C52'
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

function Assert-Hash([string]$Path, [string]$Expected) {
    if (!(Test-Path -LiteralPath $Path -PathType Leaf)) { throw "Required file is missing: $Path" }
    $actual = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash
    if ($actual -ne $Expected) { throw "SHA256 verification failed: $Path" }
}

$packageRoot = Assert-SafePath (Join-Path $backupRoot 'qq-whale-video-frames') $backupRoot
if (!(Test-Path -LiteralPath (Join-Path $packageRoot 'package.json') -PathType Leaf)) {
    throw 'The qq-whale-video-frames source package is missing beside scripts.'
}
$binRoot = Assert-SafePath (Join-Path $packageRoot 'plugins\whale-video-frames\bin') $packageRoot

# 已恢复的正确版本可直接复用，后续打包不用重复联网。
if (!$ArchivePath) {
    $alreadyRestored = $true
    foreach ($toolName in $toolHashes.Keys) {
        $toolPath = Assert-SafePath (Join-Path $binRoot $toolName) $packageRoot
        if (!(Test-Path -LiteralPath $toolPath -PathType Leaf) -or
            (Get-FileHash -LiteralPath $toolPath -Algorithm SHA256).Hash -ne $toolHashes[$toolName]) {
            $alreadyRestored = $false
        }
    }
    if ($alreadyRestored) {
        Write-Host "FFmpeg 9.0.2 verified: $binRoot"
        return
    }
}

$buildRoot = Assert-SafePath (Join-Path $backupRoot '.build') $backupRoot
[IO.Directory]::CreateDirectory($buildRoot) | Out-Null
$tempRoot = Assert-SafePath (Join-Path $buildRoot ('restore-ffmpeg-' + [Guid]::NewGuid().ToString('N'))) $buildRoot
[IO.Directory]::CreateDirectory($tempRoot) | Out-Null
$zip = $null
try {
    if ($ArchivePath) {
        $dependencyArchive = (Resolve-Path -LiteralPath $ArchivePath -ErrorAction Stop).ProviderPath
    } else {
        $dependencyArchive = Assert-SafePath (Join-Path $tempRoot 'ffmpeg-9.0.2-essentials_build.zip') $tempRoot
        [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
        Write-Host 'Downloading the pinned FFmpeg 9.0.2 dependency...'
        $ProgressPreference = 'SilentlyContinue'
        Invoke-WebRequest -Uri $archiveUrl -OutFile $dependencyArchive -UseBasicParsing -ErrorAction Stop
    }
    Assert-Hash $dependencyArchive $archiveHash
    Add-Type -AssemblyName System.IO.Compression
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $zip = [IO.Compression.ZipFile]::OpenRead($dependencyArchive)
    foreach ($toolName in $toolHashes.Keys) {
        # 只读取两个固定条目，不展开 ZIP 内其他路径。
        $zipEntry = $zip.GetEntry('ffmpeg-9.0.2-essentials_build/bin/' + $toolName)
        if (!$zipEntry) { throw "Required FFmpeg archive entry is missing: $toolName" }
        $extractedPath = Assert-SafePath (Join-Path $tempRoot $toolName) $tempRoot
        [IO.Compression.ZipFileExtensions]::ExtractToFile($zipEntry, $extractedPath, $false)
        Assert-Hash $extractedPath $toolHashes[$toolName]
    }
    $zip.Dispose()
    $zip = $null
    [IO.Directory]::CreateDirectory($binRoot) | Out-Null
    foreach ($toolName in $toolHashes.Keys) {
        $destination = Assert-SafePath (Join-Path $binRoot $toolName) $packageRoot
        Copy-Item -LiteralPath (Join-Path $tempRoot $toolName) -Destination $destination -Force -ErrorAction Stop
        Assert-Hash $destination $toolHashes[$toolName]
    }
    Write-Host "FFmpeg 9.0.2 restored and verified: $binRoot"
} finally {
    if ($zip) { $zip.Dispose() }
    if (Test-Path -LiteralPath $tempRoot) {
        # 清理前重新检查完整路径以及目录链接，只删除本次新建的临时目录。
        $cleanupRoot = Assert-SafePath $tempRoot $buildRoot
        foreach ($entry in Get-ChildItem -LiteralPath $cleanupRoot -Force) {
            [void](Assert-SafePath $entry.FullName $cleanupRoot)
            if ($entry.PSIsContainer) { throw "Unexpected directory in FFmpeg temporary files: $($entry.FullName)" }
        }
        Remove-Item -LiteralPath $cleanupRoot -Recurse -Force -ErrorAction Stop
    }
}
