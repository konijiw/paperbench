using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Text;
using System.Text.RegularExpressions;

internal static partial class MinerULibraryReview
{
    private static string CitationHeaderEvidence(string pdf, string markdown)
    {
        string text = String.IsNullOrWhiteSpace(pdf) ? markdown ?? "" : pdf.Split('\f')[0];
        text = text.Replace("\u00ad", "");
        Match end = Regex.Match(text, @"(?im)^\s*(?:abstract|introduction|references)\b");
        if (end.Success && end.Index > 0) text = text.Substring(0, end.Index);
        return text.Substring(0, Math.Min(3500, text.Length));
    }

    private static string NormalizeCitationEvidence(string value)
    {
        string raw = (value ?? "").Replace("\u00ad", "").Normalize(NormalizationForm.FormD);
        var result = new StringBuilder();
        foreach (char c in raw)
            if (CharUnicodeInfo.GetUnicodeCategory(c) != UnicodeCategory.NonSpacingMark)
                result.Append(Char.IsLetterOrDigit(c) ? Char.ToLowerInvariant(c) : ' ');
        return Regex.Replace(result.ToString(), @"\s+", " ").Trim();
    }

    private static bool CitationAuthorMatches(CitationMatch match, string evidence)
    {
        string header = " " + NormalizeCitationEvidence(Regex.Replace(evidence ?? "", @"(?<=[\p{L}])[\d¹²³⁴⁵⁶⁷⁸⁹⁰]+", " ")) + " ";
        var authors = (match.authors ?? "").Split(';').Select(x => x.Trim()).Where(x => x.Length > 0).ToArray();
        var families = new HashSet<string>();
        bool firstMatched = false;
        for (int i = 0; i < authors.Length; i++)
        {
            string[] parts = authors[i].Split(',');
            string family = parts.Length > 1 ? parts[0] : authors[i].Split(' ').Last();
            family = NormalizeCitationEvidence(family);
            if (family.Length < 2 || !header.Contains(" " + family + " ")) continue;
            if (i == 0) firstMatched = true;
            families.Add(family);
        }
        if (!firstMatched) return false;
        if (authors.Length > 1) return families.Count >= 2;
        // A single common surname is insufficient: require a full given name too.
        string given = authors.Length == 1 ? (authors[0].Contains(",") ? authors[0].Split(',')[1] : authors[0].Split(' ')[0]) : "";
        return NormalizeCitationEvidence(given).Split(' ').Any(x => x.Length >= 3 && header.Contains(" " + x + " "));
    }

    private static bool CitationTitleMatches(string a, string b)
    {
        string left = NormalizeCitationEvidence(a), right = NormalizeCitationEvidence(b);
        // Exact normalized titles cover case, punctuation, accents and PDF line wrapping.
        // Similarity alone can hide a changed number, negation, or word order.
        return left.Length >= 16 && left == right;
    }

