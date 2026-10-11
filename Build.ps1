$ErrorActionPreference = 'Stop'

$projectDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path
$appDirectory = Split-Path -Parent $projectDirectory
$compilerCandidates = @(
    "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\csc.exe",
    "$env:WINDIR\Microsoft.NET\Framework\v4.0.30319\csc.exe"
)
$compiler = $compilerCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if (-not $compiler) { throw '未找到 .NET Framework C# 编译器。' }

$assets = Join-Path $projectDirectory 'assets'
$output = Join-Path $appDirectory 'AI辅助文献阅读器.exe'
$source = Join-Path $projectDirectory 'MinerULibraryReview.cs'

$arguments = @(
    '/nologo',
    '/target:winexe',
    '/optimize+',
    '/platform:anycpu',
    "/out:$output",
    '/reference:System.dll',
    '/reference:System.Core.dll',
    '/reference:System.Web.dll',
    '/reference:System.Web.Extensions.dll',
    '/reference:System.Drawing.dll',
    '/reference:System.Windows.Forms.dll',
    "/resource:$(Join-Path $assets 'app.html'),AppHtml",
    "/resource:$(Join-Path $assets 'app.css'),AppCss",
    "/resource:$(Join-Path $assets 'app.js'),AppJs",
    "/resource:$(Join-Path $assets 'marked.umd.js'),MarkedJs",
    "/resource:$(Join-Path $assets 'purify.min.js'),PurifyJs",
    "/resource:$(Join-Path $assets 'mathjax-config.js'),MathJaxConfigJs",
    "/resource:$(Join-Path $assets 'mathjax-tex-svg-full.js'),MathJaxJs",
    "/resource:$(Join-Path $assets 'codex-sidebar\protocol.js'),ZcsProtocolJs",
    "/resource:$(Join-Path $assets 'codex-sidebar\markdown.js'),ZcsMarkdownJs",
    "/resource:$(Join-Path $assets 'codex-sidebar\sidebar.js'),ZcsSidebarJs",
    "/resource:$(Join-Path $assets 'codex-sidebar\style.css'),ZcsStyleCss",
    "/resource:$(Join-Path $assets 'codex-sidebar\katex.min.js'),ZcsKatexJs",
    "/resource:$(Join-Path $assets 'codex-sidebar\katex.min.css'),ZcsKatexCss",
    "/resource:$(Join-Path $assets 'ai-client.js'),AiClientJs",
    "/resource:$(Join-Path $assets 'ai-chat.js'),AiChatJs",
    $source
)

$fontDirectory = Join-Path $assets 'codex-sidebar\fonts'
Get-ChildItem -LiteralPath $fontDirectory -Filter '*.woff2' | ForEach-Object {
    $arguments += "/resource:$($_.FullName),ZcsFont_$($_.Name)"
}

& $compiler $arguments
if ($LASTEXITCODE -ne 0) { throw "编译失败，退出代码：$LASTEXITCODE" }
Get-Item -LiteralPath $output | Select-Object FullName, Length, LastWriteTime
