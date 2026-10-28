# PaperBench

把 **论文原文、解析正文、阅读笔记和 AI 对话**放在一起的 Windows 本地论文阅读器。

适合需要对照原文精读、反复追问方法和图表，并持续积累阅读笔记的研究者和学生。

**推荐搭配 [MinerU](https://github.com/opendatalab/MinerU) 使用：** 将 PDF 解析为 Markdown 和图片后，可以一边核对原文，一边选中文字批注、翻译和讨论。没有 MinerU 时，也能直接导入 PDF 开始阅读。

**下载 Windows 版：** [PaperBench 便携 ZIP 包](https://github.com/konijiw/paperbench/releases/latest/download/PaperBench-Windows.zip) · [版本说明](https://github.com/konijiw/paperbench/releases/latest)

## 可以做什么

- **对照阅读：** PDF 与 MinerU 解析正文并排显示，阅读区域可调整、折叠。
- **整理文献：** 批量导入 PDF，按标题、标签、收藏、阅读状态和加入时间查找论文；支持模糊搜索和内容重复检查。
- **记笔记、做批注：** 保存整篇笔记，对 Markdown 原文选区添加批注和 AI 翻译；支持拖入正文图片、本地图片，或粘贴截图，纯 PDF 论文也能记图文笔记。
- **边读边问 AI：** 在论文旁与 Codex 对话，发送原文选区或图片，继续已有讨论。
- **使用自己的提示词：** 在对话中随时调用、编辑和增删预设，例如“系统精读”“实际做到了什么”“对我的研究有什么启示”。所有预设同等管理，不分区。
- **关联支撑材料：** 将支撑论文、PDF、视频、ZIP 和数据文件关联到正文；支持播放浏览器可解码的视频和 ZIP 内的视频。
- **管理引用、导出资料：** 识别或手动填写书目信息，生成 BibTeX、LaTeX 引用及 Word 参考文献，导出论文与阅读笔记资料包。

导出阅读资料时，可勾选 **“包含关联 AI 对话”**，将当前电脑上可读取的相关对话整理为 Markdown 档案，附索引与可用图片。不勾选时保持原有导出方式；缺失历史不会阻断论文和笔记导出。档案用于独立阅读，不用于恢复 Codex 会话。

## 快速开始

### 1. 启动程序

需要 **Windows 10/11 和 .NET Framework 4.x**。

运行 `PaperBench.exe`，程序会启动本机服务，并在默认浏览器中打开阅读界面。

从上方下载 ZIP 包，将里面的 **`PaperBench` 文件夹整体解压**到可写的位置（例如 `D:\PaperBench`），再运行文件夹里的 `PaperBench.exe`。无需下载源码或安装 Python 即可使用基础阅读功能，请勿直接在压缩包内运行。

首次运行后，程序会在这个文件夹内自动创建 `state/`、`attachments/`、`prompts/`，保存配置、笔记、附件和提示词；论文文件保存在你选择的论文库。升级时先退出旧程序，只替换程序文件，保留自己的数据文件夹和论文库。

AI 对话需另行安装并登录 Codex CLI；PDF 解析需另行安装 MinerU；自动从 PDF 提取引用信息需配置 `pdftotext`。这些是可选功能，不影响直接导入 PDF 阅读。开发者也可按下方的 [从源码构建](#从源码构建) 生成 EXE。

### 2. 选择论文库

点击右上角的 **“打开文件夹”**，选择一个用于存放论文的文件夹。之后可以：

- 将 PDF 拖到左侧论文库，直接复制入库；图片请拖到阅读笔记。
- 点击 **“导入论文 PDF”**，从不同文件夹累计选取文件，再批量导入。
- 打开已有的 MinerU 解析结果目录。

导入会保留原文件，为每篇论文建立独立目录。同名文件会自动避让；重复检查依据 PDF 文件内容，不只比较文件名。

### 3. 开始阅读

从左侧选择论文，即可阅读 PDF、记录整篇笔记、设置标签和阅读状态。

| 论文内容 | 可用的阅读方式 |
| --- | --- |
| 只有 PDF | 直接阅读 PDF，保存整篇笔记，使用 AI 对话 |
| PDF 与 MinerU 解析结果 | PDF／Markdown 对照阅读，增加原文选区批注、翻译和摘录功能 |

目前文字选区批注和 AI 翻译作用于 **Markdown 正文**；PDF 区域使用浏览器内置阅读器。

## 推荐搭配 MinerU

MinerU 负责将论文解析为 Markdown、图片和结构化内容，PaperBench 负责阅读、整理和讨论。

### 在 PaperBench 中解析

1. 按照 [MinerU 官方安装说明](https://opendatalab.github.io/MinerU/quick_start/)安装 **MinerU 4.x**。
2. 打开一篇尚未解析的 PDF，点击阅读区右下角的 **“解析 PDF”**。
3. 如果显示 **“选择 MinerU”**，选择安装时创建的 `.venv` 文件夹或其上级目录。系统 Python 安装也可选择包含相应 Python 与 `mineru-kit` 的目录。
4. 解析完成后，Markdown 和图片会加入当前论文目录，随后可进行对照阅读。

程序也兼容原有的 `runtime/venv` 安装目录。MinerU 和模型需要用户自行安装；首次解析时，MinerU 可能下载模型。旧版 MinerU 的命令与接口不同，不在当前官方安装兼容范围内。

### 使用已有解析结果

已有结果可放入论文库，每篇论文单独一个文件夹，例如：

```text
论文库/
└─ 示例论文/
   ├─ source.pdf
   ├─ markdown.md
   ├─ structured_content.json
   └─ images/
```

PaperBench 识别的正文文件名是 `markdown.md`。如果已有解析结果采用其他文件名或多层输出结构，请整理为上述布局，并保持正文中的相对图片路径有效；保留原始结果副本。

## 配置 AI 阅读

AI 功能通过本机 **Codex CLI** 工作，需要单独安装并登录；基础阅读和笔记功能不依赖它。

1. 按照 [Codex CLI 官方说明](https://developers.openai.com/codex/cli)完成安装和登录。
2. 打开 PaperBench 的 AI 侧栏。
3. 如果没有自动找到 Codex，在侧栏设置中填写其可执行文件路径并重新连接。

对话中可以随时打开输入框旁的 **“预设”**。选中的提示词会先填入输入框，你可以补充问题后再发送；已有草稿会保留。所有预设都可以修改或删除，也可以新增自己的预设。“整理学习笔记”会直接在聊天区输出，不创建文件。

论文和阅读记录保存在本机。使用 AI 时，相关内容会根据请求发送给所使用的服务处理；引用检索也需要联网。本机 MinerU 解析不使用官网云解析服务。

## 附件与引用

点击论文标题旁的 **“附件”**，可以关联已有 MinerU 支撑材料，也可以将其他文件复制到独立附件目录后关联。有附件的论文会显示展开箭头。

视频在阅读区域播放并支持全屏；代码、Word、数据文件和不含可播放视频的 ZIP 会打开其所在文件夹，方便用其他软件处理。

点击顶部 **“引用”**，可以识别文献信息，也可以输入 DOI 或导入 BibTeX，并生成引用与参考文献。

PDF 自动文本提取需要额外的 `pdftotext`。缺少它时仍可手动填写 DOI 或导入 BibTeX。Windows 用户可参考 [Poppler 预编译包说明](https://github.com/oschwartz10612/poppler-windows)，将 `pdftotext.exe` 及配套依赖放入程序旁的 `tools/`，或将工具目录加入 PATH。

更多导入、批注、引用、导出和回收站行为，见 [详细使用说明](docs/USAGE.md)。

## 数据保存与跨电脑同步

程序文件可以更新，自己的论文和阅读数据请单独保留。

| 内容 | 保存位置 |
| --- | --- |
| 论文 PDF、Markdown 和图片 | 你选择的论文库 |
| 阅读笔记、批注、标签、收藏与阅读状态 | `state/ai-literature-reader/papers/` |
| 书目信息与引用键 | `state/ai-literature-reader/citations/` |
| 论文加入时间记录 | `state/ai-literature-reader/paper-added/` |
| 附件副本及关联关系 | `attachments/` |
| 粘贴截图、拖入本地图片的笔记图片 | `attachments/_note-images/` |
| 提示词预设 | `prompts/` |

上表中的相对路径均以 `PaperBench.exe` 所在目录为起点。

使用 **Syncthing** 时，可以同步论文库和上述数据文件夹，各电脑保留自己的 `state/ai-literature-reader/settings.json`。两台电脑使用相同版本，保持论文库内部目录结构一致；第一次在另一台使用前，先等待同步完成，再选择当地的论文库路径。

请完整同步 `prompts/` 和 `attachments/`，保留其中的关联、初始化及删除记录。预设菜单打开时会重新读取同步结果，也可手动刷新。同一条记录在两台电脑同时修改仍可能产生同步冲突；编辑中的预设若已被其他地方修改，保存时会提示并保留草稿。

Codex 的登录状态和完整聊天历史由其自身环境管理，不会随着这些文件夹自动迁移；论文与对话的绑定也不保证在更换根目录后自动匹配。浏览器本地保存的自定义 Word 样式和部分界面偏好不在上表的文件备份中。

## 从源码构建

在源码目录打开 PowerShell，运行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\Build.ps1
..\PaperBench.exe
```

构建脚本会在源码目录的上一级生成 `PaperBench.exe`。网页资源、开源声明和相应的引用排版源码已嵌入程序，日常运行不需要单独复制源码中的 `assets/`。

更新时保留论文库、`state/`、`attachments/` 和 `prompts/`，不要用别人的个人数据覆盖它们。仓库不包含个人论文、阅读记录、登录信息或预编译 EXE。

## 许可证与致谢

PaperBench 的原创代码采用 [MIT 许可证](LICENSE)，Copyright (c) 2026 konijiw。第三方组件适用各自的许可证，不被本项目的 MIT 许可证替代。

**AI 对话侧栏及相关对话代码改编自 [ZoteroCodex](https://github.com/RTLiang/zotero-codex)**，感谢原作者和贡献者。相关 MIT 版权与许可声明保留在 [assets/LICENSE-zotero-codex.txt](assets/LICENSE-zotero-codex.txt)。PaperBench 是独立工具，无需安装 Zotero。

| 组件 | 用途 | 许可证 |
| --- | --- | --- |
| [citeproc-js](https://github.com/Juris-M/citeproc-js) | 参考文献排版 | 本项目按 CPAL 1.0 使用，© Frank Bennett |
| [CSL Styles](https://github.com/citation-style-language/styles)、[CSL Locales](https://github.com/citation-style-language/locales) | 引用样式与语言包 | CC BY-SA 3.0 |
| [Marked](https://github.com/markedjs/marked)、[KaTeX](https://github.com/KaTeX/KaTeX) | Markdown 与数学公式渲染 | MIT |
| [MathJax](https://github.com/mathjax/Mathjax) | 数学公式渲染 | Apache-2.0 |
| [DOMPurify](https://github.com/cure53/DOMPurify) | HTML 内容清理 | 本项目按 Apache-2.0 使用 |

完整的改编范围、第三方版权、许可证及引用排版源码获取方式，见 [第三方声明](THIRD_PARTY_NOTICES.md)。运行程序后也可从右上角“导入论文 PDF”左侧的“开源声明”查看。

MinerU、Codex CLI 和可选的 PDF 提取工具是外部依赖，不包含在本仓库中，分别适用其自身许可与服务条款。用户导入的论文、附件和个人数据不适用 PaperBench 的 MIT 许可证。
