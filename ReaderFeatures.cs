using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using System.Text.RegularExpressions;

internal static partial class MinerULibraryReview
{
    private static long LibraryRevision = 1;
    private static FileSystemWatcher LibraryWatcher;
    private static FileSystemWatcher AttachmentRecordsWatcher;
    private static readonly object AttachmentLock = new object();
    private static readonly object TitleCacheLock = new object();
    private static readonly object PdfImportLock = new object();
    private static readonly Dictionary<string, PendingPdfImport> PendingPdfImports = new Dictionary<string, PendingPdfImport>(StringComparer.Ordinal);
    private static readonly Dictionary<string, ParsedTitleCacheEntry> ParsedTitleCache = new Dictionary<string, ParsedTitleCacheEntry>(StringComparer.OrdinalIgnoreCase);

    private sealed class ParsedTitleCacheEntry
    {
        public long size;
        public long ticks;
        public string title;
    }

    private static string ReadParsedTitle(string markdownPath)
    {
        try
        {
            FileInfo info = new FileInfo(markdownPath);
            ParsedTitleCacheEntry cached;
            lock (TitleCacheLock)
                if (ParsedTitleCache.TryGetValue(markdownPath, out cached) && cached.size == info.Length && cached.ticks == info.LastWriteTimeUtc.Ticks)
                    return cached.title;

            string title = "";
            using (StreamReader reader = new StreamReader(markdownPath, Encoding.UTF8, true))
            {
                int lines = 0, characters = 0;
                string line;
                while (lines++ < 120 && characters < 65536 && (line = reader.ReadLine()) != null)
                {
                    characters += line.Length;
                    Match heading = Regex.Match(line, @"^\s*#\s+(.+?)\s*#*\s*$");
                    if (!heading.Success) continue;
                    string candidate = Regex.Replace(heading.Groups[1].Value, @"<[^>]+>", "").Trim(' ', '\t', '*', '_', '`');
                    if (candidate.Length < 8 || candidate.Length > 300) continue;
                    if (Regex.IsMatch(candidate, @"^(abstract|introduction|references|contents|supplementary (information|materials?))$", RegexOptions.IgnoreCase)) continue;
                    title = candidate;
                    break;
                }
            }
            lock (TitleCacheLock) ParsedTitleCache[markdownPath] = new ParsedTitleCacheEntry { size = info.Length, ticks = info.LastWriteTimeUtc.Ticks, title = title };
            return title;
        }
        catch { return ""; }
    }

    private sealed class AttachmentLink
    {
        public string id { get; set; }
        public string parent { get; set; }
        public string kind { get; set; }
        public string path { get; set; }
        public string name { get; set; }
        public string quote { get; set; }
        public string prefix { get; set; }
        public string suffix { get; set; }
        public bool deleted { get; set; }
    }

    private sealed class LinkRequest
    {
        public string id { get; set; }
        public string parent { get; set; }
        public string path { get; set; }
        public string quote { get; set; }
        public string prefix { get; set; }
        public string suffix { get; set; }
    }

    private sealed class DuplicateDeleteRequest
    {
        public string keep { get; set; }
        public string delete { get; set; }
        public string hash { get; set; }
    }

    private sealed class PdfHashCacheEntry
    {
        public long size { get; set; }
        public long ticks { get; set; }
        public string hash { get; set; }
    }

    private static string AttachmentManifestPath { get { return Path.Combine(StateDirectory, "attachments.json"); } }
    private static string AttachmentDirectory { get { return Path.Combine(AppDirectory, "attachments"); } }
    private static string AttachmentRecordsDirectory { get { return Path.Combine(AttachmentDirectory, "_links"); } }
    private static string AttachmentMigrationMarker { get { return Path.Combine(AttachmentRecordsDirectory, "schema-v1.complete"); } }
    private static string PdfHashCachePath { get { return Path.Combine(StateDirectory, "pdf-hashes.json"); } }

    private static void WatchAttachmentRecords()
    {
        Directory.CreateDirectory(AttachmentRecordsDirectory);
        AttachmentRecordsWatcher = new FileSystemWatcher(AttachmentRecordsDirectory, "*.json");
        AttachmentRecordsWatcher.NotifyFilter = NotifyFilters.FileName | NotifyFilters.Size | NotifyFilters.LastWrite;
        FileSystemEventHandler changed = delegate { Interlocked.Increment(ref LibraryRevision); };
        RenamedEventHandler renamed = delegate { Interlocked.Increment(ref LibraryRevision); };
        AttachmentRecordsWatcher.Created += changed;
        AttachmentRecordsWatcher.Deleted += changed;
        AttachmentRecordsWatcher.Changed += changed;
        AttachmentRecordsWatcher.Renamed += renamed;
        AttachmentRecordsWatcher.EnableRaisingEvents = true;
    }

