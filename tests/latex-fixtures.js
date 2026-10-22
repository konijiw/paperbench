const fs = require('fs');
const path = require('path');
const bib = require('../assets/citations.js');
const root = path.join(__dirname, 'runtime');
const entry = bib.parse(fs.readFileSync(path.join(root, 'lookup.bib'), 'utf8'));
for (const mode of ['bibtex', 'biblatex']) {
 const dir = path.join(root, mode); fs.mkdirSync(dir, {recursive:true});
 fs.writeFileSync(path.join(dir, 'references.bib'), bib.serialize(entry, mode));
 const body = mode === 'bibtex' ? '\\documentclass{article}\n\\begin{document}\nExample \\cite{' + entry.key + '}.\n\\bibliographystyle{plain}\n\\bibliography{references}\n\\end{document}' : '\\documentclass{article}\n\\usepackage[backend=biber,style=numeric]{biblatex}\n\\addbibresource{references.bib}\n\\begin{document}\nExample \\cite{' + entry.key + '}.\n\\printbibliography\n\\end{document}';
 fs.writeFileSync(path.join(dir, 'main.tex'), body);
}
console.log('Generated both LaTeX fixtures from live DOI metadata.');
