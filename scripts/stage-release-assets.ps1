[CmdletBinding()]
param(
  [Parameter(Mandatory)]
  [ValidatePattern('^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$')]
  [string]$Version,

  [Parameter(Mandatory)]
  [string]$Destination
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$destinationPath = if ([IO.Path]::IsPathRooted($Destination)) {
  [IO.Path]::GetFullPath($Destination)
} else {
  [IO.Path]::GetFullPath((Join-Path $repoRoot $Destination))
}

$assets = @(
  @{
    Source = Join-Path $repoRoot 'src-tauri/target/release/luma-palette-csp.exe'
    Name = 'Luma.Palette.exe'
  },
  @{
    Source = Join-Path $repoRoot "src-tauri/target/release/bundle/nsis/Luma Palette_${Version}_x64-setup.exe"
    Name = "Luma.Palette_${Version}_x64-setup.exe"
  },
  @{
    Source = Join-Path $repoRoot "src-tauri/target/release/bundle/msi/Luma Palette_${Version}_x64_en-US.msi"
    Name = "Luma.Palette_${Version}_x64_en-US.msi"
  }
)

foreach ($asset in $assets) {
  if (-not (Test-Path -LiteralPath $asset.Source -PathType Leaf)) {
    throw "Expected release asset was not built: $($asset.Source)"
  }
  if ((Get-Item -LiteralPath $asset.Source).Length -eq 0) {
    throw "Release asset is empty: $($asset.Source)"
  }
}

New-Item -ItemType Directory -Force -Path $destinationPath | Out-Null
$expectedNames = $assets.Name
$unexpectedFiles = Get-ChildItem -LiteralPath $destinationPath -File |
  Where-Object { $_.Name -notin $expectedNames }
if ($unexpectedFiles) {
  throw "Asset staging directory contains unexpected files: $($unexpectedFiles.Name -join ', ')"
}

foreach ($asset in $assets) {
  $target = Join-Path $destinationPath $asset.Name
  Copy-Item -LiteralPath $asset.Source -Destination $target -Force
  if ((Get-Item -LiteralPath $target).Length -eq 0) {
    throw "Staged release asset is empty: $target"
  }
}

$stagedNames = Get-ChildItem -LiteralPath $destinationPath -File |
  Select-Object -ExpandProperty Name |
  Sort-Object
if (Compare-Object ($expectedNames | Sort-Object) $stagedNames) {
  throw 'Staged release assets do not match the expected deterministic names.'
}

Write-Output $destinationPath