    private sealed class PdfImportRequest
    {
        public string id { get; set; }
        public string name { get; set; }
        public long size { get; set; }
    }

    private sealed class PendingPdfImport
    {
        public string root;
        public string name;
        public string staging;
        public long size;
        public long received;
    }

    private static void StartPdfImport(Stream stream, string body)
    {
        PdfImportRequest request = Json.Deserialize<PdfImportRequest>(body);
        if (request == null || String.IsNullOrWhiteSpace(request.name) ||
            !String.Equals(Path.GetExtension(request.name), ".pdf", StringComparison.OrdinalIgnoreCase) ||
            request.size <= 0 || request.size > 8L * 1024 * 1024 * 1024)
            throw new InvalidDataException("请选择有效的 PDF 文件（不超过 8 GB）。");
        string root;
        lock (StateLock) root = LibraryRoot;
        string id = Guid.NewGuid().ToString("N");
        string staging = Path.Combine(root, ".pdf-import-" + id);
        lock (PdfImportLock)
        {
            Directory.CreateDirectory(staging);
            try
            {
                using (File.Create(Path.Combine(staging, "source.pdf"))) { }
                PendingPdfImports.Add(id, new PendingPdfImport { root = root, name = request.name, staging = staging, size = request.size });
            }
            catch
            {
                Directory.Delete(staging, true);
                throw;
            }
        }
        WriteJson(stream, new { id = id });
    }

    private static void AppendPdfImport(Stream stream, string id, string offsetText, byte[] bytes)
    {
        long offset;
        if (!Int64.TryParse(offsetText, out offset) || bytes == null || bytes.Length == 0 || bytes.Length > 2 * 1024 * 1024)
            throw new InvalidDataException("PDF 数据块无效。");
        lock (PdfImportLock)
        {
            PendingPdfImport pending;
            if (id == null || !PendingPdfImports.TryGetValue(id, out pending) || offset != pending.received ||
                bytes.Length > pending.size - pending.received)
                throw new InvalidDataException("PDF 上传状态不一致，请重新导入。");
            using (FileStream file = new FileStream(Path.Combine(pending.staging, "source.pdf"), FileMode.Append, FileAccess.Write, FileShare.None))
                file.Write(bytes, 0, bytes.Length);
            pending.received += bytes.Length;
        }
        WriteJson(stream, new { received = offset + bytes.Length });
    }

    private static void CompletePdfImport(Stream stream, string body)
    {
        PdfImportRequest request = Json.Deserialize<PdfImportRequest>(body);
        lock (PdfImportLock)
        {
            PendingPdfImport pending;
            if (request == null || request.id == null || !PendingPdfImports.TryGetValue(request.id, out pending) || pending.received != pending.size)
                throw new InvalidDataException("PDF 尚未传输完成。");
            string source = Path.Combine(pending.staging, "source.pdf");
            byte[] signature = new byte[1024];
            using (FileStream file = File.OpenRead(source))
                if (!Encoding.ASCII.GetString(signature, 0, file.Read(signature, 0, signature.Length)).Contains("%PDF-"))
                    throw new InvalidDataException("文件缺少 PDF 标识。");
            string name = Path.GetFileNameWithoutExtension(pending.name).Trim().TrimEnd('.');
            foreach (char invalid in Path.GetInvalidFileNameChars()) name = name.Replace(invalid, '_');
            if (name.Length > 100) name = name.Substring(0, 100).TrimEnd(' ', '.');
            if (String.IsNullOrWhiteSpace(name)) name = "论文";
            string destination = Path.Combine(pending.root, name);
            for (int suffix = 2; Directory.Exists(destination) || File.Exists(destination); suffix++)
                destination = Path.Combine(pending.root, name + " (" + suffix + ")");
            Directory.Move(pending.staging, destination);
            PendingPdfImports.Remove(request.id);
            Interlocked.Increment(ref LibraryRevision);
            WriteJson(stream, new { path = MakeRelative(pending.root, destination) });
        }
    }

    private static void CancelPdfImport(Stream stream, string body)
    {
        PdfImportRequest request = Json.Deserialize<PdfImportRequest>(body);
        lock (PdfImportLock)
        {
            PendingPdfImport pending;
            if (request != null && request.id != null && PendingPdfImports.TryGetValue(request.id, out pending))
            {
                PendingPdfImports.Remove(request.id);
                if (Directory.Exists(pending.staging)) Directory.Delete(pending.staging, true);
            }
        }
        WriteJson(stream, new { cancelled = true });
    }

