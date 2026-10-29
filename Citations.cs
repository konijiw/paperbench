using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Net;
using System.Text;
using System.Text.RegularExpressions;

internal static partial class MinerULibraryReview
{
    private sealed class CitationRecord
    {
        public string paper { get; set; }
        public string bib { get; set; }
        public string key { get; set; }
        public string previousBib { get; set; }
        public string previousKey { get; set; }
    }

    private static string CitationPath(string directory)
    {
        return Path.Combine(StateDirectory, "citations", Path.GetFileName(ReviewPath(directory)));
    }

    private static CitationRecord ReadCitation(string directory)
    {
        string path = CitationPath(directory);
        if (!File.Exists(path)) return new CitationRecord { bib = "", key = "" };
        return Json.Deserialize<CitationRecord>(File.ReadAllText(path, Encoding.UTF8));
    }

    private static void SaveCitation(Stream stream, string body)
    {
        CitationRecord record = Json.Deserialize<CitationRecord>(body);
        string directory = ResolvePaper(record.paper);
        if (FindPdf(directory) == null) throw new InvalidDataException("该论文没有 PDF。");
        if (record.bib == null || record.bib.Length > 131072 || !Regex.IsMatch(record.key ?? "", @"^[A-Za-z0-9_:.+-]+$"))
            throw new InvalidDataException("请填写有效的文献数据和引用键。");
        Match header = Regex.Match(record.bib, @"^\s*@[a-zA-Z]+\s*\{\s*([^,\s]+)\s*,");
        if (!header.Success || header.Groups[1].Value != record.key) throw new InvalidDataException("引用键与文献数据不一致。");
        lock (StateLock)
        {
            CitationRecord existing = ReadCitation(directory);
            var occupied = new HashSet<string>(ListCitations().Where(other => !String.Equals(other.paper, record.paper, StringComparison.OrdinalIgnoreCase)).Select(other => other.key), StringComparer.Ordinal);
            var request = Json.Deserialize<Dictionary<string, object>>(body);
            object autoKey;
            bool generated = request.TryGetValue("autoKey", out autoKey) && autoKey is bool && (bool)autoKey;
            if (occupied.Contains(record.key))
            {
                if (!generated || !String.IsNullOrWhiteSpace(ReadCitation(directory).bib))
                    throw new InvalidDataException("这个引用键已被其他论文使用，请更换引用键。");
                string oldKey = record.key;
                record.key = UniqueCitationKey(oldKey, occupied);
                record.bib = record.bib.Substring(0, header.Groups[1].Index) + record.key + record.bib.Substring(header.Groups[1].Index + oldKey.Length);
            }
            bool replaced = !String.IsNullOrWhiteSpace(existing.bib) &&
                (existing.bib != record.bib || existing.key != record.key);
            record.previousBib = replaced ? existing.bib : existing.previousBib;
            record.previousKey = replaced ? existing.key : existing.previousKey;
            AtomicWrite(CitationPath(directory), Json.Serialize(record));
        }
        WriteJson(stream, record);
    }

    private static CitationRecord UndoCitationSave(string paper)
    {
        string directory = ResolvePaper(paper);
        lock (StateLock)
        {
            CitationRecord record = ReadCitation(directory);
            if (String.IsNullOrWhiteSpace(record.previousBib) || String.IsNullOrWhiteSpace(record.previousKey))
                throw new InvalidOperationException("没有可撤销的覆盖保存记录。");
            if (ListCitations().Any(x => !String.Equals(x.paper, paper, StringComparison.OrdinalIgnoreCase) && x.key == record.previousKey))
                throw new InvalidOperationException("上一版引用键已被其他文献使用，暂时无法恢复；当前记录和上一版均已保留。");
            record.bib = record.previousBib;
            record.key = record.previousKey;
            record.previousBib = null;
            record.previousKey = null;
            AtomicWrite(CitationPath(directory), Json.Serialize(record));
            return record;
        }
    }

