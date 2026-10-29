using System;
using System.Collections.Generic;
using System.IO;
using System.IO.Compression;
using System.Reflection;

internal static partial class MinerULibraryReview
{
    private static void ServePdfReader(Stream stream, string path)
    {
        string relative = path.Substring("/pdf-reader/".Length);
        if (relative.Length == 0) relative = "index.html";
        // Entries are read directly from an embedded archive, never extracted.
        if (relative.Contains("..") || relative.Contains("\\")) { WriteJsonError(stream, 404, "文件不存在。"); return; }
        using (Stream resource = Assembly.GetExecutingAssembly().GetManifestResourceStream("PdfReaderBundle"))
        using (ZipArchive archive = new ZipArchive(resource, ZipArchiveMode.Read))
        {
            ZipArchiveEntry entry = archive.GetEntry(relative);
            if (entry == null) { WriteJsonError(stream, 404, "文件不存在。"); return; }
            string extension = Path.GetExtension(relative).ToLowerInvariant();
            string mime = extension == ".mjs" ? "application/javascript; charset=utf-8" :
                extension == ".html" ? "text/html; charset=utf-8" :
                extension == ".css" ? "text/css; charset=utf-8" :
                extension == ".wasm" ? "application/wasm" : MimeType(relative);
            using (Stream input = entry.Open())
            using (MemoryStream output = new MemoryStream())
            {
                input.CopyTo(output);
                WriteBytes(stream, 200, output.ToArray(), mime, new Dictionary<string, string> {
                    { "Content-Security-Policy", "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data: blob:; worker-src 'self'; frame-src 'self'; object-src 'none'; frame-ancestors 'self'" }
                });
            }
        }
    }

    private sealed class PdfAnchor
    {
        public int version { get; set; }
        public string fingerprint { get; set; }
        public List<PdfFragment> fragments { get; set; }
    }
    private sealed class PdfFragment
    {
        public int page { get; set; }
        public List<double[]> quads { get; set; }
        public List<PdfTextRange> textRanges { get; set; }
    }
    private sealed class PdfTextRange
    {
        public int span { get; set; }
        public string text { get; set; }
        public int start { get; set; }
        public int end { get; set; }
    }
}