    private static void WatchLibrary()
    {
        if (LibraryWatcher != null) { LibraryWatcher.Dispose(); LibraryWatcher = null; }
        if (!Directory.Exists(LibraryRoot)) return;
        LibraryWatcher = new FileSystemWatcher(LibraryRoot);
        LibraryWatcher.IncludeSubdirectories = true;
        LibraryWatcher.NotifyFilter = NotifyFilters.FileName | NotifyFilters.DirectoryName | NotifyFilters.Size | NotifyFilters.LastWrite;
        FileSystemEventHandler changed = delegate { Interlocked.Increment(ref LibraryRevision); };
        RenamedEventHandler renamed = delegate { Interlocked.Increment(ref LibraryRevision); };
        LibraryWatcher.Created += changed;
        LibraryWatcher.Deleted += changed;
        LibraryWatcher.Changed += changed;
        LibraryWatcher.Renamed += renamed;
        LibraryWatcher.EnableRaisingEvents = true;
        Interlocked.Increment(ref LibraryRevision);
    }

    private static List<TreeNode> CollectPapers(TreeNode root)
    {
        List<TreeNode> papers = new List<TreeNode>();
        CollectPapersInto(root, papers);
        return papers;
    }

    private static void CollectPapersInto(TreeNode node, List<TreeNode> papers)
    {
        if (node.paper) papers.Add(node);
        foreach (TreeNode child in node.children) CollectPapersInto(child, papers);
    }

    private static void HideLinkedPapers(TreeNode node, List<AttachmentLink> links)
    {
        HashSet<string> linked = new HashSet<string>(links.Where(x => x.kind == "parsed").Select(x => x.path), StringComparer.OrdinalIgnoreCase);
        HideLinkedPapersInto(node, linked);
    }

    private static void HideLinkedPapersInto(TreeNode node, HashSet<string> linked)
    {
        foreach (TreeNode child in node.children) HideLinkedPapersInto(child, linked);
        node.children.RemoveAll(x => x.paper && linked.Contains(x.path));
        node.children.RemoveAll(x => !x.paper && x.children.Count == 0);
    }

    private static List<AttachmentLink> LoadAttachmentLinks()
    {
        lock (AttachmentLock)
        {
            EnsureAttachmentRecords();
            return ReadAttachmentRecords();
        }
    }

    private static void SaveAttachmentLink(AttachmentLink link)
    {
        lock (AttachmentLock)
        {
            EnsureAttachmentRecords();
            ValidateAttachmentId(link.id);
            string path = Path.Combine(AttachmentRecordsDirectory, link.id + ".json");
            if (File.Exists(path))
            {
                AttachmentLink current = Json.Deserialize<AttachmentLink>(File.ReadAllText(path, Encoding.UTF8));
                if (current == null || current.deleted)
                    throw new InvalidOperationException("附件关联已删除或损坏，请刷新后重试。");
            }
            AtomicWrite(path, Json.Serialize(link));
        }
        Interlocked.Increment(ref LibraryRevision);
    }

    private static void DeleteAttachmentLink(string id)
    {
        lock (AttachmentLock)
        {
            EnsureAttachmentRecords();
            ValidateAttachmentId(id);
            AtomicWrite(Path.Combine(AttachmentRecordsDirectory, id + ".json"),
                Json.Serialize(new AttachmentLink { id = id, deleted = true }));
        }
        Interlocked.Increment(ref LibraryRevision);
    }

    private static void ValidateAttachmentId(string id)
    {
        if (String.IsNullOrEmpty(id) || !Regex.IsMatch(id, "^[a-fA-F0-9]{32}$"))
            throw new InvalidDataException("附件 ID 无效：" + id);
    }

    private static void EnsureAttachmentRecords()
    {
        if (File.Exists(AttachmentMigrationMarker)) return;
        List<AttachmentLink> legacy = new List<AttachmentLink>();
        if (File.Exists(AttachmentManifestPath))
        {
            legacy = Json.Deserialize<List<AttachmentLink>>(File.ReadAllText(AttachmentManifestPath, Encoding.UTF8));
            if (legacy == null) throw new InvalidDataException("旧附件清单无法读取，已停止迁移。");
        }
        Directory.CreateDirectory(AttachmentRecordsDirectory);
        foreach (AttachmentLink link in legacy)
        {
            ValidateAttachmentId(link.id);
            string path = Path.Combine(AttachmentRecordsDirectory, link.id + ".json");
            if (!File.Exists(path)) AtomicWrite(path, Json.Serialize(link));
        }
        foreach (AttachmentLink link in legacy)
            if (!File.Exists(Path.Combine(AttachmentRecordsDirectory, link.id + ".json")))
                throw new IOException("附件迁移未完成。");
        AtomicWrite(AttachmentMigrationMarker, "v1");
    }

