using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.Reflection;
using System.Text.RegularExpressions;
using System.Web.Script.Serialization;

// Input contains fresh PDF.js text and independently checked reference titles.
// Invoke the title selector directly: no citation scan or external extractor runs.
class CitationPdfJsSampleTests
{
    static string Normalize(string value) { return Regex.Replace(value, @"\s+", " ").Trim().ToLowerInvariant(); }
    static int Main(string[] args)
    {
        var app = Assembly.LoadFrom(Path.GetFullPath(args[0])).GetType("MinerULibraryReview");
        var select = app.GetMethod("GuessCitationTitle", BindingFlags.NonPublic | BindingFlags.Static);
        var json = new JavaScriptSerializer { MaxJsonLength = 4000000 };
        var cases = (object[])json.DeserializeObject(File.ReadAllText(args[1]));
        int passed = 0;
        foreach (Dictionary<string, object> item in cases)
        {
            string actual = (string)select.Invoke(null, new object[] { (string)item["pdfjs"] });
            string expected = (string)item["title"];
            bool ok = expected.Length > 0 && Normalize(actual) == Normalize(expected);
            if (ok) passed++;
            Console.WriteLine((ok ? "PASS " : "FAIL ") + item["name"] + ": " + actual);
            if (!ok) Console.WriteLine("Expected: " + expected);
        }
        Console.WriteLine(passed + "/" + cases.Length + " PDF.js-only titles matched; pdftotext was not invoked.");
        return passed == cases.Length ? 0 : 1;
    }
}
