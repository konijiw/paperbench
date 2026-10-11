# AI 辅助文献阅读器

一个面向 MinerU 解析结果的本地论文阅读器，在同一界面中组合 Markdown、原始 PDF、批注与 Codex 对话。

## 主要功能

- 递归发现 MinerU 论文目录，浏览渲染后的 Markdown、公式、表格和图片。
- 原始 PDF 默认折叠，可随时展开并拖动调整宽度。
- 阅读笔记和文字批注位于 Markdown 与 AI 对话之间。
- 最右侧集成 Codex 风格对话，支持流式回复、Markdown、KaTeX 公式、工具活动、图片、模型与只读权限选择。
- 每篇论文自动绑定独立对话，并将论文目录作为 Codex 工作区。
- 可把 Markdown 文字选区或本地论文图片放入 AI 对话。
- 内置只读 `paper_workspace` 工具；即使 Windows 原生命令沙箱暂时不可用，Codex 仍能安全读取当前论文的 Markdown 和其他文本文件。
- 支持自定义论文标题、多标签分类、标签管理、收藏与最近阅读。

Codex 通过本机 `codex app-server` 运行，复用当前电脑上的 ChatGPT/Codex 登录，不需要 API Key。默认模型是 `gpt-6-luna`，默认文件权限为只读。

阅读状态、批注和应用设置保存在程序旁的本地目录：

```text
state/ai-literature-reader/
```

程序不会主动修改 PDF、Markdown 或论文图片。

## 环境要求

- Windows 10/11
- .NET Framework 4.x（用于构建与运行）
- 已安装并登录 Codex CLI；AI 对话复用本机账号，不要求另购 API Key
- 论文目录中包含 MinerU 生成的 `markdown.md`、图片及对应 PDF

## 构建与运行

在 PowerShell 中进入项目目录后执行：

```powershell
& .\Build.ps1
& ..\AI辅助文献阅读器.exe
```

首次启动后，通过“打开文件夹”选择论文库根目录。

## 隐私与数据边界

- 论文、PDF、图片、批注和阅读状态都只保存在本机，不属于本仓库内容。
- `.gitignore` 默认排除 `state/`、`output/`、可执行文件、日志和常见本地配置文件。
- 发布或提交前仍建议检查暂存文件，避免误提交个人论文及阅读记录。

## 第三方组件

Codex 对话界面基于 `zotero-codex` 的 MIT 许可源码；Marked、DOMPurify、MathJax 与 KaTeX 随程序分发。对应许可证保存在 `assets/` 目录。

项目自身的开源许可证将在公开发布前确定。
