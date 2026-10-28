# Third-party notices

PaperBench's original code is Copyright (c) 2026 konijiw and is licensed under
the MIT License in [LICENSE](LICENSE). That license does not replace the licenses
of the third-party code, fonts, styles, and locale data listed below. Original
copyright and license notices in those files are retained.

## Zotero Codex

- Project: https://github.com/RTLiang/zotero-codex
- Copyright (c) 2026 Zotero Codex contributors.
- License: MIT; full text: [assets/LICENSE-zotero-codex.txt](assets/LICENSE-zotero-codex.txt).
- Adapted files: `assets/codex-sidebar/sidebar.js`, `protocol.js`, `markdown.js`,
  and `style.css`. PaperBench adapts the sidebar and conversation integration for
  a standalone local reader, adds browser/C# bridge integration and editable
  prompt presets, and changes layout and interactions.
- PaperBench is an independent application, not an official Zotero Codex release.

## citeproc-js

- Project: https://github.com/Juris-M/citeproc-js
- Bundled processor: 1.4.61, `assets/csl/citeproc.js`.
- Copyright (c) 2009-2019 Frank Bennett.
- Upstream offers CPAL 1.0 or AGPLv3. PaperBench distributes this component under
  CPAL 1.0; this component is not relicensed under PaperBench's MIT License.
- Original notice: [assets/csl/LICENSE-citeproc.txt](assets/csl/LICENSE-citeproc.txt).
- Full applicable terms, including Exhibits A and B:
  [assets/csl/CPAL.txt](assets/csl/CPAL.txt).
- The upstream alternative AGPLv3 text is also retained in
  [assets/csl/AGPL-3.0.txt](assets/csl/AGPL-3.0.txt); PaperBench elects CPAL for
  this distribution.
- The original processor is unchanged. The browser build wrapper and its date
  are documented in [assets/csl/WRAPPER-CHANGES.md](assets/csl/WRAPPER-CHANGES.md).
  The generated processor/wrapper portions of `assets/csl-bundle.js` remain
  subject to CPAL; the separately embedded CSL assets retain their own license.
- Required attribution: (c) Frank Bennett; citeproc-js implements the Citation
  Style Language; https://citationstyles.org/.

### Source availability in compiled distributions

The source is included in this repository with `Build.ps1` and the CSL assets.
The compiled application also includes the readable processor and build source.
With PaperBench running, the following paths on the application's own local URL
provide them without a network download:

- `/third-party/citeproc.js`: original processor source.
- `/assets/csl-bundle.js`: the exact readable JavaScript wrapper, processor, CSL
  styles, locales, and citation license texts used by that executable.
- `/third-party/Build.ps1`: the build script for that executable.
- `/licenses`: PaperBench's MIT License, these notices, wrapper change record,
  and bundled third-party copyright and license texts.

Repository source: https://github.com/konijiw/paperbench.
Redistributors must preserve CPAL notices, attribution, and applicable source
availability obligations. An MIT license for the surrounding application does
not waive them.

## Citation Style Language styles and locales

- Projects: https://github.com/citation-style-language/styles and
  https://github.com/citation-style-language/locales.
- License: Creative Commons Attribution-ShareAlike 3.0 Unported:
  https://creativecommons.org/licenses/by-sa/3.0/.
- Full text: [assets/csl/LICENSE-CC-BY-SA-3.0.txt](assets/csl/LICENSE-CC-BY-SA-3.0.txt).
- Files: `assets/csl/*.csl`, `assets/csl/en-US.xml`, and `assets/csl/zh-CN.xml`.
- The bundled files retain their upstream attribution and rights elements.
  Style-specific authors, contributors, source URLs, and dates are reproduced in
  [assets/csl/SOURCES.txt](assets/csl/SOURCES.txt). They are not covered by the
  application MIT License.

## Other bundled browser components

| Component | Bundled files | License and copyright notice |
| --- | --- | --- |
| [Marked](https://github.com/markedjs/marked) | `assets/marked.umd.js` | MIT: [assets/LICENSE-marked.txt](assets/LICENSE-marked.txt) |
| [KaTeX](https://github.com/KaTeX/KaTeX), including its math fonts | `assets/codex-sidebar/katex.min.js`, `katex.min.css`, `fonts/KaTeX_*.woff2` | MIT: [assets/LICENSE-katex.txt](assets/LICENSE-katex.txt); font source notice: [assets/LICENSE-katex-fonts.txt](assets/LICENSE-katex-fonts.txt) |
| [MathJax](https://github.com/mathjax/MathJax) | `assets/mathjax-tex-svg-full.js` | Apache-2.0: [assets/LICENSE-mathjax.txt](assets/LICENSE-mathjax.txt) |
| [DOMPurify](https://github.com/cure53/DOMPurify) | `assets/purify.min.js` | Distributed here under the Apache-2.0 option: [assets/LICENSE-dompurify.txt](assets/LICENSE-dompurify.txt) |

## External tools and user material

MinerU, Codex CLI, and optional PDF extraction tools are external dependencies,
not bundled with this repository. They and the services they connect to have
their own licenses and terms. Third-party model weights are not included.

User papers, supplementary files, reading notes, and personal prompt files are
not licensed by PaperBench's MIT License. Their rights remain with their
respective rights holders.
