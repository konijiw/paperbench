# 文献伴读

一个面向 **MinerU 解析结果**的 Windows 论文阅读器：把原文、解析后的内容、笔记和 AI 讨论放在同一处。

## 解决什么问题

读论文时，PDF、提取出的文字、公式图片、笔记和 AI 对话常散落在不同窗口。这个工具面向已经用 MinerU 解析论文、希望对照原文精读并持续整理个人论文库的读者。

## 能做什么

- 扫描论文库，阅读 MinerU 生成的 Markdown，并与原始 PDF 对照；也可通过界面的“导入论文 PDF”批量加入尚未解析的论文，每篇单独建立目录并直接阅读 PDF。
- 按论文保存整篇笔记；对 MinerU Markdown 的原文选区可添加批注和 AI 翻译。用标题、标签、收藏和最近阅读整理文献。搜索可读取 MinerU 解析出的论文标题，支持部分词和少量拼写误差。
- 在当前论文旁与 Codex 对话，可发送选中文字或图片。每篇论文关联独立对话，重开后可接续阅读。

## 特点

- **围绕原文阅读：** PDF、解析内容、批注和对话同屏，方便核对 AI 回答。
- **保留个人阅读脉络：** 批注关联原文，论文与对话、阅读布局分别保存。
- **本机管理论文库：** 阅读记录存于本机；程序不会主动修改原始 PDF、Markdown 或图片。AI 功能通过本机 Codex CLI 连接服务，使用 AI 时相关内容会按请求发送给服务处理。

## 运行

