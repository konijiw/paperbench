using System;
using System.IO;
using System.Reflection;
using System.Text;
class CitationIntegration {
 static Type t;
 static object Call(string name, params object[] args) { try { return t.GetMethod(name, BindingFlags.NonPublic | BindingFlags.Static).Invoke(null,args); } catch(TargetInvocationException e) { throw e.InnerException; } }
 static void Set(string name,string value) { t.GetField(name,BindingFlags.NonPublic|BindingFlags.Static).SetValue(null,value); }
 static void Main(string[] args) {
  string root=Path.GetFullPath(args[0]);
  t=Assembly.LoadFrom(Path.Combine(root,"reader.exe")).GetType("MinerULibraryReview");
  Set("AppDirectory",root); Set("StateDirectory",Path.Combine(root,"state","ai-literature-reader"));
  Set("PapersStateDirectory",Path.Combine(root,"state","ai-literature-reader","papers")); Set("LibraryRoot",Path.Combine(root,"library"));
  foreach(string p in new[]{"pdf-only","parsed"}) {
   object result=Call("ScanCitation",p);
   var candidates=(System.Collections.ICollection)result.GetType().GetProperty("candidates").GetValue(result,null);
   if(candidates.Count==0) throw new Exception("No DOI extracted for "+p);
   Console.WriteLine(p+": extracted "+candidates.Count+" DOI candidates");
  }
  string body="{\"paper\":\"pdf-only\",\"key\":\"test2025\",\"bib\":\"@article{test2025, title={Example}, author={Smith, Alice}, year={2025}, journal={Robotics}}\"}";
  using(var ms=new MemoryStream()) Call("SaveCitation",ms,body);
  var saved=Call("ReadCitation",Path.Combine(root,"library","pdf-only"));
  if((string)saved.GetType().GetProperty("key").GetValue(saved,null)!="test2025") throw new Exception("Save/read mismatch");
  try { using(var ms=new MemoryStream()) Call("SaveCitation",ms,body.Replace("pdf-only","parsed")); throw new Exception("Duplicate accepted"); }
  catch(InvalidDataException) { Console.WriteLine("Duplicate citation key rejected"); }
  Console.WriteLine("PDF-only save/read and library selection passed");
  try {
   var lookup=Call("LookupCitation","10.1038/nature14539");
   File.WriteAllText(Path.Combine(root,"lookup.bib"),(string)lookup.GetType().GetProperty("bib").GetValue(lookup,null));
   Console.WriteLine("Live DOI lookup returned BibTeX");
  } catch(Exception e) { Console.WriteLine("LIVE_LOOKUP_UNVERIFIED: "+e.Message); }
 }
}
