<#
.SYNOPSIS
  Package the aglink voice extension as a .vsix and install it into VS Code.

.DESCRIPTION
  A .vsix is a zip with a fixed layout ([Content_Types].xml, an
  extension.vsixmanifest, and the extension under extension/), so this builds
  one directly instead of requiring @vscode/vsce and npm.

  The engine and models are installed separately (installer/); this is only
  the extension.

  Environment variables ELECTRON_RUN_AS_NODE and VSCODE_* are cleared first: a
  shell opened from inside VS Code inherits them, and they make the `code` CLI
  talk to the wrong process or start as plain Node.

.PARAMETER PackageOnly
  Build the .vsix and stop.

.PARAMETER ExtensionsDir
  Install into this extensions directory instead of the user's (for testing a
  package without touching the real VS Code).

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File extension\install.ps1
#>
[CmdletBinding()]
param(
    [switch] $PackageOnly,
    [string] $ExtensionsDir = ''
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

$here = $PSScriptRoot
$pkg = Get-Content -Raw -Encoding UTF8 (Join-Path $here 'package.json') | ConvertFrom-Json
$version = $pkg.version
# Every core module ships: a hand-kept list missed core/numbers.js in 0.5.2
# and the extension failed to load.
$core = Get-ChildItem (Join-Path $here 'core') -Filter *.js | ForEach-Object { 'core/' + $_.Name }
$files = @('package.json', 'extension.js', 'desktoplink.js', 'standalone.js', 'settingsPanel.js', 'hook.js', 'README.md', 'media/aglink-icons.woff') + $core

$out = Join-Path $here "$($pkg.name)-$version.vsix"
if (Test-Path $out) { Remove-Item $out -Force }

function Escape-Xml([string] $s) { [System.Security.SecurityElement]::Escape($s) }

$contentTypes = @'
<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension=".json" ContentType="application/json"/>
  <Default Extension=".js" ContentType="application/javascript"/>
  <Default Extension=".md" ContentType="text/markdown"/>
  <Default Extension=".woff" ContentType="font/woff"/>
  <Default Extension=".vsixmanifest" ContentType="text/xml"/>
</Types>
'@

$manifest = @"
<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011" xmlns:d="http://schemas.microsoft.com/developer/vsx-schema-design/2011">
  <Metadata>
    <Identity Language="en-US" Id="$($pkg.name)" Version="$version" Publisher="$($pkg.publisher)"/>
    <DisplayName>$(Escape-Xml $pkg.displayName)</DisplayName>
    <Description xml:space="preserve">$(Escape-Xml $pkg.description)</Description>
    <Categories>Other</Categories>
    <Properties>
      <Property Id="Microsoft.VisualStudio.Code.Engine" Value="$($pkg.engines.vscode)"/>
      <Property Id="Microsoft.VisualStudio.Code.ExtensionKind" Value="ui"/>
    </Properties>
  </Metadata>
  <Installation>
    <InstallationTarget Id="Microsoft.VisualStudio.Code"/>
  </Installation>
  <Dependencies/>
  <Assets>
    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true"/>
    <Asset Type="Microsoft.VisualStudio.Services.Content.Details" Path="extension/README.md" Addressable="true"/>
  </Assets>
</PackageManifest>
"@

$zip = [System.IO.Compression.ZipFile]::Open($out, [System.IO.Compression.ZipArchiveMode]::Create)
try {
    foreach ($pair in @(@('[Content_Types].xml', $contentTypes), @('extension.vsixmanifest', $manifest))) {
        $entry = $zip.CreateEntry($pair[0])
        $w = New-Object System.IO.StreamWriter($entry.Open(), (New-Object System.Text.UTF8Encoding($false)))
        $w.Write($pair[1])
        $w.Dispose()
    }
    foreach ($f in $files) {
        $src = Join-Path $here $f
        if (-not (Test-Path $src)) { throw "missing $f" }
        [void][System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $src, "extension/$f")
    }
} finally {
    $zip.Dispose()
}
Write-Host "packaged: $out"
if ($PackageOnly) { return }

# A shell opened inside VS Code can carry a VSCODE_* variable with an empty
# value; Remove-Item cannot find such a name and, under 'Stop', aborted the
# whole install. Missing is fine — the point is only that none is left.
foreach ($name in @(Get-ChildItem Env: | Where-Object { $_.Name -match '^(ELECTRON_RUN_AS_NODE|VSCODE_)' } | ForEach-Object Name)) {
    Remove-Item "Env:$name" -ErrorAction SilentlyContinue
}

$code = Join-Path $env:LOCALAPPDATA 'Programs\Microsoft VS Code\bin\code.cmd'
if (-not (Test-Path $code)) { $code = 'code' }
$installArgs = @('--install-extension', $out, '--force')
if ($ExtensionsDir) { $installArgs = @('--extensions-dir', $ExtensionsDir) + $installArgs }
# The exit code decides, not stderr: code.cmd's Node prints deprecation
# warnings there, which Windows PowerShell 5.1 turns into errors under 'Stop'
# and so reported a successful install as a failure.
$ErrorActionPreference = 'Continue'
& $code @installArgs 2>&1 | ForEach-Object { "$_" } | Where-Object { $_ -notmatch 'DeprecationWarning|--trace-deprecation' }
$rc = $LASTEXITCODE
$ErrorActionPreference = 'Stop'
if ($rc -ne 0) { throw "code --install-extension failed ($rc)" }
Write-Host "installed $($pkg.publisher).$($pkg.name) $version"