    private static List<AttachmentLink> ReadAttachmentRecords()
    {
        List<AttachmentLink> result = new List<AttachmentLink>();
        foreach (string path in Directory.GetFiles(AttachmentRecordsDirectory, "*.json"))
        {
            string id = Path.GetFileNameWithoutExtension(path);
            if (!Regex.IsMatch(id, "^[a-fA-F0-9]{32}$")) continue;
            AttachmentLink link = Json.Deserialize<AttachmentLink>(File.ReadAllText(path, Encoding.UTF8));
            if (link == null || !String.Equals(link.id, id, StringComparison.OrdinalIgnoreCase))
                throw new InvalidDataException("附件记录损坏：" + path);
            if (!link.deleted) result.Add(link);
        }
        return result;
    }

    private static void ValidateParent(string parent)
    {
        string directory = ResolvePaper(parent);
        if (FindPdf(directory) == null)
            throw new InvalidOperationException("请选择一篇有 PDF 的正文论文。");
    }

    private static void LinkParsedPaper(Stream stream, string body)
    {
        LinkRequest request = Json.Deserialize<LinkRequest>(body);
        if (request == null) throw new InvalidOperationException("关联请求无效。");
        ValidateParent(request.parent);
        string directory = ResolvePaper(request.path);
        if (String.Equals(request.parent, request.path, StringComparison.OrdinalIgnoreCase)) throw new InvalidOperationException("不能把论文关联到自身。");
        if (!File.Exists(Path.Combine(directory, "markdown.md")) || FindPdf(directory) == null)
            throw new InvalidOperationException("所选支撑材料不是完整的 MinerU 解析结果。");
        List<AttachmentLink> links = LoadAttachmentLinks();
        if (links.Any(x => x.kind == "parsed" && String.Equals(x.path, request.path, StringComparison.OrdinalIgnoreCase)))
            throw new InvalidOperationException("这篇支撑材料已经关联。");
        if (links.Any(x => x.kind == "parsed" && String.Equals(x.parent, request.path, StringComparison.OrdinalIgnoreCase)))
            throw new InvalidOperationException("有其他材料关联到这篇论文，请先解除这些关联。");
        AttachmentLink link = new AttachmentLink { id = Guid.NewGuid().ToString("N"), parent = request.parent, kind = "parsed", path = request.path, name = Path.GetFileName(directory), quote = request.quote, prefix = request.prefix, suffix = request.suffix };
        SaveAttachmentLink(link);
        WriteJson(stream, link);
    }

    private static string SelectAttachmentFile()
    {
        string selected = null;
        Exception failure = null;
        ManualResetEvent finished = new ManualResetEvent(false);
        Thread thread = new Thread(delegate()
        {
            try
            {
                using (OpenFileDialog dialog = new OpenFileDialog())
                {
                    dialog.Title = "选择支撑材料";
                    dialog.Filter = "所有文件|*.*";
                    dialog.CheckFileExists = true;
                    if (dialog.ShowDialog() == DialogResult.OK) selected = dialog.FileName;
                }
            }
            catch (Exception ex) { failure = ex; }
            finally { finished.Set(); }
        });
        thread.SetApartmentState(ApartmentState.STA);
        thread.IsBackground = true;
        thread.Start();
        finished.WaitOne();
        if (failure != null) throw failure;
        return selected;
    }

    private static void AddAttachment(Stream stream, string body)
    {
        LinkRequest request = Json.Deserialize<LinkRequest>(body);
        if (request == null) throw new InvalidOperationException("附件请求无效。");
        ValidateParent(request.parent);
        string source = SelectAttachmentFile();
        if (source == null) { WriteJson(stream, new { cancelled = true }); return; }
        string id = Guid.NewGuid().ToString("N");
        string parentKey = ReviewKey(ResolvePaper(request.parent));
        string directory = Path.Combine(AttachmentDirectory, parentKey, id);
        Directory.CreateDirectory(directory);
        string destination = Path.Combine(directory, Path.GetFileName(source));
        try { File.Copy(source, destination, false); }
        catch { try { Directory.Delete(directory, true); } catch { } throw; }
        AttachmentLink link = new AttachmentLink { id = id, parent = request.parent, kind = "file", path = Path.Combine(parentKey, id, Path.GetFileName(source)), name = Path.GetFileName(source), quote = request.quote, prefix = request.prefix, suffix = request.suffix };
        try { SaveAttachmentLink(link); }
        catch { try { Directory.Delete(directory, true); } catch { } throw; }
        WriteJson(stream, link);
    }