    private static List<CitationRecord> ListCitations()
    {
        string root = Path.Combine(StateDirectory, "citations");
        var result = new List<CitationRecord>();
        if (!Directory.Exists(root)) return result;
        foreach (string file in Directory.GetFiles(root, "*.json"))
        {
            try
            {
                CitationRecord record = Json.Deserialize<CitationRecord>(File.ReadAllText(file, Encoding.UTF8));
                string directory = ResolvePaper(record.paper);
                if (FindPdf(directory) != null && String.Equals(file, CitationPath(directory), StringComparison.OrdinalIgnoreCase)) result.Add(record);
            }
            catch { }
        }
        return result;
    }

    private static object[] ListCitationExportData()
    {
        // Read current paper tags rather than copying them into bibliography records.
        return ListCitations().Select(record => {
            string directory = ResolvePaper(record.paper);
            ReviewRecord review = LoadReview(directory);
            return (object)new { paper = record.paper, path = record.paper, title = review.title, name = Path.GetFileName(directory),
                parsedTitle = ReadParsedTitle(Path.Combine(directory, "markdown.md")), hasMarkdown = File.Exists(Path.Combine(directory, "markdown.md")), bib = record.bib, key = record.key,
                tags = review.tags ?? new List<string>() };
        }).ToArray();
    }

    private static string PdfTextTool()
    {
        var candidates = new List<string> { Path.Combine(AppDirectory, "tools", "pdftotext.exe") };
        foreach (string folder in (Environment.GetEnvironmentVariable("PATH") ?? "").Split(';'))
            if (!String.IsNullOrWhiteSpace(folder)) candidates.Add(Path.Combine(folder.Trim('"'), "pdftotext.exe"));
        // TeX Live is commonly installed outside PATH in a desktop-launched app.
        string texRoot = @"C:\texlive";
        if (Directory.Exists(texRoot))
            foreach (string folder in Directory.GetDirectories(texRoot).OrderByDescending(x => x))
                candidates.Add(Path.Combine(folder, "bin", "windows", "pdftotext.exe"));
        return candidates.FirstOrDefault(File.Exists);
    }

    private static string ReadPdfHeader(string path)
    {
        string tool = PdfTextTool();
        if (tool == null) throw new InvalidOperationException("未找到 PDF 文本提取工具。请安装 TeX Live，或把 pdftotext 及其依赖放入程序旁 tools 文件夹；仍可输入 DOI 或导入 BibTeX。");
        var start = new ProcessStartInfo(tool, "-f 1 -l 3 -enc UTF-8 -layout \"" + path + "\" -") {
            UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true,
            RedirectStandardError = true, StandardOutputEncoding = Encoding.UTF8
        };
        using (Process process = Process.Start(start))
        {
            var output = process.StandardOutput.ReadToEndAsync();
            var error = process.StandardError.ReadToEndAsync();
            if (!process.WaitForExit(20000)) { process.Kill(); throw new IOException("PDF 提取超时，请输入 DOI 或导入 BibTeX。"); }
            if (process.ExitCode != 0) throw new IOException("无法提取此 PDF 的文字，可能已加密或损坏。请输入 DOI 或导入 BibTeX。");
            return output.Result;
        }
    }

