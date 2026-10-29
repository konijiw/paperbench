using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Net;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Xml;
using System.Xml.Linq;

internal static partial class MinerULibraryReview
{
    private sealed class CitationMatch
    {
        public string title { get; set; }
        public string authors { get; set; }
        public string year { get; set; }
        public string venue { get; set; }
        public string doi { get; set; }
        public string arxiv { get; set; }
        public string bib { get; set; }
        public string source { get; set; }
        public double similarity { get; set; }
    }

    private static readonly object CitationNetworkLock = new object();
    private static readonly Dictionary<string, string> CitationNetworkCache = new Dictionary<string, string>();
    private static DateTime CitationLastRequest = DateTime.MinValue;

    private static string CitationFetch(string url, string accept)
    {
        // Serialize requests, respect arXiv's three-second interval, cache successful responses.
        lock (CitationNetworkLock)
        {
            string cached;
            if (CitationNetworkCache.TryGetValue(url, out cached)) return cached;
            int delay = (int)(3000 - (DateTime.UtcNow - CitationLastRequest).TotalMilliseconds);
            if (delay > 0) Thread.Sleep(delay);
            CitationLastRequest = DateTime.UtcNow;
            ServicePointManager.SecurityProtocol |= SecurityProtocolType.Tls12;
            var request = (HttpWebRequest)WebRequest.Create(url);
            request.Accept = accept;
            request.UserAgent = "LiteratureReader/1.1 (personal bibliography tool)";
            request.Timeout = 20000;
            request.ReadWriteTimeout = 20000;
            using (var response = request.GetResponse())
            using (var reader = new StreamReader(response.GetResponseStream(), Encoding.UTF8))
            {
                var result = new StringBuilder();
                char[] buffer = new char[4096];
                int n;
                while ((n = reader.Read(buffer, 0, buffer.Length)) > 0)
                {
                    result.Append(buffer, 0, n);
                    if (result.Length > 2000000) throw new IOException("查询返回的数据过大。");
                }
                if (CitationNetworkCache.Count >= 100) CitationNetworkCache.Clear();
                return CitationNetworkCache[url] = result.ToString();
            }
        }
    }

    private static string CleanDoi(string value)
    {
        string doi = WebUtility.HtmlDecode((value ?? "").Trim()).Replace("\u00ad", "");
        doi = Regex.Replace(doi, @"^(https?://(dx\.)?doi\.org/|doi:\s*)", "", RegexOptions.IgnoreCase);
        try { doi = Uri.UnescapeDataString(doi); } catch { }
        doi = Regex.Split(doi, @"[\s<>""{}\[\]?#&]")[0];
        doi = doi.TrimEnd('.', ',', ';', ':');
        while (doi.EndsWith(")") && doi.Count(c => c == ')') > doi.Count(c => c == '(')) doi = doi.Substring(0, doi.Length - 1);
        return doi;
    }

    private static string ArxivIdentifier(string value, bool bare)
    {
        string prefix = bare ? @"(?:^|arxiv[._-]|arxiv\s*:\s*|arxiv\.org/(?:abs|pdf)/|10\.48550/arxiv[./])" : @"(?:arxiv\s*:\s*|arxiv\.org/(?:abs|pdf)/|10\.48550/arxiv[./])";
        Match match = Regex.Match(value ?? "", prefix + @"(?<id>(?:\d{4}\.\d{4,5}|[a-z][a-z.\-]+/\d{7})(?:v\d+)?)(?:\.pdf)?(?=$|[^a-z0-9])", RegexOptions.IgnoreCase);
        return match.Success ? match.Groups["id"].Value : "";
    }

