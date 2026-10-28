param([string]$Version = 'v0.1.1')
$ErrorActionPreference = 'Stop'
if ($Version -notmatch '^v\d+\.\d+\.\d+(?:-[a-zA-Z0-9.]+)?$') { throw '版本号格式应为 v0.1.1。' }
$project = Split-Path -Parent $MyInvocation.MyCommand.Path
$output = Join-Path $project "dist\$Version"
$package = Join-Path $output 'PaperBench'
if (Test-Path -LiteralPath $package) { throw "打包目录已存在，请先检查：$package" }
New-Item -ItemType Directory -Path $package -Force | Out-Null
& (Join-Path $project 'Build.ps1') -OutputPath (Join-Path $package 'PaperBench.exe')
foreach ($file in @('LICENSE', 'THIRD_PARTY_NOTICES.md', 'README.md')) { Copy-Item -LiteralPath (Join-Path $project $file) -Destination $package }
Copy-Item -LiteralPath (Join-Path $project 'assets\license-notices.txt') -Destination (Join-Path $package 'THIRD_PARTY_LICENSES.txt')
$source = Join-Path $package 'third-party-source'
New-Item -ItemType Directory -Path $source | Out-Null
foreach ($file in @('assets\csl\citeproc.js','assets\csl\WRAPPER-CHANGES.md','assets\csl\CPAL.txt','assets\csl-bundle.js','Build.ps1')) { Copy-Item -LiteralPath (Join-Path $project $file) -Destination $source }
$guide = @"
PaperBench $Version - Windows 便携版

1. 把 ZIP 内的 PaperBench 文件夹整体解压到固定、可写的位置，例如 D:\PaperBench。
2. 运行文件夹中的 PaperBench.exe，阅读界面会在默认浏览器打开。
3. 点击“打开文件夹”选择论文库，再导入 PDF。

运行环境：Windows 10/11、.NET Framework 4.x、现代浏览器。
直接阅读 PDF 无需 Python。AI 对话需配置 Codex CLI，解析需安装 MinerU；
自动从 PDF 提取引用信息需配置 pdftotext。具体步骤见 README.md。

首次运行后，配置和笔记保存在 state 文件夹，附件和笔记图片保存在 attachments，
提示词保存在 prompts；这些文件夹会按需自动创建在 EXE 旁。
论文文件保存在自己选择的论文库内。

拖入 PDF：只拖到左侧论文库。图片请拖入阅读笔记，或 Ctrl+V /“粘贴图片”。
升级：先退出程序，再替换 EXE；保留自己的 state、attachments、prompts 和论文库。
移动到另一台电脑：连同数据文件夹和论文库一起复制，重新选择该电脑的论文库路径。
不要在 ZIP 内直接运行，不要仅把 EXE 拖到下载目录临时使用。

项目与反馈：https://github.com/konijiw/paperbench
许可：LICENSE、THIRD_PARTY_NOTICES.md、THIRD_PARTY_LICENSES.txt。
third-party-source 提供引用引擎及其包装源码，完整应用源码见项目仓库。
"@
[IO.File]::WriteAllText((Join-Path $package '使用说明.txt'), $guide, (New-Object Text.UTF8Encoding($true)))
$archive = Join-Path $output 'PaperBench-Windows.zip'
Compress-Archive -LiteralPath $package -DestinationPath $archive -Force
$checksum = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant() + '  PaperBench-Windows.zip' + "`n"
[IO.File]::WriteAllText((Join-Path $output 'SHA256SUMS.txt'), $checksum, (New-Object Text.UTF8Encoding($false)))
Get-Item -LiteralPath $archive | Select-Object FullName, Length