    private sealed class CitationClue
    {
        public string doi { get; set; }
        public string kind { get; set; }
        public string source { get; set; }
        public string evidence { get; set; }
    }
    private sealed class CitationScan
    {
        public List<CitationClue> candidates { get; set; }
        public string title { get; set; }
        public string verificationText { get; set; }
        public string warning { get; set; }
        public string hint { get; set; }
    }
    private static CitationScan ScanCitation(string paper)
    {
        string directory = ResolvePaper(paper);
        string pdf = FindPdf(directory);
        if (pdf == null) throw new FileNotFoundException("找不到论文 PDF。");
        string text = "", warning = "";
        try { text = ReadPdfHeader(pdf); } catch (Exception ex) { warning = ex.Message; }
        var sources = new List<KeyValuePair<string, string>> { new KeyValuePair<string, string>("PDF 前三页", text) };
        string markdown = Path.Combine(directory, "markdown.md");
        if (File.Exists(markdown))
            using (var reader = new StreamReader(markdown, Encoding.UTF8))
            {
                char[] buffer = new char[16000];
                int count = reader.Read(buffer, 0, buffer.Length);
                sources.Add(new KeyValuePair<string, string>("Markdown 开头", new string(buffer, 0, count)));
            }
        sources.Add(new KeyValuePair<string, string>("文件名或目录名", Path.GetFileName(directory) + " " + Path.GetFileName(pdf)));
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var candidates = new List<CitationClue>();
        foreach (var source in sources)
        {
            string normalized = source.Value.Replace("\u00ad", "");
            foreach (Match match in Regex.Matches(normalized, @"10\.\d{4,9}/[^\s<>""{}]+", RegexOptions.IgnoreCase))
            {
                string doi = CleanDoi(match.Value);
                while (doi.EndsWith(")") && doi.Count(c => c == ')') > doi.Count(c => c == '(')) doi = doi.Substring(0, doi.Length - 1);
                if (!seen.Add(doi)) continue;
                int begin = Math.Max(0, match.Index - 75);
                candidates.Add(new CitationClue { doi = doi, kind = "doi", source = source.Key, evidence = normalized.Substring(begin, Math.Min(220, normalized.Length - begin)) });
                if (candidates.Count >= 30) break;
            }
        }
        foreach (var source in sources)
        {
            string id = ArxivIdentifier(source.Value, false);
            if (id == "" && source.Key == "文件名或目录名")
            {
                foreach (string part in source.Value.Split(' ')) { id = ArxivIdentifier(part, true); if (id != "") break; }
            }
            if (id != "" && seen.Add("arxiv:" + id)) candidates.Insert(0, new CitationClue { doi = id, kind = "arxiv", source = source.Key, evidence = "arXiv 编号；请核对版本" });
        }
        string title = File.Exists(markdown) ? ReadParsedTitle(markdown) : "";
        if (title == "") title = GuessCitationTitle(text);
        if (String.IsNullOrWhiteSpace(text) && warning == "") warning = "PDF 没有可提取的文本，可能是扫描件。请输入 DOI 或导入 BibTeX。";
        return new CitationScan { candidates = candidates, title = title, verificationText = CitationHeaderEvidence(text, sources.FirstOrDefault(x => x.Key == "Markdown 开头").Value), warning = warning, hint = "候选可能属于参考文献，请查询后核对标题与作者，再保存。" };
    }

    private static object LookupCitation(string value)
    {
        if (ArxivIdentifier((value ?? "").Trim(), true) != "") return LookupArxiv(value);
        string doi = CleanDoi(value);
        if (!Regex.IsMatch(doi, @"^10\.\d{4,9}/\S+$") || doi.Length > 1000) throw new InvalidDataException("请输入 DOI、arXiv 编号或对应文章链接。");
        ServicePointManager.SecurityProtocol |= SecurityProtocolType.Tls12;
        var request = (HttpWebRequest)WebRequest.Create("https://doi.org/" + Uri.EscapeDataString(doi));
        request.Accept = "application/x-bibtex";
        request.UserAgent = "LiteratureReader/1.0";
        request.Timeout = 20000;
        request.ReadWriteTimeout = 20000;
        using (var response = request.GetResponse())
        using (var reader = new StreamReader(response.GetResponseStream(), Encoding.UTF8))
        {
            char[] buffer = new char[131073];
            int count = 0, read;
            while (count < buffer.Length && (read = reader.Read(buffer, count, buffer.Length - count)) > 0) count += read;
            string bib = new string(buffer, 0, count).Trim();
            if (count > 131072 || !bib.StartsWith("@")) throw new IOException("服务未返回有效的 BibTeX。可从出版社复制 BibTeX 后粘贴导入。");
            return new { bib = bib, doi = doi };
        }
    }
}
