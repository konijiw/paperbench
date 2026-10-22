using System;using System.IO;using System.Reflection;using System.Collections.Generic;using System.Web.Script.Serialization;
class CitationKeyTests {
 static void Main(string[] args){
  var t=Assembly.LoadFrom(Path.GetFullPath(args[0])).GetType("MinerULibraryReview");
  var generate=t.GetMethod("MakeReadableCitationKey",BindingFlags.Static|BindingFlags.NonPublic);
  foreach(var row in new JavaScriptSerializer().Deserialize<string[][]>(File.ReadAllText(args[1]))){
   var actual=(string)generate.Invoke(null,new object[]{row[0],row[1],row[2]});
   if(actual!=row[3])throw new Exception("Expected "+row[3]+", got "+actual);
  }
  var unique=t.GetMethod("UniqueCitationKey",BindingFlags.Static|BindingFlags.NonPublic);
  var occupied=new HashSet<string>{"Zhang2025SoftHand","Zhang2025SoftHanda","Zhang2025SoftHandb"};
  if((string)unique.Invoke(null,new object[]{"Zhang2025SoftHand",occupied})!="Zhang2025SoftHandc")throw new Exception("Suffix collision failed");
  Console.WriteLine("Backend naming fixtures and collision suffixes passed.");
 }
}