    private static AttachmentLink GetAttachment(string id)
    {
        AttachmentLink link = LoadAttachmentLinks().FirstOrDefault(x => String.Equals(x.id, id, StringComparison.Ordinal));
        if (link == null) throw new FileNotFoundException("找不到附件关联。", id);
        return link;
    }

    private static string AttachmentFilePath(AttachmentLink link)
    {
        if (link.kind != "file") throw new InvalidOperationException("所选附件不是文件。");
        string root = Path.GetFullPath(AttachmentDirectory);
        string full = Path.GetFullPath(Path.Combine(root, link.path));
        if (!full.StartsWith(root.TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase))
            throw new UnauthorizedAccessException("附件路径超出附件库。");
        if (!File.Exists(full)) throw new FileNotFoundException("附件文件不存在。", full);
        return full;
    }

    private static void RemoveAttachment(Stream stream, string body)
    {
        LinkRequest request = Json.Deserialize<LinkRequest>(body);
        AttachmentLink link = GetAttachment(request == null ? null : request.id);
        DeleteAttachmentLink(link.id);
        if (link.kind == "file")
        {
            try { Directory.Delete(Path.GetDirectoryName(AttachmentFilePath(link)), true); }
            catch (FileNotFoundException) { }
        }
        WriteJson(stream, new { removed = true });
    }

    private static void OpenDirectory(string path, bool selectFile)
    {
        string full = Path.GetFullPath(path);
        string folder = selectFile ? Path.GetDirectoryName(full) : full;
        HashSet<IntPtr> previous = new HashSet<IntPtr>(FindExplorerWindows(folder));
        Process launched = Process.Start("explorer.exe", selectFile ? "/select,\"" + full + "\"" : "\"" + full + "\"");
        IntPtr target = IntPtr.Zero;
        IntPtr existing = IntPtr.Zero;
        for (int attempt = 0; attempt < 30; attempt++)
        {
            foreach (IntPtr window in FindExplorerWindows(folder))
            {
                existing = window;
                if (!previous.Contains(window)) { target = window; break; }
            }
            if (target != IntPtr.Zero) break;
            Thread.Sleep(100);
        }
        if (target == IntPtr.Zero) target = existing;
        if (target == IntPtr.Zero && launched != null)
        {
            try { launched.Refresh(); target = launched.MainWindowHandle; } catch { }
        }
        if (target != IntPtr.Zero) BringWindowToFront(target);
    }

    private static List<IntPtr> FindExplorerWindows(string folder)
    {
        List<IntPtr> matches = new List<IntPtr>();
        object shell = null, windows = null;
        try
        {
            Type shellType = Type.GetTypeFromProgID("Shell.Application");
            if (shellType == null) return matches;
            shell = Activator.CreateInstance(shellType);
            windows = shellType.InvokeMember("Windows", BindingFlags.InvokeMethod, null, shell, null);
            int count = Convert.ToInt32(windows.GetType().InvokeMember("Count", BindingFlags.GetProperty, null, windows, null));
            for (int index = 0; index < count; index++)
            {
                object window = null;
                try
                {
                    window = windows.GetType().InvokeMember("Item", BindingFlags.InvokeMethod, null, windows, new object[] { index });
                    if (window == null) continue;
                    string url = Convert.ToString(window.GetType().InvokeMember("LocationURL", BindingFlags.GetProperty, null, window, null));
                    Uri uri;
                    if (String.IsNullOrEmpty(url) || !Uri.TryCreate(url, UriKind.Absolute, out uri) || !uri.IsFile ||
                        !String.Equals(Path.GetFullPath(uri.LocalPath).TrimEnd('\\'), folder.TrimEnd('\\'), StringComparison.OrdinalIgnoreCase)) continue;
                    int handle = Convert.ToInt32(window.GetType().InvokeMember("HWND", BindingFlags.GetProperty, null, window, null));
                    if (handle != 0) matches.Add(new IntPtr(handle));
                }
                catch { }
                finally { if (window != null && Marshal.IsComObject(window)) Marshal.ReleaseComObject(window); }
            }
        }
        catch { }
        finally
        {
            if (windows != null && Marshal.IsComObject(windows)) Marshal.ReleaseComObject(windows);
            if (shell != null && Marshal.IsComObject(shell)) Marshal.ReleaseComObject(shell);
        }
        return matches;
    }

