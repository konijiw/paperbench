using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;

internal static partial class MinerULibraryReview
{
    private static readonly object PdfProcessingLock = new object();
    private sealed class ParseManifest
    {
        public string active { get; set; }
        public Dictionary<string, string> text { get; set; }
        public Dictionary<string, string> fine { get; set; }
    }
    private sealed class PdfTextRequest
    {
        public string paper { get; set; }
        public string signature { get; set; }
        public string text { get; set; }
        public bool removePrevious { get; set; }
    }
    private static string ParseManifestPath(string directory) { return Path.Combine(directory, ".paperbench-parsing.json"); }
    private static string PreferredPaperText(string directory)
    {
        string md = Path.Combine(directory, "markdown.md"), txt = Path.Combine(directory, "pdf-text.txt");
        string manifestFile = ParseManifestPath(directory);
        try
        {
            MaterialNoLinks(manifestFile);
            if (File.Exists(manifestFile))
            {
                var manifest = Json.Deserialize<ParseManifest>(File.ReadAllText(manifestFile, Encoding.UTF8));
                if (manifest != null && manifest.active == "text" && File.Exists(txt)) return txt;
            }
        }
        catch { /* A damaged preference must not prevent opening a paper. */ }
        return File.Exists(md) ? md : File.Exists(txt) ? txt : null;
    }
    private static string ParseHash(string file)
    {
        using (var sha = SHA256.Create()) using (var input = File.OpenRead(file))
            return BitConverter.ToString(sha.ComputeHash(input)).Replace("-", "");
    }
    private static string ParseFile(string directory, string relative)
    {
        if (String.IsNullOrWhiteSpace(relative) || Path.IsPathRooted(relative)) throw new InvalidDataException("解析文件路径无效。");
        string prefix = Path.GetFullPath(directory).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
        string full = Path.GetFullPath(Path.Combine(directory, relative.Replace('/', Path.DirectorySeparatorChar)));
        if (!full.StartsWith(prefix, StringComparison.OrdinalIgnoreCase) || String.Equals(Path.GetExtension(full), ".pdf", StringComparison.OrdinalIgnoreCase))
            throw new InvalidDataException("解析文件路径无效。");
        MaterialNoLinks(full);
        return full;
    }
    private static ParseManifest LoadParseManifest(string directory)
    {
        string file = ParseManifestPath(directory); MaterialNoLinks(file);
        if (File.Exists(file)) return Json.Deserialize<ParseManifest>(File.ReadAllText(file, Encoding.UTF8)) ?? new ParseManifest();
        // Adopt only conventional parser outputs and image paths actually referenced
        // by Markdown. Never treat an entire images directory as disposable.
        var manifest = new ParseManifest();
        string md = Path.Combine(directory, "markdown.md");
        if (File.Exists(md))
        {
            var names = new List<string> { "markdown.md", "structured_content.json" };
            foreach (Match match in Regex.Matches(File.ReadAllText(md, Encoding.UTF8), @"images/[A-Za-z0-9_./%+\-]+\.(?:png|jpg|jpeg|webp|gif)", RegexOptions.IgnoreCase))
                names.Add(Uri.UnescapeDataString(match.Value));
            manifest.fine = ParseInventory(directory, names); manifest.active = "fine";
        }
        return manifest;
    }
    private static Dictionary<string, string> ParseInventory(string directory, IEnumerable<string> names)
    {
        var result = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (string name in names.Distinct(StringComparer.OrdinalIgnoreCase))
        {
            string file = ParseFile(directory, name);
            if (File.Exists(file)) result[name] = ParseHash(file);
        }
        return result;
    }
    private static object PdfProcessingStatus(string paper)
    {
        string directory = ResolvePaper(paper), pdf = FindPdf(directory);
        if (pdf == null) throw new FileNotFoundException("论文 PDF 不存在。");
        lock (PdfProcessingLock)
        {
            var manifest = LoadParseManifest(directory);
            return new { signature = PdfSearchSignature(pdf), hasText = File.Exists(Path.Combine(directory, "pdf-text.txt")),
                hasFine = File.Exists(Path.Combine(directory, "markdown.md")), active = manifest.active ?? "" };
        }
    }
    // Called only after the new output has been produced successfully. Old files
    // are recoverable; user-edited files are retained even when cleanup is chosen.
    private static string CompleteParsing(string directory, ParseManifest manifest, string mode, IEnumerable<string> names, bool removePrevious, bool reuse = false)
    {
        var current = reuse && manifest.fine != null ? manifest.fine : ParseInventory(directory, names);
        var old = mode == "text" ? manifest.fine : manifest.text;
        int retained = 0;
        if (removePrevious && old != null)
        {
            string backup = Path.Combine(StateDirectory, "parse-backups", Guid.NewGuid().ToString("N"));
            string note = LoadReview(directory).note ?? "";
            foreach (var entry in old)
            {
                string file = ParseFile(directory, entry.Key);
                if (!File.Exists(file) || current.ContainsKey(entry.Key)) continue;
                if (ParseHash(file) != entry.Value || note.IndexOf(entry.Key, StringComparison.OrdinalIgnoreCase) >= 0) { retained++; continue; }
                string target = Path.Combine(backup, entry.Key.Replace('/', Path.DirectorySeparatorChar));
                Directory.CreateDirectory(Path.GetDirectoryName(target));
                File.Copy(file, target, false);
                File.Delete(file);
            }
            if (mode == "text") manifest.fine = null; else manifest.text = null;
        }
        if (mode == "text") manifest.text = current; else manifest.fine = current;
        manifest.active = mode;
        AtomicWrite(ParseManifestPath(directory), Json.Serialize(manifest));
        return retained > 0 ? "；已保留自行修改过的旧解析文件" : "";
    }
    private static void SavePdfText(Stream stream, string body)
    {
        var request = Json.Deserialize<PdfTextRequest>(body);
        if (request == null || String.IsNullOrWhiteSpace(request.text) || request.text.Length > 8 * 1024 * 1024)
            throw new InvalidDataException("未提取到有效文字，或正文过大；扫描件请使用精细解析。");
        string directory = ResolvePaper(request.paper), pdf = FindPdf(directory);
        lock (PdfProcessingLock)
        {
            lock (MinerUJobLock)
            {
                MinerUJob job;
                if (MinerUJobs.TryGetValue(request.paper, out job) && job.state == "running") throw new InvalidOperationException("请等待当前解析完成。");
            }
            if (pdf == null || PdfSearchSignature(pdf) != request.signature) throw new InvalidOperationException("提取期间 PDF 已变化，请重试。");
            var manifest = LoadParseManifest(directory);
            string target = ParseFile(directory, "pdf-text.txt");
            if (File.Exists(target) && (manifest.text == null || !manifest.text.ContainsKey("pdf-text.txt") || ParseHash(target) != manifest.text["pdf-text.txt"]))
                throw new InvalidOperationException("pdf-text.txt 已存在且不是可覆盖的原始提取结果，请先重命名保留。");
            // Save the previous inventory before publishing a replacement.
            AtomicWrite(ParseManifestPath(directory), Json.Serialize(manifest));
            AtomicWrite(target, request.text);
            string warning = CompleteParsing(directory, manifest, "text", new[] { "pdf-text.txt" }, request.removePrevious);
            InterlockedIncrementLibrary();
            WriteJson(stream, new { saved = true, preferredTextPath = PreferredPaperText(directory), message = "文本已保存为论文目录中的 pdf-text.txt" + warning });
        }
    }
    private static void InterlockedIncrementLibrary() { System.Threading.Interlocked.Increment(ref LibraryRevision); }
}
