using System;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;

internal static partial class MinerULibraryReview
{
    private const string NoteImagePrefix = "paperbench-note-images/";
    private static string NoteImageDirectory { get { return Path.Combine(AttachmentDirectory, "_note-images"); } }

    private static string ResolveNoteImage(string file)
    {
        if (String.IsNullOrEmpty(file) || !Regex.IsMatch(file, @"\A[a-f0-9]{64}\.(png|jpg|gif|webp|bmp)\z"))
            throw new InvalidDataException("笔记图片名称无效。");
        string path = Path.Combine(NoteImageDirectory, file);
        MaterialNoLinks(path);
        if (!File.Exists(path)) throw new FileNotFoundException("笔记图片不存在，请确认附件目录已同步。", file);
        return path;
    }

    private static void SaveNoteImage(Stream stream, string paper, byte[] bytes)
    {
        string directory = ResolvePaper(paper);
        if (FindPdf(directory) == null) throw new InvalidDataException("请先选择一篇论文。");
        if (bytes == null || bytes.Length == 0 || bytes.Length > 10 * 1024 * 1024)
            throw new InvalidDataException("单张图片不能超过 10 MB。");
        string extension = null;
        if (bytes.Length >= 8 && bytes[0] == 137 && bytes[1] == 80 && bytes[2] == 78 && bytes[3] == 71 && bytes[4] == 13 && bytes[5] == 10 && bytes[6] == 26 && bytes[7] == 10) extension = ".png";
        else if (bytes.Length >= 3 && bytes[0] == 255 && bytes[1] == 216 && bytes[2] == 255) extension = ".jpg";
        else if (bytes.Length >= 6 && (Encoding.ASCII.GetString(bytes, 0, 6) == "GIF87a" || Encoding.ASCII.GetString(bytes, 0, 6) == "GIF89a")) extension = ".gif";
        else if (bytes.Length >= 12 && Encoding.ASCII.GetString(bytes, 0, 4) == "RIFF" && Encoding.ASCII.GetString(bytes, 8, 4) == "WEBP") extension = ".webp";
        else if (bytes.Length >= 26 && bytes[0] == 66 && bytes[1] == 77) extension = ".bmp";
        if (extension == null) throw new InvalidDataException("支持 PNG、JPEG、GIF、WebP 和 BMP 图片。");
        string hash;
        using (SHA256 sha = SHA256.Create()) hash = BitConverter.ToString(sha.ComputeHash(bytes)).Replace("-", "").ToLowerInvariant();
        string file = hash + extension;
        lock (StateLock)
        {
            MaterialNoLinks(NoteImageDirectory);
            Directory.CreateDirectory(NoteImageDirectory);
            string target = Path.Combine(NoteImageDirectory, file);
            MaterialNoLinks(target);
            if (!File.Exists(target))
            {
                // Publish a complete file atomically so concurrent imports/sync never see a partial image.
                string temporary = Path.Combine(NoteImageDirectory, Guid.NewGuid().ToString("N") + ".tmp");
                try
                {
                    File.WriteAllBytes(temporary, bytes);
                    try { File.Move(temporary, target); }
                    catch (IOException) { if (!File.Exists(target)) throw; }
                }
                finally { if (File.Exists(temporary)) File.Delete(temporary); }
            }
        }
        WriteJson(stream, new { file = NoteImagePrefix + file });
    }
}
