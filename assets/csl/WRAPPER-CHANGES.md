# citeproc-js browser wrapper changes

Date: 2026-10-28
Contributor: konijiw / PaperBench
Original code: citeproc-js 1.4.61, Copyright (c) 2009-2019 Frank Bennett
License for the processor and its generated wrapper: CPAL 1.0, see CPAL.txt.

The vendored `citeproc.js` is unchanged. `Build.ps1` constructs a generated
`assets/csl-bundle.js` containing:

1. A local CommonJS-style `module.exports` object around the original processor.
2. An assignment exposing that processor as `window.CSL` in the browser.
3. A separate `window.CitationStyleAssets` data object containing the unmodified
   selected CSL styles, locale data, and their notices.

The engine's copyright header remains in the generated JavaScript. No processor
logic has been changed. CSL styles and locales retain CC BY-SA 3.0 and their
individual credits; they are not relicensed under CPAL or PaperBench's MIT License.

The runtime attribution is displayed in the library footer and the Word
reference section. The application exposes its full licenses and the exact
readable citation JavaScript through its local `/licenses` and
`/assets/csl-bundle.js` paths, respectively.