    private static void BringWindowToFront(IntPtr window)
    {
        ShowWindowAsync(window, 9); // SW_RESTORE
        IntPtr foreground = GetForegroundWindow();
        uint foregroundThread = foreground == IntPtr.Zero ? 0 : GetWindowThreadProcessId(foreground, IntPtr.Zero);
        uint currentThread = GetCurrentThreadId();
        bool attached = foregroundThread != 0 && foregroundThread != currentThread && AttachThreadInput(currentThread, foregroundThread, true);
        try { SetForegroundWindow(window); }
        finally { if (attached) AttachThreadInput(currentThread, foregroundThread, false); }
        const uint flags = 0x0001 | 0x0002 | 0x0040; // SWP_NOSIZE | SWP_NOMOVE | SWP_SHOWWINDOW
        SetWindowPos(window, new IntPtr(-1), 0, 0, 0, 0, flags); // HWND_TOPMOST
        SetWindowPos(window, new IntPtr(-2), 0, 0, 0, 0, flags); // HWND_NOTOPMOST
    }

    [DllImport("user32.dll")] private static extern bool ShowWindowAsync(IntPtr window, int command);
    [DllImport("user32.dll")] private static extern bool SetForegroundWindow(IntPtr window);
    [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr window, IntPtr processId);
    [DllImport("kernel32.dll")] private static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] private static extern bool AttachThreadInput(uint attach, uint attachTo, bool value);
    [DllImport("user32.dll")] private static extern bool SetWindowPos(IntPtr window, IntPtr after, int x, int y, int width, int height, uint flags);

    private static void OpenPaperFolder(Stream stream, string body)
    {
        LinkRequest request = Json.Deserialize<LinkRequest>(body);
        OpenDirectory(ResolvePaper(request == null ? null : request.path), false);
        WriteJson(stream, new { opened = true });
    }

    private static void OpenAttachmentFolder(Stream stream, string body)
    {
        LinkRequest request = Json.Deserialize<LinkRequest>(body);
        AttachmentLink link = GetAttachment(request == null ? null : request.id);
        if (link.kind == "parsed") OpenDirectory(ResolvePaper(link.path), false);
        else OpenDirectory(AttachmentFilePath(link), true);
        WriteJson(stream, new { opened = true });
    }

    private static bool IsPlayableVideo(string name)
    {
        string extension = Path.GetExtension(name).ToLowerInvariant();
        return extension == ".mp4" || extension == ".webm" || extension == ".ogg" || extension == ".ogv" || extension == ".m4v";
    }

    private static object ListZipVideos(string id)
    {
        string path = AttachmentFilePath(GetAttachment(id));
        if (!String.Equals(Path.GetExtension(path), ".zip", StringComparison.OrdinalIgnoreCase)) throw new InvalidOperationException("附件不是 ZIP 文件。");
        using (ZipArchive zip = ZipFile.OpenRead(path))
        {
            return new { videos = zip.Entries.Where(x => IsPlayableVideo(x.FullName) && x.Length > 0 && x.Length <= 2L * 1024 * 1024 * 1024).Select(x => new { name = x.FullName, size = x.Length }).ToArray() };
        }
    }

    private static string ExtractZipVideo(string zipPath, string entryName)
    {
        lock (AttachmentLock)
        {
        using (ZipArchive zip = ZipFile.OpenRead(zipPath))
        {
            ZipArchiveEntry entry = zip.GetEntry(entryName);
            if (entry == null || !IsPlayableVideo(entry.FullName) || entry.Length > 2L * 1024 * 1024 * 1024)
                throw new InvalidOperationException("ZIP 中没有可播放的视频，或视频过大。");
            string key = HashText(zipPath + "\n" + File.GetLastWriteTimeUtc(zipPath).Ticks + "\n" + entryName);
            string cache = Path.Combine(StateDirectory, "video-cache", key + Path.GetExtension(entryName).ToLowerInvariant());
            if (File.Exists(cache) && new FileInfo(cache).Length == entry.Length) return cache;
            Directory.CreateDirectory(Path.GetDirectoryName(cache));
            string temp = cache + ".tmp";
            using (Stream source = entry.Open())
            using (FileStream target = new FileStream(temp, FileMode.Create, FileAccess.Write, FileShare.None)) source.CopyTo(target);
            if (new FileInfo(temp).Length != entry.Length) { File.Delete(temp); throw new InvalidDataException("视频解压不完整。"); }
            if (File.Exists(cache)) File.Delete(cache);
            File.Move(temp, cache);
            return cache;
        }
        }
    }

    private static void ClearVideoCache(Stream stream)
    {
        string directory = Path.Combine(StateDirectory, "video-cache");
        if (Directory.Exists(directory))
        {
            foreach (string file in Directory.GetFiles(directory))
                try { File.Delete(file); } catch (IOException) { }
        }
        WriteJson(stream, new { cleared = true });
    }

    private static void ServeAttachment(Stream stream, string id, string entry, Dictionary<string, string> headers)
    {
        string path = AttachmentFilePath(GetAttachment(id));
        if (!String.IsNullOrEmpty(entry)) path = ExtractZipVideo(path, entry);
        string range = null;
        headers.TryGetValue("Range", out range);
        WriteFile(stream, path, MimeType(path), range);
    }

    private static string HashText(string value)
    {
        using (SHA256 sha = SHA256.Create()) return BitConverter.ToString(sha.ComputeHash(Encoding.UTF8.GetBytes(value))).Replace("-", "").ToLowerInvariant();
    }

    private static string HashPdf(string path, Dictionary<string, PdfHashCacheEntry> cache)
    {
        FileInfo info = new FileInfo(path);
        PdfHashCacheEntry old;
        if (cache.TryGetValue(path, out old) && old.size == info.Length && old.ticks == info.LastWriteTimeUtc.Ticks) return old.hash;
        string hash;
        using (SHA256 sha = SHA256.Create())
        using (FileStream file = File.OpenRead(path)) hash = BitConverter.ToString(sha.ComputeHash(file)).Replace("-", "").ToLowerInvariant();
        cache[path] = new PdfHashCacheEntry { size = info.Length, ticks = info.LastWriteTimeUtc.Ticks, hash = hash };
        return hash;
    }

    private static object FindDuplicates(List<TreeNode> papers)
    {
        Dictionary<string, PdfHashCacheEntry> cache = new Dictionary<string, PdfHashCacheEntry>(StringComparer.OrdinalIgnoreCase);
        try { if (File.Exists(PdfHashCachePath)) cache = Json.Deserialize<Dictionary<string, PdfHashCacheEntry>>(File.ReadAllText(PdfHashCachePath, Encoding.UTF8)); } catch { }
        if (cache == null) cache = new Dictionary<string, PdfHashCacheEntry>(StringComparer.OrdinalIgnoreCase);
        Dictionary<long, List<TreeNode>> sizes = new Dictionary<long, List<TreeNode>>();
        foreach (TreeNode paper in papers.Where(x => x.hasMarkdown))
        {
            try
            {
                long size = new FileInfo(FindPdf(ResolvePaper(paper.path))).Length;
                if (!sizes.ContainsKey(size)) sizes[size] = new List<TreeNode>();
                sizes[size].Add(paper);
            }
            catch { }
        }
        Dictionary<string, List<object>> groups = new Dictionary<string, List<object>>();
        foreach (List<TreeNode> sameSize in sizes.Values.Where(x => x.Count > 1))
        foreach (TreeNode paper in sameSize)
        {
            try
            {
                string directory = ResolvePaper(paper.path);
                string hash = HashPdf(FindPdf(directory), cache);
                ReviewRecord review = LoadReview(directory);
                List<AttachmentLink> links = LoadAttachmentLinks();
                string threads = "";
                lock (StateLock) AiPreferences.TryGetValue("paperThreads", out threads);
                bool hasChat = !String.IsNullOrEmpty(threads) && threads.IndexOf(ReviewKey(directory), StringComparison.OrdinalIgnoreCase) >= 0;
                if (!groups.ContainsKey(hash)) groups[hash] = new List<object>();
                groups[hash].Add(new { path = paper.path, name = paper.title == "" ? paper.name : paper.title, annotations = review.annotations == null ? 0 : review.annotations.Count, note = !String.IsNullOrWhiteSpace(review.note), chat = hasChat, attachments = links.Count(x => String.Equals(x.parent, paper.path, StringComparison.OrdinalIgnoreCase)), status = review.status, favorite = review.favorite, tags = review.tags == null ? 0 : review.tags.Count, size = new FileInfo(FindPdf(directory)).Length });
            }
            catch { }
        }
        AtomicWrite(PdfHashCachePath, Json.Serialize(cache));
        return groups.Where(x => x.Value.Count > 1).Select(x => new { hash = x.Key, papers = x.Value }).ToArray();
    }

    private static void TransferDuplicateAttachments(Stream stream, string body)
    {
        DuplicateDeleteRequest request = Json.Deserialize<DuplicateDeleteRequest>(body);
        if (request == null || String.IsNullOrEmpty(request.keep) || String.IsNullOrEmpty(request.delete) || request.keep == request.delete)
            throw new InvalidOperationException("请选择两篇不同的论文。");
        string keep = ResolvePaper(request.keep), remove = ResolvePaper(request.delete);
        Dictionary<string, PdfHashCacheEntry> cache = new Dictionary<string, PdfHashCacheEntry>();
        if (HashPdf(FindPdf(keep), cache) != HashPdf(FindPdf(remove), cache) || HashPdf(FindPdf(keep), cache) != request.hash)
            throw new InvalidOperationException("论文 PDF 已变化，请刷新后重试。");
        List<AttachmentLink> links = LoadAttachmentLinks();
        if (links.Any(x => x.kind == "parsed" && String.Equals(x.path, request.delete, StringComparison.OrdinalIgnoreCase)))
            throw new InvalidOperationException("待删论文本身被关联为支撑材料，请先解除该关联。");
        int count = 0;
        foreach (AttachmentLink link in links.Where(x => String.Equals(x.parent, request.delete, StringComparison.OrdinalIgnoreCase)))
        {
            link.parent = request.keep;
            SaveAttachmentLink(link);
            count++;
        }
        WriteJson(stream, new { transferred = count });
    }

    private static void DeleteDuplicate(Stream stream, string body)
    {
        DuplicateDeleteRequest request = Json.Deserialize<DuplicateDeleteRequest>(body);
        if (request == null || String.IsNullOrEmpty(request.keep) || String.IsNullOrEmpty(request.delete) || request.keep == request.delete)
            throw new InvalidOperationException("请选择保留与删除的不同论文。");
        string keep = ResolvePaper(request.keep);
        string remove = ResolvePaper(request.delete);
        if (!File.Exists(Path.Combine(keep, "markdown.md")) || !File.Exists(Path.Combine(remove, "markdown.md")))
            throw new InvalidOperationException("PDF-only 论文暂不支持删除重复目录。");
        if (String.Equals(remove, LibraryRoot, StringComparison.OrdinalIgnoreCase) || keep.StartsWith(remove + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase))
            throw new InvalidOperationException("不能删除论文库根目录或包含保留论文的目录。");
        string keepPdf = FindPdf(keep), removePdf = FindPdf(remove);
        if (keepPdf == null || removePdf == null) throw new InvalidOperationException("论文 PDF 已不存在。");
        Dictionary<string, PdfHashCacheEntry> cache = new Dictionary<string, PdfHashCacheEntry>();
        string keepHash = HashPdf(keepPdf, cache), removeHash = HashPdf(removePdf, cache);
        if (keepHash != removeHash || keepHash != request.hash) throw new InvalidOperationException("文件已变化，无法确认重复，请刷新后重试。");
        List<AttachmentLink> links = LoadAttachmentLinks();
        if (links.Any(x => String.Equals(x.parent, request.delete, StringComparison.OrdinalIgnoreCase) || (x.kind == "parsed" && String.Equals(x.path, request.delete, StringComparison.OrdinalIgnoreCase))))
            throw new InvalidOperationException("待删论文仍有关联附件，请先解除或重新关联。");
        ReviewRecord review = LoadReview(remove);
        if ((review.annotations != null && review.annotations.Count > 0) || !String.IsNullOrWhiteSpace(review.note) ||
            review.favorite || (review.tags != null && review.tags.Count > 0) || !String.IsNullOrWhiteSpace(review.title) || review.status == "deep" || review.status == "skimmed")
            throw new InvalidOperationException("待删论文仍有阅读记录，请先保留或手动整理这些内容。");
        string threads = "";
        lock (StateLock) AiPreferences.TryGetValue("paperThreads", out threads);
        if (!String.IsNullOrEmpty(threads) && threads.IndexOf(ReviewKey(remove), StringComparison.OrdinalIgnoreCase) >= 0)
            throw new InvalidOperationException("待删论文关联了 AI 对话，请先保留或手动整理该论文。");
        string[] generated = { "markdown.md", "source.pdf", "origin.pdf", "layout.pdf", "middle_json.json", "model_output.json", "structured_content.json" };
        foreach (string file in Directory.GetFiles(remove))
            if (!generated.Contains(Path.GetFileName(file), StringComparer.OrdinalIgnoreCase))
                throw new InvalidOperationException("待删目录含有额外文件，请先检查：" + Path.GetFileName(file));
        foreach (string directory in Directory.GetDirectories(remove))
            if (!String.Equals(Path.GetFileName(directory), "images", StringComparison.OrdinalIgnoreCase) &&
                !String.Equals(Path.GetFileName(directory), "downloads", StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException("待删目录含有额外文件夹，请先检查：" + Path.GetFileName(directory));
        string downloads = Path.Combine(remove, "downloads");
        if (Directory.Exists(downloads) && Directory.EnumerateFileSystemEntries(downloads).Any())
            throw new InvalidOperationException("待删目录中的 downloads 文件夹非空，请先检查其中内容。");
        Directory.Delete(remove, true);
        Interlocked.Increment(ref LibraryRevision);
        WriteJson(stream, new { deleted = true });
    }
}