    private static bool CitationTitleBoundary(string line)
    {
        if (Regex.IsMatch(line, @"https?://|\b[\w.-]+\.(?:com|org|edu|net)(?:/|$)|@|©|abstract|university|institute|department|correspondence|copyright|downloaded|transactions on|journal of|^robotics research$|^robotics: science and systems|original article|article reuse|\bvol\.\s*\d|research article|full author list|contributions and acknowledg|bytedance|\bet al\b|\bmember,?\s*ieee|\bsci\.\s*adv|^date\s*:|^preprint$|^\d+\s+of\s+\d+", RegexOptions.IgnoreCase)) return true;
        if (Regex.Matches(line, @"[,;]").Count >= 2 || Regex.IsMatch(line, @"^[A-Z][a-z]+(?:\s+[A-Z]\.)?\s+[A-Z][a-z]+\s*,\s*[A-Z][a-z]+(?:\s+[A-Z]\.)?\s+[A-Z][a-z]+")) return true;
        var groups = Regex.Split(line.Trim(), @"\s{3,}");
        return groups.Length >= 2 && groups.Count(x => Regex.IsMatch(x, @"\b[A-Z][a-z]+\s+(?:[A-Z]\.\s*)?[A-Z][a-z]+\b")) >= 2;
    }
    private static string GuessCitationTitle(string text)
    {
        var lines = (text ?? "").Split('\n').Take(45).Select(x => x.Replace("\u00ad", "").Trim()).ToArray();
        for (int i = 0; i < lines.Length; i++)
        {
            string line = lines[i];
            bool shortHeading = line.EndsWith(":") && Regex.Matches(line, "[a-zA-Z]").Count >= 4;
            if ((!shortHeading && (line.Length < 18 || Regex.Matches(line, "[a-zA-Z]").Count < 12)) || line.Length > 220 ||
                CitationTitleBoundary(line) || Regex.Matches(line, @"\b[a-zA-Z]\b").Count > 8) continue;
            string title = line;
            for (int j = i + 1; j < Math.Min(lines.Length, i + 5); j++)
            {
                string next = lines[j];
                if (next == "") continue;
                if (CitationTitleBoundary(next) || next.Length < 8 || Regex.Matches(next, "[a-zA-Z]").Count < 4 || Regex.IsMatch(next,@"\d\s*[*†‡]?$")) break;
                title += " " + next;
                if (title.Length > 260) break;
            }
            return Regex.Replace(Regex.Replace(title, @"(?<=\p{L})-\s+(?=\p{Ll})", "-"), @"\s+", " ").Trim();
        }
        return "";
    }

    private static string BibEscape(string value)
    {
        string text = WebUtility.HtmlDecode(Regex.Replace(value ?? "", "<[^>]+>", ""));
        var result = new StringBuilder();
        foreach (char c in Regex.Replace(text, @"\s+", " ").Trim())
        {
            if (c == '\\') result.Append(@"\textbackslash{}");
            else if ("{}$%&#_".IndexOf(c) >= 0) result.Append('\\').Append(c);
            else if (c == '^') result.Append(@"\textasciicircum{}");
            else if (c == '~') result.Append(@"\textasciitilde{}");
            else result.Append(c);
        }
        return result.ToString();
    }

    private static string MakeCitationBib(string type, string key, Dictionary<string, string> fields)
    {
        return "@" + type + "{" + key + ",\n" + String.Join(",\n", fields.Where(x => !String.IsNullOrWhiteSpace(x.Value)).Select(x => "  " + x.Key + " = {" + BibEscape(x.Value) + "}")) + "\n}\n";
    }

