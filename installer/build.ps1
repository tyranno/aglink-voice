<#
.SYNOPSIS
  Build the two setup files: aglink-voice-setup-<ver>.exe (everything, CPU
  recognition) and aglink-voice-gpu-<ver>.exe (the NVIDIA add-on).

.DESCRIPTION
  Stages what the setup installs into installer\stage, then runs NSIS 3
  (makensis) on aglink-voice.nsi. Output goes to dist\.

  The models and whisper.cpp builds are not in git. -Root points at a folder
  laid out the way the engine reads it (links are followed):
    models\ggml-small.bin, models\ecapa.onnx,
    models\supertonic\{onnx,voice_styles,LICENSE},
    whisper\cpu\whisper-server.exe + DLLs, whisper\cuda\... (the same, CUDA)

  The Visual C++ runtime DLLs whisper.cpp and ONNX Runtime need are copied
  next to them (app-local), so a PC without the VC++ redistributable works.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File installer\build.ps1
#>
[CmdletBinding()]
param(
    [string] $Root = (Join-Path $env:USERPROFILE '.aglink\voice-build\root'),
    [string] $MakeNsis = '',
    [switch] $StageOnly
)

$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot
$repo = Split-Path $here
$stage = Join-Path $here 'stage'
$base = Join-Path $stage 'base'
$gpu = Join-Path $stage 'gpu'
$dist = Join-Path $repo 'dist'

$version = (Get-Content -Raw -Encoding UTF8 (Join-Path $repo 'extension\package.json') | ConvertFrom-Json).version

if (-not $MakeNsis) {
    $MakeNsis = @(
        (Join-Path $env:USERPROFILE '.aglink\tools\nsis-3.11\makensis.exe'),
        "${env:ProgramFiles(x86)}\NSIS\makensis.exe",
        "$env:ProgramFiles\NSIS\makensis.exe"
    ) | Where-Object { Test-Path $_ } | Where-Object { (& $_ -VERSION) -match '^v3' } | Select-Object -First 1
    if (-not $MakeNsis -and -not $StageOnly) { throw 'NSIS 3 (makensis.exe) not found; pass -MakeNsis' }
}

function Copy-Files([string] $from, [string] $to, [string[]] $names) {
    New-Item -ItemType Directory -Force $to | Out-Null
    foreach ($n in $names) {
        $items = Get-ChildItem -Path $from -Filter $n -File
        if (-not $items) { throw "missing: $from\$n" }
        foreach ($i in $items) { Copy-Item $i.FullName $to -Force }
    }
}

# robocopy follows links (supertonic is a link in the dev root). 0-7 is success.
function Copy-Tree([string] $from, [string] $to, [string[]] $exclude = @()) {
    $xf = if ($exclude) { @('/XF') + $exclude } else { @() }
    & robocopy $from $to /E /NFL /NDL /NJH /NJS /NP @xf | Out-Null
    if ($LASTEXITCODE -ge 8) { throw "robocopy $from failed ($LASTEXITCODE)" }
}

$vcRuntime = @('msvcp140.dll', 'msvcp140_1.dll', 'msvcp140_2.dll', 'vcruntime140.dll', 'vcruntime140_1.dll', 'vcomp140.dll')
$whisperFiles = @('whisper-server.exe', 'whisper.dll', 'ggml.dll', 'ggml-base.dll', 'ggml-cpu-*.dll')

if (Test-Path $stage) { Remove-Item -Recurse -Force $stage }

Write-Host 'engine'
& dotnet publish (Join-Path $repo 'engine\AglinkVoiceEngine.csproj') -c Release -o (Join-Path $base 'engine') --nologo -v quiet
if ($LASTEXITCODE) { throw 'dotnet publish failed' }
Get-ChildItem (Join-Path $base 'engine') -Filter *.pdb | Remove-Item
Copy-Files "$env:WINDIR\System32" (Join-Path $base 'engine') $vcRuntime

Write-Host 'extension'
& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $repo 'extension\install.ps1') -PackageOnly | Out-Null
if ($LASTEXITCODE) { throw 'extension package failed' }
Copy-Item (Join-Path $repo "extension\aglink-voice-$version.vsix") (Join-Path $base 'aglink-voice.vsix')

Write-Host 'models'
Copy-Files (Join-Path $Root 'models') (Join-Path $base 'models') @('ggml-small.bin', 'ecapa.onnx')
Copy-Tree (Join-Path $Root 'models\supertonic\onnx') (Join-Path $base 'models\supertonic\onnx')
Copy-Tree (Join-Path $Root 'models\supertonic\voice_styles') (Join-Path $base 'models\supertonic\voice_styles')
Copy-Item (Join-Path $repo 'engine\LICENSE-Supertonic') (Join-Path $base 'models\supertonic\LICENSE')

Write-Host 'whisper'
Copy-Files (Join-Path $Root 'whisper\cpu') (Join-Path $base 'whisper\cpu') $whisperFiles
Copy-Files "$env:WINDIR\System32" (Join-Path $base 'whisper\cpu') $vcRuntime
Copy-Files (Join-Path $Root 'whisper\cuda') (Join-Path $gpu 'whisper\cuda') ($whisperFiles + @('ggml-cuda.dll', 'cublas64_12.dll', 'cublasLt64_12.dll', 'cudart64_12.dll'))
Copy-Files "$env:WINDIR\System32" (Join-Path $gpu 'whisper\cuda') $vcRuntime

foreach ($d in $base, $gpu) {
    $mb = [math]::Round(((Get-ChildItem $d -Recurse -File | Measure-Object Length -Sum).Sum) / 1MB)
    Write-Host ("staged {0}: {1} MB" -f (Split-Path $d -Leaf), $mb)
}
if ($StageOnly) { return }

New-Item -ItemType Directory -Force $dist | Out-Null
foreach ($kind in 'base', 'gpu') {
    Write-Host "makensis $kind"
    $defs = @("/DVERSION=$version", "/DSTAGE=$stage", "/DOUTDIR=$dist")
    if ($kind -eq 'gpu') { $defs += '/DGPU' }
    & $MakeNsis /V2 @defs (Join-Path $here 'aglink-voice.nsi')
    if ($LASTEXITCODE) { throw "makensis $kind failed" }
}
Get-ChildItem $dist -Filter "*-$version.exe" | ForEach-Object { Write-Host ("{0}  {1} MB" -f $_.Name, [math]::Round($_.Length / 1MB)) }
