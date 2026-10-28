using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Text;
using System.Web.Script.Serialization;

internal static class ChatArchiveTests
{
    private static readonly JavaScriptSerializer Json = new JavaScriptSerializer();
    private static object Data(object value) { return Json.DeserializeObject(Json.Serialize(value)); }
    private static object Value(object value, string key) { object result; return ((Dictionary<string, object>)value).TryGetValue(key, out result) ? result : null; }
    private static void Check(bool value, string message) { if (!value) throw new Exception(message); }
    private static void Set(object target, string field, object value) { target.GetType().GetField(field, BindingFlags.Instance | BindingFlags.Public).SetValue(target, value); }
    public static int Main(string[] args)
    {
        string root = Path.GetFullPath(Path.Combine("tests", "runtime", "chat-archive-" + Guid.NewGuid().ToString("N")));
        string paper = Path.Combine(root, "paper"), target = Path.Combine(root, "export");
        Directory.CreateDirectory(Path.Combine(paper, "images")); Directory.CreateDirectory(target);
        byte[] pixel = Convert.FromBase64String("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aJ3sAAAAASUVORK5CYII=");
        File.WriteAllBytes(Path.Combine(paper, "images", "figure.png"), pixel);
        Assembly app = Assembly.LoadFrom(Path.GetFullPath(args[0])); Type main = app.GetType("MinerULibraryReview");
        main.GetField("AppDirectory", BindingFlags.Static | BindingFlags.NonPublic).SetValue(null, root);
        Type sourceType = main.GetNestedType("MaterialSource", BindingFlags.NonPublic), archiveType = main.GetNestedType("MaterialChatArchive", BindingFlags.NonPublic);
        object source = Activator.CreateInstance(sourceType, true); Set(source, "directory", paper); Set(source, "path", "paper"); Set(source, "title", "Fixture paper");
        var calls = new List<string>();
        Func<string, object, object> reader = delegate(string method, object parameters)
        {
            string id = Convert.ToString(Value(parameters, "threadId")); calls.Add(method + ":" + id);
            if (method == "thread/list")
            {
                Check(Convert.ToString(Value(parameters, "cwd")) == paper, "List must be scoped to this paper");
                Check((bool)Value(parameters, "useStateDbOnly"), "List must not repair/write session logs");
                if ((bool)Value(parameters, "archived")) return Data(new { data = new[] { new { id = "deleted", cwd = paper, createdAt = 3 } }, nextCursor = (string)null });
                if (Value(parameters, "cursor") == null) return Data(new { data = new[] { new { id = "first", cwd = paper, createdAt = 1 }, new { id = "unrelated", cwd = root, createdAt = 1 } }, nextCursor = "page-2" });
                return Data(new { data = new[] { new { id = "first", cwd = paper, createdAt = 1 }, new { id = "legacy", cwd = paper, createdAt = 2 } }, nextCursor = (string)null });
            }
            if (method == "thread/read")
            {
                if (id == "deleted") throw new InvalidOperationException("History was deleted");
                var oldTurns = new[] { new { id = "old-turn", status = "completed", items = new[] { new { id = "old-reply", type = "agentMessage", text = "Legacy final answer" } } } };
                return Data(new { thread = new { id = id, name = "Discussion " + id, cwd = paper, createdAt = 100, updatedAt = 200, status = new { type = id == "first" ? "active" : "idle" }, turns = Value(parameters, "includeTurns") == null ? null : oldTurns } });
            }
            if (method == "thread/turns/list")
            {
                if (id == "legacy") throw new InvalidOperationException("-32601 unknown method");
                if (Value(parameters, "cursor") == null)
                {
                    object[] items = { new { id = "question", type = "userMessage", content = new object[] { new { type = "text", text = "Explain $x^2$." }, new { type = "image", url = "data:image/png;base64," + Convert.ToBase64String(pixel) } } },
                        new { id = "reply", type = "agentMessage", phase = "final", text = "# Answer\n\n![figure](images/figure.png)\n\n```md\n![example](do-not-copy.png)\n```\n\n![missing](missing.png)" },
                        new { id = "tool", type = "commandExecution", command = "TOOL_LOG_MUST_NOT_APPEAR" }, new { id = "private-reasoning", type = "reasoning", text = "REASONING_MUST_NOT_APPEAR" } };
                    return Data(new { data = new[] { new { id = "turn-1", status = "completed", items = items } }, nextCursor = "turn-page-2" });
                }
                return Data(new { data = new[] { new { id = "turn-2", status = "completed", items = new[] { new { id = "last", type = "agentMessage", phase = "final", text = "Last page answer" } } } }, nextCursor = (string)null });
            }
            throw new Exception("Unexpected or mutating RPC: " + method);
        };
        var warnings = new List<string>(); Action<string> warn = warnings.Add;
        object archive = Activator.CreateInstance(archiveType, BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic, null, new object[] { reader, new Dictionary<string, string>(), null }, null);
        int exported = (int)archiveType.GetMethod("Export").Invoke(archive, new object[] { source, target, warn });
        Check(exported == 2, "Should export both matching readable threads despite a deleted archived thread");
        Check(!calls.Any(x => x.EndsWith(":unrelated")), "Unrelated workspace must never be read");
        string folder = Path.Combine(target, "AI对话");
        string joined = String.Join("\n", Directory.GetFiles(folder, "C*.md").Select(File.ReadAllText).ToArray());
        Check(joined.Contains("Last page answer") && joined.Contains("Legacy final answer"), "Must read every page and support old CLI history");
        Check(joined.Contains("$x^2$") && joined.Contains("```md\n![example](do-not-copy.png)\n```"), "Math and code fences must be preserved");
        Check(!joined.Contains("TOOL_LOG_MUST_NOT_APPEAR") && !joined.Contains("REASONING_MUST_NOT_APPEAR"), "Do not include tools or internal reasoning");
        Check(Directory.GetFiles(Path.Combine(folder, "图片")).Length == 1, "Inline and local identical images should deduplicate");
        Check(!warnings.Any(x => x.Contains("do-not-copy")), "Code examples must not be interpreted as image paths");
        Check(warnings.Count >= 3 && File.ReadAllText(Path.Combine(folder, "索引.md")).Contains("deleted"), "Missing history/images must be reported without losing successful threads");
        string offline = Path.Combine(root, "offline"); Directory.CreateDirectory(offline);
        object unavailable = Activator.CreateInstance(archiveType, BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic, null, new object[] { null, null, "Codex not installed" }, null);
        Check((int)archiveType.GetMethod("Export").Invoke(unavailable, new object[] { source, offline, warn }) == 0 && File.Exists(Path.Combine(offline, "AI对话", "索引.md")), "Unavailable Codex must leave a readable explanation");
        // Exercise the existing exporter with the new option off. No real Codex or UI is involved.
        byte[] pdf = Encoding.ASCII.GetBytes("%PDF-1.4\nfixture"); File.WriteAllBytes(Path.Combine(paper, "source.pdf"), pdf);
        object review = Json.Deserialize("{\"status\":\"deep\",\"note\":\"Offline note\",\"annotations\":[],\"tags\":[]}", main.GetNestedType("ReviewRecord", BindingFlags.NonPublic));
        Set(source, "review", review);
        Set(source, "added", Json.Deserialize("{\"addedAt\":\"2026-10-28T00:00:00Z\",\"estimated\":false}", main.GetNestedType("PaperAddedInfo", BindingFlags.NonPublic)));
        object sources = Activator.CreateInstance(typeof(List<>).MakeGenericType(sourceType)); ((System.Collections.IList)sources).Add(source);
        Type jobType = main.GetNestedType("MaterialExportJob", BindingFlags.NonPublic); object job = Activator.CreateInstance(jobType, true);
        string baseExport = Path.Combine(root, "base-export"); Directory.CreateDirectory(baseExport);
        Set(job, "destination", baseExport); Set(job, "root", root); Set(job, "total", 1); Set(job, "includeChats", false);
        File.WriteAllText(Path.Combine(baseExport, "导出未完成.txt"), "fixture");
        main.GetMethod("MaterialRun", BindingFlags.Static | BindingFlags.NonPublic).Invoke(null, new[] { job, sources });
        Check(Convert.ToString(jobType.GetField("state").GetValue(job)) == "complete", "Original material export must still complete with chats disabled");
        Check(main.GetField("Codex", BindingFlags.Static | BindingFlags.NonPublic).GetValue(null) == null, "Unchecked option must not initialize Codex");
        Check(File.ReadAllBytes(Path.Combine(paper, "source.pdf")).SequenceEqual(pdf), "Original paper must not change");
        Check(!Directory.GetDirectories(baseExport, "AI对话", SearchOption.AllDirectories).Any(), "Unchecked option must not add chat folders");
        string key = "0:" + main.GetMethod("ReviewKey", BindingFlags.Static | BindingFlags.NonPublic).Invoke(null, new object[] { paper });
        Func<string, object, object> mismatched = delegate(string method, object parameters) {
            if (method == "thread/list") return Data(new { data = new object[0], nextCursor = (string)null });
            if (method == "thread/read") return Data(new { thread = new { id = "old-binding", cwd = root } });
            throw new Exception("Mismatched thread history must never be read");
        };
        object staleBinding = Activator.CreateInstance(archiveType, BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic, null, new object[] { mismatched, new Dictionary<string, string> { { key, "old-binding" } }, null }, null);
        string staleOutput = Path.Combine(root, "stale-binding"); Directory.CreateDirectory(staleOutput);
        Check((int)archiveType.GetMethod("Export").Invoke(staleBinding, new object[] { source, staleOutput, warn }) == 0, "Even an explicit binding must not export a different workspace");
        Console.WriteLine("PASS: scoped discovery, deduplication, pagination, archived failures, legacy fallback, images, code/math, excluded activities, offline handling.");
        return 0;
    }
}
