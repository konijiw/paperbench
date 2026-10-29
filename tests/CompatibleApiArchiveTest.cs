using System;
using System.Collections.Generic;
using System.IO;
using System.Reflection;

internal static class CompatibleApiArchiveTest
{
    public static void Main(string[] args)
    {
        Type app = Assembly.LoadFrom(Path.GetFullPath(args[0])).GetType("MinerULibraryReview");
        Action<string, object> set = delegate(string name, object value) { app.GetField(name, BindingFlags.NonPublic | BindingFlags.Static).SetValue(null, value); };
        set("StateDirectory", Path.Combine(args[1], "state", "ai-literature-reader"));
        set("AppDirectory", args[1]); set("LibraryRoot", Path.Combine(args[1], "library"));
        set("AiPreferences", new Dictionary<string, string> { { "aiProvider", "api" } });
        object archive = app.GetMethod("CreateChatArchive", BindingFlags.NonPublic | BindingFlags.Static).Invoke(null, new object[] { new Dictionary<string, string>() });
        Type sourceType = app.GetNestedType("MaterialSource", BindingFlags.NonPublic);
        object source = Activator.CreateInstance(sourceType, true);
        foreach (var field in new Dictionary<string, string> { { "directory", Path.Combine(args[1], "library", "paper") }, { "path", "paper" }, { "title", "API fixture" } })
            sourceType.GetField(field.Key).SetValue(source, field.Value);
        Directory.CreateDirectory(args[2]);
        var warnings = new List<string>();
        int count = (int)archive.GetType().GetMethod("Export").Invoke(archive, new object[] { source, args[2], new Action<string>(warnings.Add) });
        if (count == 0 || warnings.Count > 0) throw new Exception("API archive failed: " + String.Join(";", warnings.ToArray()));
        if (app.GetField("Codex", BindingFlags.NonPublic | BindingFlags.Static).GetValue(null) != null) throw new Exception("API export started Codex.");
        Console.WriteLine("API history export passed: " + count);
    }
}
