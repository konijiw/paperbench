param([string]$Pdf, [string]$PdfJsDirectory, [string]$NodePath, [int]$Port = 18743)
$ErrorActionPreference = 'Stop'
$runtime = Join-Path $env:USERPROFILE '.cache/codex-runtimes/codex-primary-runtime/dependencies/node'
if (-not $NodePath) { $NodePath = Join-Path $runtime 'bin/node.exe' }
if (-not $PdfJsDirectory) { $PdfJsDirectory = Join-Path $runtime 'node_modules/pdfjs-dist' }
if (-not (Test-Path -LiteralPath $NodePath)) { throw '请通过 -NodePath 指定 Node.js。' }
if (-not (Test-Path -LiteralPath (Join-Path $PdfJsDirectory 'build/pdf.mjs'))) { throw '请通过 -PdfJsDirectory 指定 pdfjs-dist 5.6.205 目录。' }
$labArgs = @((Join-Path $PSScriptRoot 'serve.mjs'), '--pdfjs', $PdfJsDirectory, '--port', $Port)
if ($Pdf) { $labArgs += @('--pdf', (Resolve-Path -LiteralPath $Pdf).Path) }
& $NodePath @labArgs
