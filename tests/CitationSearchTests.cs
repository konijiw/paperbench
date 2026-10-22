using System;
using System.IO;
using System.Reflection;
using System.Collections;
using System.Linq;
class CitationSearchTests {
 static Type t;
 static object Call(string n, params object[] a) { try { return t.GetMethod(n,BindingFlags.Static|BindingFlags.NonPublic).Invoke(null,a); } catch(TargetInvocationException e) { throw e.InnerException; } }
 static void Set(string n,string v) { t.GetField(n,BindingFlags.Static|BindingFlags.NonPublic).SetValue(null,v); }
 static object Prop(object o,string n) { return o.GetType().GetProperty(n).GetValue(o,null); }
 static void Equal(object a,object b) { if(!object.Equals(a,b)) throw new Exception("Expected "+b+", got "+a); }
 static void Main(string[] args) {
  string root=Path.GetFullPath(args[0]); t=Assembly.LoadFrom(Path.Combine(root,"reader.exe")).GetType("MinerULibraryReview");
  Set("AppDirectory",root);Set("StateDirectory",Path.Combine(root,"state","ai-literature-reader"));Set("PapersStateDirectory",Path.Combine(root,"state","ai-literature-reader","papers"));Set("LibraryRoot",Path.Combine(root,"library"));
  Equal(Call("CleanDoi","10.1038/s44182-026-00098-9](https://doi.org/test)"),"10.1038/s44182-026-00098-9");
  Equal(Call("CleanDoi","10.1038/s44182-026-00098-9&domain=pdf"),"10.1038/s44182-026-00098-9");
  Equal(Call("CleanDoi","https://doi.org/10.1234/a(1)."),"10.1234/a(1)");
  Equal(Call("ArxivIdentifier","arXiv:2609.28660v2 [cs.RO]",false),"2609.28660v2");
  Equal(Call("ArxivIdentifier","https://arxiv.org/pdf/hep-th/9901001v3.pdf",true),"hep-th/9901001v3");
  Equal(Call("ArxivIdentifier","10.48550/arXiv.2609.28660",true),"2609.28660");
  Equal(Call("ArxivIdentifier","2609.28660v2",true),"2609.28660v2");
  string expected="Biomimetic rigid-soft finger design for highly dexterous and adaptive robotic hands";
  var scan=Call("ScanCitation","science");Console.WriteLine("PDF-only title: "+Prop(scan,"title"));Equal(Prop(scan,"title"),expected);
  var arxivScan=Call("ScanCitation","arxiv");
  bool found=false;foreach(object c in (IEnumerable)Prop(arxivScan,"candidates")) if((string)Prop(c,"kind")=="arxiv"&&(string)Prop(c,"doi")=="2609.28660v2") found=true;
  if(!found) throw new Exception("arXiv PDF identifier not found");
  Console.WriteLine("arXiv PDF title: "+Prop(arxivScan,"title"));
  string atom="<feed xmlns='http://www.w3.org/2005/Atom' xmlns:arxiv='http://arxiv.org/schemas/atom'><entry><id>http://arxiv.org/abs/1234.56789v2</id><title>Test &amp; Study</title><published>2025-01-01</published><author><name>Alice Smith</name></author><arxiv:doi>10.1234/formal</arxiv:doi><arxiv:primary_category term='cs.RO'/></entry></feed>";
  object parsed=((IEnumerable)Call("ParseArxiv",atom)).Cast<object>().Single();
  string bib=(string)Prop(parsed,"bib");if(!bib.Contains("1234.56789v2")||!bib.Contains("published version DOI")||bib.Contains("  doi =")) throw new Exception("Preprint/version confusion");
  File.WriteAllText(Path.Combine(root,"arxiv-fixture.bib"),bib);
  Console.WriteLine("Offline DOI cleanup, identifier versions, PDF-only title, and preprint separation checks passed");
  if(args.Length>1) {
   var result=Call("SearchCitation","{\"query\":\""+expected+"\",\"source\":\"crossref\"}");
   var matches=((IEnumerable)Prop(result,"matches")).Cast<object>().ToArray();
   if(matches.Length==0)throw new Exception("Crossref: "+Prop(result,"warning"));
   Equal(Prop(matches[0],"doi"),"10.1126/sciadv.adu2018");
   File.WriteAllText(Path.Combine(root,"crossref-search.bib"),(string)Prop(matches[0],"bib"));
   Console.WriteLine("Live title search matched screenshot DOI");
   var ax=Call("LookupArxiv","1706.03762v7");
   File.WriteAllText(Path.Combine(root,"arxiv-live.bib"),(string)Prop(ax,"bib"));
   Console.WriteLine("Live arXiv ID lookup passed");
   var search=Call("SearchCitation","{\"query\":\"Attention Is All You Need\",\"source\":\"arxiv\"}");
   if(!((IEnumerable)Prop(search,"matches")).Cast<object>().Any())throw new Exception("arXiv title search failed: "+Prop(search,"warning"));
   Console.WriteLine("Live arXiv title search passed");
  }
 }
}