    private static string CitationKeyAscii(string value)
    {
        var text = new StringBuilder();
        foreach (char c in (value ?? "").Normalize(NormalizationForm.FormD))
            if ((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9')) text.Append(c);
            else if (System.Globalization.CharUnicodeInfo.GetUnicodeCategory(c) != System.Globalization.UnicodeCategory.NonSpacingMark) text.Append(' ');
        return text.ToString();
    }
    private static string CitationKeyCap(string value) { return value.Length == 0 ? "" : Char.ToUpperInvariant(value[0]) + value.Substring(1); }
    private static readonly HashSet<string> CitationKeyStopWords = new HashSet<string>(
        "a an the of on in for to and or with by from as at into via is are be its this that using based toward towards study design approach method".Split(' '), StringComparer.OrdinalIgnoreCase);
    private static string[] CitationKeyWords(string value)
    {
        return CitationKeyAscii(value).Split(new[] { ' ' }, StringSplitOptions.RemoveEmptyEntries)
            .Where(x => !CitationKeyStopWords.Contains(x)).ToArray();
    }
    private static string MakeReadableCitationKey(string author, string year, string title)
    {
        string first = Regex.Split(author ?? "", @"\s+and\s+|;", RegexOptions.IgnoreCase)[0].Trim().Trim('{', '}');
        string family = first.Contains(",") ? first.Split(',')[0] : first.Split(new[] { ' ' }, StringSplitOptions.RemoveEmptyEntries).LastOrDefault() ?? "";
        string surname = String.Concat(CitationKeyAscii(family).Split(new[] { ' ' }, StringSplitOptions.RemoveEmptyEntries).Select(CitationKeyCap));
        if (surname == "") surname = "Anon";
        Match date = Regex.Match(year ?? "", @"(?:19|20)\d{2}");
        string datePart = date.Success ? date.Value : "Nd";
        string[] words = CitationKeyWords(title);
        int colon = (title ?? "").IndexOf(':');
        if (colon > 0)
        {
            string[] name = CitationKeyWords(title.Substring(0, colon));
            if (name.Length > 0 && name.Length <= 3) words = name;
        }
        string keywords = String.Concat(words.Take(3).Select(CitationKeyCap));
        if (keywords == "") keywords = "Paper";
        return surname.Substring(0, Math.Min(32, surname.Length)) + datePart + keywords.Substring(0, Math.Min(36, keywords.Length));
    }
    private static string UniqueCitationKey(string original, HashSet<string> occupied)
    {
        string key = original;
        for (int index = 1; occupied.Contains(key); index++)
        {
            int n = index; string suffix = "";
            while (n > 0) { n--; suffix = (char)('a' + n % 26) + suffix; n /= 26; }
            key = original + suffix;
        }
        return key;
    }
    private static Dictionary<string, object> Obj(object value) { return value as Dictionary<string, object> ?? new Dictionary<string, object>(); }
    private static IEnumerable<object> Arr(object value) { return value as object[] ?? new object[0]; }
    private static object Field(Dictionary<string, object> obj, string key) { object value; return obj.TryGetValue(key, out value) ? value : null; }
    private static string Str(Dictionary<string, object> obj, string key) { return Convert.ToString(Field(obj, key)) ?? ""; }
    private static string First(Dictionary<string, object> obj, string key) { return Convert.ToString(Arr(Field(obj, key)).FirstOrDefault()) ?? ""; }

    private static List<CitationMatch> ParseCrossref(string json)
    {
        var root = Obj(Json.DeserializeObject(json));
        var results = new List<CitationMatch>();
        foreach (object item in Arr(Field(Obj(Field(root, "message")), "items")))
        {
            var work = Obj(item);
            string title = First(work, "title"), doi = Str(work, "DOI");
            if (title == "" || doi == "") continue;
            var authors = Arr(Field(work, "author")).Select(x => Obj(x)).Select(x => Str(x, "family") != "" ? Str(x, "family") + ", " + Str(x, "given") : Str(x, "name")).Where(x => x != "").ToArray();
            var date = Obj(Field(work, "issued"));
            string year = Convert.ToString(Arr(Arr(Field(date, "date-parts")).FirstOrDefault()).FirstOrDefault()) ?? "";
            string venue = First(work, "container-title"), kind = Str(work, "type");
            string type = kind == "journal-article" ? "article" : kind == "proceedings-article" ? "inproceedings" : kind == "book" ? "book" : kind == "book-chapter" ? "incollection" : "misc";
            string key = MakeReadableCitationKey(authors.FirstOrDefault(), year, title);
            var fields = new Dictionary<string, string> { { "title", title }, { "author", String.Join(" and ", authors) }, { "year", year }, { "doi", doi }, { "url", "https://doi.org/" + doi }, { "volume", Str(work, "volume") }, { "number", Str(work, "issue") }, { "pages", Str(work, "page").Replace("–", "--") }, { "publisher", Str(work, "publisher") } };
            if (fields["pages"] == "") fields["pages"] = Str(work, "article-number");
            fields[type == "inproceedings" || type == "incollection" ? "booktitle" : type == "article" ? "journal" : "howpublished"] = venue;
            results.Add(new CitationMatch { title = WebUtility.HtmlDecode(Regex.Replace(title, "<[^>]+>", "")), authors = String.Join("; ", authors), year = year, venue = venue, doi = doi, source = "Crossref", bib = MakeCitationBib(type, key, fields) });
        }
        return results;
    }

    private static List<CitationMatch> ParseArxiv(string xml)
    {
        var settings = new XmlReaderSettings { DtdProcessing = DtdProcessing.Prohibit, XmlResolver = null };
        XDocument doc;
        using (var reader = XmlReader.Create(new StringReader(xml), settings)) doc = XDocument.Load(reader);
        XNamespace atom = "http://www.w3.org/2005/Atom", ax = "http://arxiv.org/schemas/atom";
        var result = new List<CitationMatch>();
        foreach (var entry in doc.Descendants(atom + "entry"))
        {
            string id = ArxivIdentifier((string)entry.Element(atom + "id"), false);
            if (id == "") continue;
            string title = Regex.Replace((string)entry.Element(atom + "title") ?? "", @"\s+", " ").Trim();
            string[] authors = entry.Elements(atom + "author").Select(x => (string)x.Element(atom + "name") ?? "").ToArray();
            string date = (string)entry.Element(atom + "published") ?? "", year = date.Length >= 4 ? date.Substring(0, 4) : "";
            string journal = (string)entry.Element(ax + "journal_ref") ?? "", publishedDoi = (string)entry.Element(ax + "doi") ?? "";
            string note = "arXiv preprint" + (journal != "" ? "; journal reference: " + journal : "") + (publishedDoi != "" ? "; published version DOI: " + publishedDoi : "");
            var fields = new Dictionary<string, string> { { "title", title }, { "author", String.Join(" and ", authors) }, { "year", year }, { "eprint", id }, { "archivePrefix", "arXiv" }, { "primaryClass", (string)entry.Element(ax + "primary_category") != null ? (string)entry.Element(ax + "primary_category").Attribute("term") : "" }, { "url", "https://arxiv.org/abs/" + id }, { "note", note } };
            result.Add(new CitationMatch { title = title, authors = String.Join("; ", authors), year = year, venue = "arXiv（预印本）", arxiv = id, source = "arXiv", bib = MakeCitationBib("misc", MakeReadableCitationKey(authors.FirstOrDefault(), year, title), fields) });
        }
        return result;
    }

    private static double TitleSimilarity(string query, string title)
    {
        var a = new HashSet<string>(Regex.Matches(query.ToLowerInvariant(), @"[\p{L}\p{N}]+").Cast<Match>().Select(x => x.Value));
        var b = new HashSet<string>(Regex.Matches(title.ToLowerInvariant(), @"[\p{L}\p{N}]+").Cast<Match>().Select(x => x.Value));
        return a.Count + b.Count == 0 ? 0 : 2.0 * a.Intersect(b).Count() / (a.Count + b.Count);
    }

    private static object SearchCitation(string body)
    {
        var request = Json.Deserialize<Dictionary<string, string>>(body);
        string query = (request.ContainsKey("query") ? request["query"] : "").Trim();
        string source = request.ContainsKey("source") ? request["source"] : "crossref";
        if (query.Length < 4 || query.Length > 600) throw new InvalidDataException("请输入论文标题（4～600 字符），也可加作者姓名。");
        var matches = new List<CitationMatch>();
        var warnings = new List<string>();
        if (source == "crossref" || source == "all")
            try { matches.AddRange(ParseCrossref(CitationFetch("https://api.crossref.org/works?rows=5&query.bibliographic=" + Uri.EscapeDataString(query), "application/json"))); }
            catch (Exception ex) { warnings.Add("Crossref 查询失败：" + ex.Message); }
        if (source == "arxiv" || source == "all")
            try { matches.AddRange(ParseArxiv(CitationFetch("https://export.arxiv.org/api/query?search_query=" + Uri.EscapeDataString("ti:\"" + query.Replace("\"", " ") + "\"") + "&max_results=5", "application/atom+xml"))); }
            catch (Exception ex) { warnings.Add("arXiv 查询失败：" + ex.Message); }
        foreach (var match in matches) match.similarity = TitleSimilarity(query, match.title);
        return new { matches = matches.OrderByDescending(x => x.similarity).ToArray(), warning = String.Join("\n", warnings), hint = "搜索结果不等于准确匹配。请核对标题、作者、年份及预印本/正式版，再选择。" };
    }

    private static CitationMatch GetArxivMatch(string value)
    {
        string id = ArxivIdentifier((value ?? "").Trim(), true);
        if (id == "") throw new InvalidDataException("请输入 arXiv 编号或 arxiv.org 文章链接。");
        var matches = ParseArxiv(CitationFetch("https://export.arxiv.org/api/query?id_list=" + Uri.EscapeDataString(id), "application/atom+xml"));
        CitationMatch match = matches.FirstOrDefault(x => Regex.Replace(x.arxiv, @"v\d+$", "") == Regex.Replace(id, @"v\d+$", ""));
        if (match == null) throw new IOException("未找到此 arXiv 编号，检查编号或使用标题检索。");
        if (Regex.IsMatch(id, @"v\d+$") && match.arxiv != id) throw new IOException("服务返回的版本与指定版本不一致，请核对后用标题检索。");
        return match;
    }
    private static object LookupArxiv(string value)
    {
        CitationMatch match = GetArxivMatch(value);
        return new { bib = match.bib, arxiv = match.arxiv };
    }
}
