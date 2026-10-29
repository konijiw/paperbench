using System;
using System.Collections.Generic;
using System.IO;
using System.Security.Cryptography;
using System.Text;

internal static partial class MinerULibraryReview
{
    private const string PdfSearchSchema = "pdfjs-5.6.205-opening-800-v2";
    private static readonly object PdfSearchLock = new object();
    private static readonly Dictionary<string, PdfSearchRecord> PdfSearchMemory = new Dictionary<string, PdfSearchRecord>(StringComparer.OrdinalIgnoreCase);
    private sealed class PdfSearchRecord
    {
        public string schema { get; set; }
        public string signature { get; set; }
        public string title { get; set; }
        public string text { get; set; }
        public string status { get; set; }
        public int pages { get; set; }
    }
    private sealed class PdfSearchSaveRequest
    {
        public string root { get; set; }
        public string paper { get; set; }
        public string signature { get; set; }
        public string title { get; set; }
        public string text { get; set; }
        public string status { get; set; }
        public int pages { get; set; }
    }
    private static string ResolvePdfSearchFile(string root, string paper, bool allowMarkdown = false)
    {
        lock (StateLock)
        {
            if (String.IsNullOrEmpty(root) || !String.Equals(Path.GetFullPath(root), Path.GetFullPath(LibraryRoot), StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException("论文库已切换，请重新建立搜索索引。");
            string pdf = FindPdf(ResolvePaper(paper));
            if (pdf == null) throw new FileNotFoundException("论文 PDF 不存在。");
            if (!allowMarkdown && File.Exists(Path.Combine(Path.GetDirectoryName(pdf), "markdown.md")))
                throw new InvalidOperationException("论文已有 Markdown，不使用 PDF 搜索索引。");
            return pdf;
        }
    }
    private static string PdfSearchSignature(string file)
    {
        FileInfo info = new FileInfo(file);
        return PdfSearchSchema + ":" + info.Length + ":" + info.LastWriteTimeUtc.Ticks + ":" + Path.GetFileName(file);
    }
    private static string PdfSearchCachePath(string file)
    {
        return Path.Combine(StateDirectory, "pdf-search", ReviewKey(file) + ".json");
    }
    private static object GetPdfSearchStatus(string root, string paper, string known)
    {
        string file = ResolvePdfSearchFile(root, paper, true), signature = PdfSearchSignature(file);
        if (File.Exists(Path.Combine(Path.GetDirectoryName(file), "markdown.md")))
            return new { paper = paper, eligible = false, signature = "", size = 0L, cached = false,
                title = "", text = (string)null, status = "markdown", pages = 0 };
        string cachePath = PdfSearchCachePath(file); PdfSearchRecord record = null;
        lock (PdfSearchLock)
        {
            PdfSearchMemory.TryGetValue(cachePath, out record);
            if (record == null && File.Exists(cachePath)) try
            {
                record = Json.Deserialize<PdfSearchRecord>(File.ReadAllText(cachePath, Encoding.UTF8));
                if (record != null) PdfSearchMemory[cachePath] = record;
            }
            catch { record = null; }
        }
        bool cached = record != null && record.schema == PdfSearchSchema && record.signature == signature &&
            record.text != null && record.text.Length <= 800 && record.pages <= 1;
        return new { paper = paper, eligible = true, signature = signature, size = new FileInfo(file).Length, cached = cached,
            title = "", text = cached && known != signature ? record.text : null,
            status = cached ? record.status : "pending", pages = cached ? record.pages : 0 };
    }
    private static void SavePdfSearch(Stream stream, string body)
    {
        var request = Json.Deserialize<PdfSearchSaveRequest>(body);
        if (request == null || request.text == null || request.text.Length > 800 ||
            !String.IsNullOrEmpty(request.title) || request.pages < 0 || request.pages > 1 ||
            (request.status != "ready" && request.status != "empty" && request.status != "password"))
            throw new InvalidDataException("PDF 搜索索引内容无效。");
        lock (StateLock)
        {
            string file = ResolvePdfSearchFile(request.root, request.paper);
            if (PdfSearchSignature(file) != request.signature) throw new InvalidOperationException("PDF 已更新，本次索引未保存。");
            var record = new PdfSearchRecord { schema = PdfSearchSchema, signature = request.signature,
                title = request.title ?? "", text = request.text, status = request.status, pages = request.pages };
            string cachePath = PdfSearchCachePath(file);
            lock (PdfSearchLock) { AtomicWrite(cachePath, Json.Serialize(record)); PdfSearchMemory[cachePath] = record; }
        }
        WriteJson(stream, new { saved = true });
    }
    private static void ServePdfSearchSource(Stream stream, string root, string paper, string signature, Dictionary<string, string> headers)
    {
        string file = ResolvePdfSearchFile(root, paper);
        if (PdfSearchSignature(file) != signature) throw new InvalidOperationException("PDF 已更新，请重新读取索引。");
        string range; headers.TryGetValue("range", out range);
        WriteFile(stream, file, "application/pdf", range);
    }
}
