$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$projectRoot = Split-Path -Parent $PSScriptRoot
$output = Join-Path $projectRoot 'assets\app'
New-Item -ItemType Directory -Path $output -Force | Out-Null
# Original geometric book monogram; no third-party artwork or font dependency.
$bitmap = New-Object System.Drawing.Bitmap 256, 256
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$graphics.Clear([System.Drawing.Color]::FromArgb(25, 44, 50))
$paper = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(243, 239, 225))
$accent = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(87, 194, 172))
$ink = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(25, 44, 50)), 12
$fold = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(87, 194, 172)), 5
$graphics.FillRectangle($paper, 48, 46, 149, 164)
$graphics.FillRectangle($accent, 48, 46, 14, 164)
$graphics.DrawLine($ink, 86, 87, 163, 87)
$graphics.DrawLine($ink, 163, 87, 86, 163)
$graphics.DrawLine($ink, 86, 163, 163, 163)
$graphics.DrawLine($fold, 74, 192, 182, 192)
$png = Join-Path $output 'icon.png'
$bitmap.Save($png, [System.Drawing.Imaging.ImageFormat]::Png)
$bytes = [System.IO.File]::ReadAllBytes($png)
$stream = [System.IO.File]::Create((Join-Path $output 'icon.ico'))
$writer = New-Object System.IO.BinaryWriter $stream
try {
  $writer.Write([uint16]0); $writer.Write([uint16]1); $writer.Write([uint16]1)
  $writer.Write([byte]0); $writer.Write([byte]0); $writer.Write([byte]0); $writer.Write([byte]0)
  $writer.Write([uint16]1); $writer.Write([uint16]32)
  $writer.Write([uint32]$bytes.Length); $writer.Write([uint32]22); $writer.Write($bytes)
} finally {
  $writer.Dispose(); $stream.Dispose(); $graphics.Dispose(); $bitmap.Dispose()
  $paper.Dispose(); $accent.Dispose(); $ink.Dispose(); $fold.Dispose()
}
Write-Output 'Created original ZiNovel book monogram PNG and ICO.'