需要 Windows 10/11、.NET Framework 4.x。论文库可包含 MinerU 解析目录（`markdown.md` 和原始 PDF），也可包含仅有 PDF 的独立论文目录。使用 AI 功能还需安装并登录 [Codex CLI](https://developers.openai.com/codex/cli)；程序通过本机 `codex app-server` 连接，无需在阅读器中填写 API Key。

在 PowerShell 中进入本项目目录：

```powershell
.\Build.ps1
..\文献伴读.exe
```

首次打开时选择论文库根目录。阅读记录默认位于可执行文件旁的 `state/ai-literature-reader/`。可把现有 MinerU 解析结果关联为正文论文的支撑材料，也可把视频、PDF、ZIP 和数据文件复制到程序旁的独立 `attachments/` 目录并关联。左侧展开论文可查看附件；视频和 ZIP 内的常见视频可在阅读器中播放。论文库会标记 PDF 内容完全相同的副本，删除重复目录需要手动确认。

“导入论文 PDF”支持多选，会将每份 PDF **复制**到论文库内新建的同名目录，并保存为 `source.pdf`；原文件不移动。新目录暂时没有 Markdown 时默认使用浏览器内置阅读器显示 PDF，整篇笔记、标签和 AI 对话可用。以后在同一目录加入 `markdown.md` 即可切换到原有对照阅读。文字批注和 AI 翻译仍针对 Markdown 选区；PDF 阅读区不绘制批注。重复目录的自动删除仅用于已有 MinerU 论文。

跨电脑同步时，可同步论文库、`attachments/` 与 `state/ai-literature-reader/papers/`；各电脑保留各自的 `settings.json`。附件关联改为 `attachments/_links/` 中每条关联一个 JSON，首次使用新版本会从旧 `state/ai-literature-reader/attachments.json` 迁移，旧文件保留且不再更新。删除关联会留下删除记录，避免旧清单在另一台电脑上恢复已删附件。所有同步电脑都应更新到新版本；旧版程序无法读取新建的逐条附件记录。论文库内部目录结构需一致，避免同时在两台电脑上编辑同一篇论文的记录。旧版按绝对路径保存的论文记录会在本机扫描时复制为新格式，旧文件保留。

## LaTeX 引用

打开论文后，点击顶部“引用”。窗口可按住标题栏拖动，双击标题栏回到中央；引用浮窗打开时也能操作后面的 PDF。只有 PDF、以及 PDF 加 MinerU Markdown 的论文均可使用，不要求先解析全文。

- 打开“引用”窗口后，尚未保存书目信息的论文会自动启动识别；已有记录直接显示，不重复查询或覆盖。关闭窗口后重新打开可重试自动识别，手动查询始终保留。
- 自动识别会从 PDF/MinerU 内容提取线索、查询编号或标题、比对标题与作者；标题规范化后一致、作者在首页信息中吻合、年份无明确冲突且没有接近的不同候选时，自动保存。作者旁的单位编号会在比对时忽略；单独一个 DOI、搜索第一名或标题相似并不足以自动保存。
- 手动查询时始终显示“当前已保存的结果”。查询或选用候选仅更新待保存内容；“选回已保存结果”可以放弃未保存的替换。覆盖保存时只保留上一版（包括引用键），可用“撤销上次覆盖保存”恢复，重启后仍有效；相同内容再次保存、复制或导出不会冲掉上一版。每次新的覆盖替换上一版，撤销后不保留重做历史。
- 不确定时自动展开“手动查询或修正”，展示候选供选择后保存；没有可靠结果时提示补充标题、编号或导入 BibTeX。手动查询功能保留。
- 已保存的记录直接用于复制/导出，不再反复识别；一键识别不会覆盖已有记录或改变已有引用键。需要纠正时使用手动查询或编辑后保存。自动建立的新记录会避开已占用的引用键。
- arXiv 线索存在时保留预印本身份，并核对指定版本，不自动改成同标题的正式发表版本。
- 输入框支持 DOI、arXiv 新旧编号、带版本号的编号及对应文章链接。arXiv 使用官方 API 获取标题、作者、年份，生成预印本条目并保留版本号；正式发表信息只作为说明，不自动把预印本替换成正式版。
- 没有 DOI 时，可输入/修正标题，选择 Crossref（期刊、会议等）、arXiv 或两个来源检索。手动搜索显示至多每来源 5 条结果，按标题词语相似程度排序，不自动确认；点击“选用此条”后仍需核对保存。某个来源不可用时提示原因，保留其他来源的结果。
- 也可输入 DOI 或 doi.org 链接联网获取 BibTeX，或导入/粘贴单条 `.bib` 文献。可以直接编辑文献数据；暂不支持自定义 BibTeX 宏、字符串拼接、批量 `.bib` 导入和 OCR。
- 保存后可一键复制 `\cite{引用键}`，也可选择 natbib 或 biblatex 对应的引用命令。新识别文献的引用键采用“第一作者姓＋年份＋标题关键词”；短的冒号前标题优先作为论文名称，否则取前三个非停用词，重名自动追加 a、b 等后缀。缺少作者或年份时使用 Anon、Nd。元数据更新保留已保存的引用键；手动指定的重名引用键会被拒绝。导入 `.bib` 文件时保留文件中原有引用键。修改已用于正文的键时，需要同时修改正文。
- 导出当前文献，或展开底部文献列表，点击“读取已保存文献”，使用“按标签选择”自动勾选该标签下所有已保存条目，再导出 `references.bib`。也可全选当前列表、取消全选或取消个别条目。标签使用论文现有标签，修改/重命名标签后重新读取即可，无需重新识别。仅包含已保存书目信息的论文；标签下尚未识别的论文需先识别保存。导出提供 BibTeX 与 BibLaTeX 的常用字段适配；复杂条目仍需按投稿模板核对。导出文件由用户手动放入 LaTeX 项目或上传 Overleaf，不自动修改已有 `.bib` 文件。
- 文献样式由 LaTeX 模板决定。例如传统 BibTeX 模板使用 `\bibliographystyle{plain}` 和 `\bibliography{references}`；BibLaTeX 模板使用 `\addbibresource{references.bib}`、`\printbibliography`，并用 Biber 编译。已有期刊/学校模板优先遵照其说明，不混用配置。

PDF 提取使用 `pdftotext.exe`，依次从程序旁 `tools/`、系统 PATH、`C:\texlive\年份\bin\windows` 查找。本机已有 TeX Live 可直接使用；在另一台电脑上需安装该工具或提供完整依赖，程序不捆绑它。缺少提取工具时，手动 DOI 查询和 BibTeX 导入仍可用。扫描件暂不能自动提取。编号查询会把 DOI 发给 doi.org 及其注册机构，或把 arXiv 编号发给 arXiv 官方 API；标题检索把输入/提取的标题发给选中的 Crossref/arXiv 服务。不上传 PDF 或 Markdown。新增检索请求串行执行并间隔至少 3 秒，成功结果保留在本次运行的内存缓存中。

联网检索覆盖范围取决于 Crossref/arXiv 收录情况，不能保证找到所有论文；扫描件、标题提取错误、数据库未收录时，可手动改标题重试，或使用 BibTeX 导入/编辑。实现参考 [Zotero PDF 元数据识别](https://www.zotero.org/support/retrieve_pdf_metadata)、[JabRef PDF 导入](https://docs.jabref.org/collect/findunlinkedfiles)、[Crossref API](https://github.com/CrossRef/rest-api-doc) 和 [arXiv API](https://info.arxiv.org/help/api/user-manual.html)，未复制其源码。

书目信息单独保存在 `state/ai-literature-reader/citations/`，不修改原始 PDF、Markdown 或阅读笔记。跨电脑同步时也请同步此目录。记录按当前论文相对目录关联，移动/重命名论文目录后需要重新关联文献信息。

## 第三方代码与开源许可

- 对话界面改编自 [zotero-codex](https://github.com/RTLiang/zotero-codex)（MIT）；本项目不是 Zotero 插件，也不是该项目的官方版本。
- 随源码提供 [Marked](https://github.com/markedjs/marked)（MIT）、[KaTeX](https://github.com/KaTeX/KaTeX)（MIT）、[MathJax](https://github.com/mathjax/MathJax)（Apache-2.0）及 [DOMPurify](https://github.com/cure53/DOMPurify)（本项目按 Apache-2.0 许可分发）。原版权与许可文本见 [`assets/LICENSE-*.txt`](assets/)。
- MinerU 和 Codex CLI 是外部工具，不包含在本仓库中；请分别遵守其许可与使用条款。

**发布前须处理：** 保留上述第三方代码的版权声明和许可文本；若单独发布编译后的 EXE，也要随发行包提供这些文本。检查提交内容，避免上传未获授权的论文 PDF 和个人阅读记录。仓库目前没有项目自身的 `LICENSE` 文件，公开源码本身不等于授予他人复制、修改或再分发的许可。请先为自己原创的代码选择并添加开源许可证，再以“开源项目”对外发布。第三方组件仍各自适用其原许可。

本节是发布注意事项，不构成法律意见。