    private static bool CanAutoAcceptCitation(CitationScan scan, CitationMatch match, List<CitationMatch> alternatives)
    {
        var titles = (scan.alternateTitles ?? new List<string>()).Concat(new[] { scan.title }).Where(x => !String.IsNullOrWhiteSpace(x)).Distinct().ToList();
        bool identifierMatches = scan.candidates.Any(x => x.kind == "doi" && !String.IsNullOrEmpty(match.doi) && String.Equals(CleanDoi(x.doi), CleanDoi(match.doi), StringComparison.OrdinalIgnoreCase)) ||
            scan.candidates.Any(x => x.kind == "arxiv" && !String.IsNullOrEmpty(match.arxiv) && (Regex.IsMatch(x.doi, @"v\d+$") ? x.doi == match.arxiv : Regex.Replace(x.doi, @"v\d+$", "") == Regex.Replace(match.arxiv, @"v\d+$", "")));
        bool titleMatches = titles.Any(x => CitationTitleMatches(x, match.title));
        // PDF small caps may split a word. Ignore these spaces only with a matching identifier.
        if (!titleMatches && identifierMatches) titleMatches = titles.Any(x => NormalizeCitationEvidence(x).Replace(" ", "") == NormalizeCitationEvidence(match.title).Replace(" ", ""));
        bool deferredAuthors = Regex.IsMatch(scan.verificationText ?? "", @"full author list.*(?:contributions|acknowledg)", RegexOptions.IgnoreCase);
        if (!titleMatches || (!CitationAuthorMatches(match, scan.verificationText) && !(identifierMatches && deferredAuthors))) return false;
        var years = Regex.Matches(scan.verificationText ?? "", @"\b(?:19|20)\d{2}\b").Cast<Match>().Select(x => x.Value).Distinct().ToArray();
        if (years.Length > 0 && !String.IsNullOrEmpty(match.year) && !years.Contains(match.year)) return false;
        // Preserve the arXiv identity and explicit version even if a journal shares its title.
        var arxiv = scan.candidates.Where(x => x.kind == "arxiv").ToArray();
        if (arxiv.Length > 0 && !arxiv.Any(x => !String.IsNullOrEmpty(match.arxiv) &&
            (Regex.IsMatch(x.doi, @"v\d+$") ? x.doi == match.arxiv : Regex.Replace(x.doi, @"v\d+$", "") == Regex.Replace(match.arxiv, @"v\d+$", "")))) return false;
        string identity = CitationMatchIdentity(match);
        return !alternatives.Any(x => CitationMatchIdentity(x) != identity && TitleSimilarity(scan.title, x.title) >= 0.88);
    }

    private static string CitationMatchIdentity(CitationMatch match)
    {
        return !String.IsNullOrEmpty(match.arxiv) ? "arxiv:" + match.arxiv.ToLowerInvariant() : "doi:" + (match.doi ?? "").ToLowerInvariant();
    }

    private static CitationRecord StoreRecognizedCitation(string paper, string bib)
    {
        string directory = ResolvePaper(paper);
        lock (StateLock)
        {
            CitationRecord existing = ReadCitation(directory);
            if (!String.IsNullOrWhiteSpace(existing.bib)) return existing;
            Match entry = Regex.Match(bib ?? "", @"^\s*@[a-zA-Z]+\s*\{\s*([^,\s]+)\s*,");
            if (!entry.Success) throw new InvalidDataException("识别结果不是有效的文献条目。");
            string original = entry.Groups[1].Value;
            var occupied = new HashSet<string>(ListCitations().Select(x => x.key), StringComparer.Ordinal);
            string key = UniqueCitationKey(original, occupied);
            bib = bib.Substring(0, entry.Groups[1].Index) + key + bib.Substring(entry.Groups[1].Index + original.Length);
            var record = new CitationRecord { paper = paper, bib = bib, key = key };
            AtomicWrite(CitationPath(directory), Json.Serialize(record));
            return record;
        }
    }

    private sealed class RecognitionResult
    {
        public string status { get; set; }
        public string reason { get; set; }
        public string warning { get; set; }
        public string bib { get; set; }
        public string key { get; set; }
        public string previousBib { get; set; }
        public string previousKey { get; set; }
        public string title { get; set; }
        public List<CitationClue> candidates { get; set; }
        public List<CitationMatch> matches { get; set; }
    }

