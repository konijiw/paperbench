using System;using System.IO;using System.Reflection;
class CitationUndoTests {
 static Type t;
 static object Call(string name,params object[] args){try{return t.GetMethod(name,BindingFlags.Static|BindingFlags.NonPublic).Invoke(null,args);}catch(TargetInvocationException e){throw e.InnerException;}}
 static string Get(object o,string name){return (string)o.GetType().GetProperty(name).GetValue(o,null);}
 static void Check(bool result,string message){if(!result)throw new Exception(message);}
 static void Save(string paper,string key,string title){
  string body="{\"paper\":\""+paper+"\",\"key\":\""+key+"\",\"bib\":\"@article{"+key+", title={"+title+"}, author={Smith, Alice}, year={2025}}\"}";
  using(var stream=new MemoryStream())Call("SaveCitation",stream,body);
 }
 static void Main(string[] args){
  t=Assembly.LoadFrom(Path.GetFullPath(args[0])).GetType("MinerULibraryReview");
  string root=Path.GetFullPath(args[1]);Directory.CreateDirectory(root);
  string library=Path.Combine(root,"library");
  foreach(string name in new[]{"one","two"}){Directory.CreateDirectory(Path.Combine(library,name));File.WriteAllText(Path.Combine(library,name,"source.pdf"),"%PDF-1.4");}
  foreach(var pair in new[]{new[]{"AppDirectory",root},new[]{"StateDirectory",Path.Combine(root,"state")},new[]{"PapersStateDirectory",Path.Combine(root,"state","papers")},new[]{"LibraryRoot",library}})t.GetField(pair[0],BindingFlags.Static|BindingFlags.NonPublic).SetValue(null,pair[1]);
  string directory=Path.Combine(library,"one");
  Save("one","stable2025","Correct A");Check(String.IsNullOrEmpty(Get(Call("ReadCitation",directory),"previousBib")),"First save should have no undo");
  Save("one","stable2025","Wrong B");Save("one","stable2025","Wrong B");
  var stored=Call("ReadCitation",directory);Check(Get(stored,"previousBib").Contains("Correct A"),"Unchanged save must preserve A");
  // Reading again represents loading the persisted snapshot after closing the window.
  var restored=Call("UndoCitationSave","one");Check(Get(restored,"bib").Contains("Correct A"),"Undo restores A");Check(String.IsNullOrEmpty(Get(restored,"previousBib")),"Undo consumes one previous version");
  Check(Get(Call("ReadCitation",directory),"bib").Contains("Correct A"),"Restoration must persist");
  Save("one","stable2025","B");Save("one","stable2025","C");restored=Call("UndoCitationSave","one");Check(Get(restored,"bib").Contains("title={B}"),"Latest overwrite restores B rather than A");
  Save("one","newKey2025","D");Save("two","stable2025","Other document");
  bool conflict=false;try{Call("UndoCitationSave","one");}catch(InvalidOperationException){conflict=true;}
  Check(conflict,"Occupied old keys must not be restored");stored=Call("ReadCitation",directory);Check(Get(stored,"key")=="newKey2025"&&Get(stored,"previousKey")=="stable2025","Failed undo preserves current and previous records");
  Console.WriteLine("Passed: persistent undo, unchanged-save protection, latest-version rollback, key restoration and collision protection.");
 }
}
