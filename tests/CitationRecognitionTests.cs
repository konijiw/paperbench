using System;using System.IO;using System.Reflection;using System.Collections;using System.Collections.Generic;
class CitationRecognitionTests {
 static Type t,mt,st,ct;
 static object Call(string n,params object[] a){try{return t.GetMethod(n,BindingFlags.Static|BindingFlags.NonPublic).Invoke(null,a);}catch(TargetInvocationException e){throw e.InnerException;}}
 static void Set(object o,string n,object v){o.GetType().GetProperty(n).SetValue(o,v,null);}
 static object Get(object o,string n){return o.GetType().GetProperty(n).GetValue(o,null);}
 static object Make(Type type){return Activator.CreateInstance(type,true);}
 static IList List(Type type){return (IList)Activator.CreateInstance(typeof(List<>).MakeGenericType(type));}
 static void Check(bool ok,string message){if(!ok)throw new Exception(message);}
 static object Match(string title,string authors,string year,string doi,string arxiv){var m=Make(mt);Set(m,"title",title);Set(m,"authors",authors);Set(m,"year",year);Set(m,"doi",doi);Set(m,"arxiv",arxiv);return m;}
 static bool Accept(object scan,object match,params object[] others){var all=List(mt);all.Add(match);foreach(var o in others)all.Add(o);return (bool)Call("CanAutoAcceptCitation",scan,match,all);}
 static void Main(string[] args){
  string root=Path.GetFullPath(args[0]);t=Assembly.LoadFrom(Path.Combine(root,"recognition-reader.exe")).GetType("MinerULibraryReview");mt=t.GetNestedType("CitationMatch",BindingFlags.NonPublic);st=t.GetNestedType("CitationScan",BindingFlags.NonPublic);ct=t.GetNestedType("CitationClue",BindingFlags.NonPublic);
  var values=new Dictionary<string,string>{{"AppDirectory",root},{"StateDirectory",Path.Combine(root,"recognition-state")},{"PapersStateDirectory",Path.Combine(root,"recognition-state","papers")},{"LibraryRoot",Path.Combine(root,"library")}};
  foreach(var p in values)t.GetField(p.Key,BindingFlags.Static|BindingFlags.NonPublic).SetValue(null,p.Value);
  var scan=Call("ScanCitation","science");string title=(string)Get(scan,"title");
  var good=Match(title,"Zhang, Ningbin; Zhou, Peiwei; Yang, Xinyu","2025","10.1126/sciadv.adu2018",null);
  Check(Accept(scan,good),"Real PDF header with numbered author affiliations should match");
  Check(!Accept(scan,Match(title,"Smith, Alice; Brown, Bob","2025","10.1234/wrong",null)),"Reject wrong authors");
  Check(!Accept(scan,Match(title,"Zhang, Ningbin; Zhou, Peiwei","1998","10.1234/year",null)),"Reject conflicting year");
  Check(!Accept(scan,Match("Not "+title,"Zhang, Ningbin; Zhou, Peiwei","2025","10.1234/title",null)),"Reject changed title");
  Check(!Accept(scan,good,Match(title,"Zhang, Ningbin; Zhou, Peiwei","2025","10.1234/other-version",null)),"Ambiguous records need review");
  var weak=Make(st);Set(weak,"title",title);Set(weak,"verificationText","Title only, without author names");Set(weak,"candidates",List(ct));Check(!Accept(weak,good),"Title alone must not auto-save");
  var ax=Call("ScanCitation","arxiv");var axgood=Match((string)Get(ax,"title"),"Tara Sadjadpour; Siming He; C. K. Wolfe","2026",null,"2609.28660v2");
  Check(Accept(ax,axgood),"Actual arXiv PDF should pass title/author checks");
  Check(!Accept(ax,Match((string)Get(ax,"title"),"Tara Sadjadpour; Siming He","2026",null,"2609.28660v1")),"Reject wrong arXiv version");
  Check(!Accept(ax,Match((string)Get(ax,"title"),"Tara Sadjadpour; Siming He","2026","10.1234/formal",null)),"Do not replace preprint with formal version");
  string bib="@article{stable2025, title={Original manual title}, author={Zhang, Ningbin and Zhou, Peiwei}, year={2025}}";
  var first=Call("StoreRecognizedCitation","science",bib);
  var second=Call("StoreRecognizedCitation","arxiv",bib);Check((string)Get(first,"key")!=(string)Get(second,"key"),"Avoid key collisions");
  var preserved=Call("StoreRecognizedCitation","science",bib.Replace("Original manual title","Overwrite attempt"));Check(((string)Get(preserved,"bib")).Contains("Original manual title"),"Existing information must survive");
  var existing=Call("RecognizeCitation","science");Check((string)Get(existing,"status")=="existing","Saved records skip recognition and network");
  Console.WriteLine("Passed: real PDF/title/author checks, wrong-author/year/title rejection, ambiguity, arXiv versions, unique keys, existing-record protection.");
 }
}