    private static RecognitionResult RecognizeCitation(string paper)
    {
        string directory = ResolvePaper(paper);
        CitationRecord existing = ReadCitation(directory);
        if (!String.IsNullOrWhiteSpace(existing.bib)) return new RecognitionResult { status = "existing", bib = existing.bib, key = existing.key, previousBib = existing.previousBib, previousKey = existing.previousKey, reason = "这篇论文已有保存的信息，可直接复制或导出；如需修改，可使用编号查询或标题检索。" };
        CitationScan scan = ScanCitation(paper);
        var matches = new List<CitationMatch>();
        var warnings = new List<string>();
        if (!String.IsNullOrEmpty(scan.warning)) warnings.Add(scan.warning);
        var result = new RecognitionResult { status = "review", title = scan.title, candidates = scan.candidates, matches = matches };
        bool hasArxiv = scan.candidates.Any(x => x.kind == "arxiv");
        foreach (CitationClue clue in scan.candidates.Where(x => !hasArxiv || x.kind == "arxiv").Take(2))
        {
            try
            {
                if (clue.kind == "arxiv")
                {
                    var retrieved = ParseArxiv(CitationFetch("https://export.arxiv.org/api/query?id_list=" + Uri.EscapeDataString(clue.doi), "application/atom+xml"))
                        .Where(x => Regex.Replace(x.arxiv ?? "", @"v\d+$", "") == Regex.Replace(clue.doi, @"v\d+$", "")).ToList();
                    if (retrieved.Count == 0) throw new IOException("编号未返回结果。");
                    matches.AddRange(retrieved);
                    if (Regex.IsMatch(clue.doi, @"v\d+$") && retrieved.All(x => x.arxiv != clue.doi)) warnings.Add("查询结果的 arXiv 版本与论文不一致。");
                }
                else
                {
                    var response = Obj(Json.DeserializeObject(CitationFetch("https://api.crossref.org/works/" + Uri.EscapeDataString(clue.doi), "application/json")));
                    matches.AddRange(ParseCrossref(Json.Serialize(new { message = new { items = new[] { Field(response, "message") } } })));
                }
            }
            catch (Exception) { warnings.Add("部分编号未能查询成功，可手动查询或重试。"); }
        }
        // Always compare all retrieved identifier candidates, never accept the first DOI alone.
        var unique = matches.GroupBy(CitationMatchIdentity).Select(x => x.First()).ToList();
        CitationMatch chosen = unique.FirstOrDefault(x => CanAutoAcceptCitation(scan, x, unique));
        if (chosen == null && scan.title.Length >= 4)
        {
            string[] sources = hasArxiv ? new[] { "arxiv", "crossref" } : new[] { "crossref", "arxiv" };
            foreach (string query in (scan.alternateTitles ?? new List<string>()).Concat(new[] { scan.title }).Where(x => !String.IsNullOrWhiteSpace(x)).Distinct().Take(3))
            {
                foreach (string source in sources)
                {
                    try
                    {
                        if (source == "crossref") matches.AddRange(ParseCrossref(CitationFetch("https://api.crossref.org/works?rows=5&query.bibliographic=" + Uri.EscapeDataString(query), "application/json")));
                        else matches.AddRange(ParseArxiv(CitationFetch("https://export.arxiv.org/api/query?search_query=" + Uri.EscapeDataString("ti:\"" + query.Replace("\"", " ") + "\"") + "&max_results=5", "application/atom+xml")));
                    }
                    catch (Exception) { warnings.Add("部分标题检索未能完成，可重试或手动检索。"); }
                    unique = matches.GroupBy(CitationMatchIdentity).Select(x => x.First()).ToList();
                    chosen = unique.FirstOrDefault(x => CanAutoAcceptCitation(scan, x, unique));
                    if (chosen != null) break;
                }
                if (chosen != null) break;
            }
        }
        if (chosen != null)
        {
            CitationRecord saved = StoreRecognizedCitation(paper, chosen.bib);
            result.status = "saved"; result.bib = saved.bib; result.key = saved.key; result.previousBib = saved.previousBib; result.previousKey = saved.previousKey;
            result.reason = "已识别并自动保存：标题与作者吻合。可直接复制引用或导出，也可手动修正。";
        }
        else
        {
            foreach (var match in unique) match.similarity = TitleSimilarity(scan.title, match.title);
            result.matches = unique.OrderByDescending(x => x.similarity).Take(10).ToList();
            result.status = result.matches.Count == 0 && scan.candidates.Count == 0 ? "not_found" : "review";
            result.reason = result.status == "not_found" ? "未找到可靠结果，请补充标题、编号或导入 BibTeX。" : "结果仍需确认（标题、作者、年份或版本不够明确）。请选用正确条目后保存。";
        }
        result.warning = String.Join("\n", warnings.Distinct());
        return result;
    }
}
