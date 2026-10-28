using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Sockets;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Web;
using System.Web.Script.Serialization;
using System.Windows.Forms;

internal static partial class MinerULibraryReview
{
    private static readonly object StateLock = new object();
    private static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = Int32.MaxValue };
    private static string AppDirectory;
    private static string StateDirectory;
    private static string PapersStateDirectory;
    private static string TranslationWorkspaceDirectory;
    private static string LibraryRoot;
    private static Dictionary<string, string> AiPreferences = new Dictionary<string, string>(StringComparer.Ordinal);
    private static TcpListener Listener;
    private static DateTime LastHeartbeat = DateTime.UtcNow;
    private static DateTime? CloseRequested;
    private static volatile bool Stopping;
    private static CodexBridge Codex;

    [STAThread]
    private static void Main(string[] args)
    {
        try
        {
            bool noBrowser = HasArgument(args, "--no-browser");
            AppDirectory = Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location);
            StateDirectory = Path.Combine(AppDirectory, "state", "ai-literature-reader");
            PapersStateDirectory = Path.Combine(StateDirectory, "papers");
            TranslationWorkspaceDirectory = Path.Combine(StateDirectory, "translation-workspace");
            Directory.CreateDirectory(PapersStateDirectory);
            Directory.CreateDirectory(TranslationWorkspaceDirectory);
            LoadSettings();
            WatchLibrary();
            WatchAttachmentRecords();

            Listener = new TcpListener(IPAddress.Loopback, 0);
            Listener.Start();
            int port = ((IPEndPoint)Listener.LocalEndpoint).Port;
            string url = "http://127.0.0.1:" + port + "/";

            Thread server = new Thread(ServerLoop);
            server.IsBackground = true;
            server.Start();
            Thread watchdog = new Thread(WatchdogLoop);
            watchdog.IsBackground = true;
            watchdog.Start();

            if (!noBrowser)
            {
                ProcessStartInfo start = new ProcessStartInfo(url);
                start.UseShellExecute = true;
                Process.Start(start);
            }
            while (!Stopping) Thread.Sleep(250);
        }
        catch (Exception ex)
        {
            try { Directory.CreateDirectory(StateDirectory); File.AppendAllText(Path.Combine(StateDirectory, "error.log"), DateTime.UtcNow.ToString("o") + " " + ex + Environment.NewLine); } catch { }
            MessageBox.Show(ex.Message, "PaperBench", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
        finally
        {
            Stopping = true;
            StopOwnedMinerUIfIdle();
            if (Codex != null) try { Codex.Dispose(); } catch { }
            if (LibraryWatcher != null) try { LibraryWatcher.Dispose(); } catch { }
            if (AttachmentRecordsWatcher != null) try { AttachmentRecordsWatcher.Dispose(); } catch { }
            if (Listener != null) try { Listener.Stop(); } catch { }
        }
    }

    private static bool HasArgument(string[] args, string value)
    {
        foreach (string arg in args)
            if (String.Equals(arg, value, StringComparison.OrdinalIgnoreCase)) return true;
        return false;
    }

    private static void LoadSettings()
    {
        string fallback = Directory.Exists(Path.Combine(AppDirectory, "output"))
            ? Path.Combine(AppDirectory, "output") : AppDirectory;
        LibraryRoot = fallback;
        string path = Path.Combine(StateDirectory, "settings.json");
        if (!File.Exists(path)) return;
        try
        {
            Settings settings = Json.Deserialize<Settings>(File.ReadAllText(path, Encoding.UTF8));
            if (settings != null && Directory.Exists(settings.libraryRoot))
                LibraryRoot = Path.GetFullPath(settings.libraryRoot);
            if (settings != null && settings.aiPreferences != null)
                AiPreferences = new Dictionary<string, string>(settings.aiPreferences, StringComparer.Ordinal);
        }
        catch { }
    }

    private static void SaveSettings()
    {
        lock (StateLock)
        {
            AtomicWrite(Path.Combine(StateDirectory, "settings.json"), Json.Serialize(new Settings
            {
                libraryRoot = LibraryRoot,
                aiPreferences = new Dictionary<string, string>(AiPreferences, StringComparer.Ordinal)
            }));
        }
    }

    private static void ServerLoop()
    {
        while (!Stopping)
        {
            try
            {
                TcpClient client = Listener.AcceptTcpClient();
                ThreadPool.QueueUserWorkItem(delegate { HandleClient(client); });
            }
            catch { if (!Stopping) Thread.Sleep(100); }
        }
    }

    private static void WatchdogLoop()
    {
        while (!Stopping)
        {
            Thread.Sleep(1000);
            DateTime now = DateTime.UtcNow;
            if (CloseRequested.HasValue && (now - CloseRequested.Value).TotalSeconds >= 3) Stop();
            else if ((now - LastHeartbeat).TotalMinutes >= 10) Stop();
        }
    }

    private static void Stop()
    {
        Stopping = true;
        if (Codex != null) try { Codex.Dispose(); } catch { }
        if (LibraryWatcher != null) try { LibraryWatcher.Dispose(); } catch { }
        if (AttachmentRecordsWatcher != null) try { AttachmentRecordsWatcher.Dispose(); } catch { }
        try { Listener.Stop(); } catch { }
    }

    private static void HandleClient(TcpClient client)
    {
        using (client)
        using (NetworkStream stream = client.GetStream())
        {
            try
            {
                stream.ReadTimeout = 130000;
                Request request = ReadRequest(stream);
                if (request == null) return;
                Uri uri = new Uri("http://127.0.0.1" + request.target);
                string path = Uri.UnescapeDataString(uri.AbsolutePath);
                var query = HttpUtility.ParseQueryString(uri.Query);

                if (path == "/") WriteResource(stream, "AppHtml", "text/html; charset=utf-8");
                else if (path == "/licenses") WriteResource(stream, "LicenseNotices", "text/plain; charset=utf-8");
                else if (path == "/third-party/citeproc.js") WriteResource(stream, "CiteprocSource", "text/plain; charset=utf-8");
                else if (path == "/third-party/Build.ps1") WriteResource(stream, "BuildSource", "text/plain; charset=utf-8");
                else if (path == "/assets/app.css") WriteResource(stream, "AppCss", "text/css; charset=utf-8");
                else if (path == "/assets/app.js") WriteResource(stream, "AppJs", "application/javascript; charset=utf-8");
                else if (path == "/assets/marked.js") WriteResource(stream, "MarkedJs", "application/javascript; charset=utf-8");
                else if (path == "/assets/purify.js") WriteResource(stream, "PurifyJs", "application/javascript; charset=utf-8");
                else if (path == "/assets/mathjax-config.js") WriteResource(stream, "MathJaxConfigJs", "application/javascript; charset=utf-8");
                else if (path == "/assets/mathjax.js") WriteResource(stream, "MathJaxJs", "application/javascript; charset=utf-8");
                else if (path == "/assets/zcs/protocol.js") WriteResource(stream, "ZcsProtocolJs", "application/javascript; charset=utf-8");
                else if (path == "/assets/zcs/markdown.js") WriteResource(stream, "ZcsMarkdownJs", "application/javascript; charset=utf-8");
                else if (path == "/assets/zcs/sidebar.js") WriteResource(stream, "ZcsSidebarJs", "application/javascript; charset=utf-8");
                else if (path == "/assets/zcs/style.css") WriteResource(stream, "ZcsStyleCss", "text/css; charset=utf-8");
                else if (path == "/assets/zcs/katex.js") WriteResource(stream, "ZcsKatexJs", "application/javascript; charset=utf-8");
                else if (path == "/assets/zcs/katex.css") WriteResource(stream, "ZcsKatexCss", "text/css; charset=utf-8");
                else if (path == "/assets/zcs/ai-client.js") WriteResource(stream, "AiClientJs", "application/javascript; charset=utf-8");
                else if (path == "/assets/zcs/ai-chat.js") WriteResource(stream, "AiChatJs", "application/javascript; charset=utf-8");
                else if (path.StartsWith("/assets/zcs/fonts/", StringComparison.Ordinal))
                    WriteResource(stream, "ZcsFont_" + Path.GetFileName(path), "font/woff2");
                else if (path == "/assets/citations.js") WriteResource(stream, "CitationsJs", "application/javascript; charset=utf-8");
                else if (path == "/assets/word-citations.js") WriteResource(stream, "WordCitationsJs", "application/javascript; charset=utf-8");
                else if (path == "/assets/paper-notes.js") WriteResource(stream, "PaperNotesJs", "application/javascript; charset=utf-8");
                else if (path == "/assets/material-export.js") WriteResource(stream, "MaterialExportJs", "application/javascript; charset=utf-8");
                else if (path == "/assets/pdf-import.js") WriteResource(stream, "PdfImportJs", "application/javascript; charset=utf-8");
                else if (path == "/assets/csl-bundle.js") WriteResource(stream, "CslBundleJs", "application/javascript; charset=utf-8");
                else if (path == "/api/settings") WriteJson(stream, new { libraryRoot = LibraryRoot });
                else if (path == "/api/material-export/papers") WriteJson(stream, ListMaterialExportPapers());
                else if (path == "/api/material-export/start" && request.method == "POST") StartMaterialExport(stream, request.body);
                else if (path == "/api/material-export/status") WriteJson(stream, MaterialExportStatus(query["id"]));
                else if (path == "/api/material-export/open" && request.method == "POST") OpenMaterialExportFolder(stream, request.body);
                else if (path == "/api/tree") WriteJson(stream, BuildTreeResponse());
                else if (path == "/api/local-mineru/status") LocalMinerUStatus(stream, query["paper"]);
                else if (path == "/api/local-mineru/select" && request.method == "POST") SelectLocalMinerU(stream);
                else if (path == "/api/local-mineru/start" && request.method == "POST") StartLocalMinerU(stream, request.body);
                else if (path == "/api/attachments/add" && request.method == "POST") AddAttachment(stream, request.body);
                else if (path == "/api/attachments/link" && request.method == "POST") LinkParsedPaper(stream, request.body);
                else if (path == "/api/attachments/remove" && request.method == "POST") RemoveAttachment(stream, request.body);
                else if (path == "/api/attachments/open-folder" && request.method == "POST") OpenAttachmentFolder(stream, request.body);
                else if (path == "/api/paper/open-folder" && request.method == "POST") OpenPaperFolder(stream, request.body);
                else if (path == "/api/paper/recycle-preview" && request.method == "GET") WriteJson(stream, PreviewPaperRecycle(query["path"]));
                else if (path == "/api/paper/recycle" && request.method == "POST") RecyclePaper(stream, request.body);
                else if (path == "/api/attachments/zip-videos") WriteJson(stream, ListZipVideos(query["id"]));
                else if (path == "/api/attachments/cache/clear" && request.method == "POST") ClearVideoCache(stream);
                else if (path == "/api/duplicates/delete" && request.method == "POST") DeleteDuplicate(stream, request.body);
                else if (path == "/api/duplicates/transfer-attachments" && request.method == "POST") TransferDuplicateAttachments(stream, request.body);
                else if (path == "/api/library-revision") WriteJson(stream, new { revision = LibraryRevision });
                else if (path == "/api/paper") WriteJson(stream, GetPaper(query["path"]));
                else if (path == "/api/select-root") SelectRoot(stream);
                else if (path == "/api/papers/import-pdfs/start" && request.method == "POST") StartPdfImport(stream, request.body);
                else if (path == "/api/papers/import-pdfs/chunk" && request.method == "POST") AppendPdfImport(stream, query["id"], query["offset"], request.bodyBytes);
                else if (path == "/api/papers/import-pdfs/complete" && request.method == "POST") CompletePdfImport(stream, request.body);
                else if (path == "/api/papers/import-pdfs/cancel" && request.method == "POST") CancelPdfImport(stream, request.body);
                else if (path == "/api/citation" && request.method == "GET") WriteJson(stream, ReadCitation(ResolvePaper(query["paper"])));
                else if (path == "/api/citation" && request.method == "POST") SaveCitation(stream, request.body);
                else if (path == "/api/citation/undo" && request.method == "POST") WriteJson(stream, UndoCitationSave(Json.Deserialize<Dictionary<string, string>>(request.body)["paper"]));
                else if (path == "/api/citations") WriteJson(stream, ListCitationExportData());
                else if (path == "/api/citation/recognize" && request.method == "POST") WriteJson(stream, RecognizeCitation(Json.Deserialize<Dictionary<string, string>>(request.body)["paper"]));
                else if (path == "/api/citation/search" && request.method == "POST") WriteJson(stream, SearchCitation(request.body));
                else if (path == "/api/citation/scan" && request.method == "GET") WriteJson(stream, ScanCitation(query["paper"]));
                else if (path == "/api/citation/lookup" && request.method == "POST") WriteJson(stream, LookupCitation(Json.Deserialize<Dictionary<string, string>>(request.body)["doi"]));
                else if (path == "/api/save" && request.method == "POST") SavePaper(stream, request.body);
                else if (path == "/api/notes/image" && request.method == "POST") SaveNoteImage(stream, query["paper"], request.bodyBytes);
                else if (path == "/api/tags/delete" && request.method == "POST") DeleteTag(stream, request.body);
                else if (path == "/api/tags/update" && request.method == "POST") UpdateTag(stream, request.body);
                else if (path == "/api/ai/connect") WriteJson(stream, GetCodex().ConnectInfo());
                else if (path == "/api/ai/preferences" && request.method == "GET") WriteJson(stream, GetAiPreferences());
                else if (path == "/api/ai/preferences" && request.method == "POST") SaveAiPreferences(stream, request.body);
                else if (path == "/api/ai/presets" && request.method == "GET") WriteJson(stream, GetPaperPromptPresets());
                else if (path == "/api/ai/presets/initialize" && request.method == "POST") InitializePaperPromptPresets(stream, request.body);
                else if (path == "/api/ai/presets/save" && request.method == "POST") SavePaperPromptPreset(stream, request.body);
                else if (path == "/api/ai/rpc" && request.method == "POST") HandleCodexRpc(stream, request.body);
                else if (path == "/api/ai/respond" && request.method == "POST") HandleCodexResponse(stream, request.body);
                else if (path == "/api/ai/events") WriteJson(stream, GetCodex().ReadEvents(ParseLong(query["after"]), 10000));
                else if (path == "/api/ai/image-path") WriteJson(stream, GetImagePath(query["paper"], query["file"]));
                else if (path == "/content/markdown") ServeMarkdown(stream, query["paper"]);
                else if (path == "/content/pdf") ServePdf(stream, query["paper"], request.headers);
                else if (path == "/content/asset") ServeAsset(stream, query["paper"], query["file"]);
                else if (path == "/content/note-image") { string image = ResolveNoteImage(query["file"]); WriteFile(stream, image, MimeType(image), null); }
                else if (path == "/content/attachment") ServeAttachment(stream, query["id"], query["entry"], request.headers);
                else if (path == "/heartbeat")
                {
                    LastHeartbeat = DateTime.UtcNow;
                    CloseRequested = null;
                    WriteText(stream, 200, "ok", "text/plain; charset=utf-8");
                }
                else if (path == "/close")
                {
                    CloseRequested = DateTime.UtcNow;
                    WriteText(stream, 200, "closing", "text/plain; charset=utf-8");
                }
                else WriteText(stream, 404, "Not Found", "text/plain; charset=utf-8");
            }
            catch (Exception ex)
            {
                try { WriteJsonError(stream, 500, ex.Message); } catch { }
            }
        }
    }

    private static Request ReadRequest(NetworkStream stream)
    {
        MemoryStream headerBytes = new MemoryStream();
        int state = 0;
        while (headerBytes.Length < 65536)
        {
            int value = stream.ReadByte();
            if (value < 0) return null;
            headerBytes.WriteByte((byte)value);
            state = state == 0 && value == 13 ? 1
                : state == 1 && value == 10 ? 2
                : state == 2 && value == 13 ? 3
                : state == 3 && value == 10 ? 4
                : value == 13 ? 1 : 0;
            if (state == 4) break;
        }
        string header = Encoding.ASCII.GetString(headerBytes.ToArray());
        string[] lines = header.Split(new[] { "\r\n" }, StringSplitOptions.None);
        string[] first = lines[0].Split(' ');
        if (first.Length < 2) return null;
        Request request = new Request();
        request.method = first[0].ToUpperInvariant();
        request.target = first[1];
        request.headers = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        for (int i = 1; i < lines.Length; i++)
        {
            int colon = lines[i].IndexOf(':');
            if (colon > 0) request.headers[lines[i].Substring(0, colon).Trim()] = lines[i].Substring(colon + 1).Trim();
        }
        int contentLength = 0;
        string length;
        if (request.headers.TryGetValue("Content-Length", out length)) Int32.TryParse(length, out contentLength);
        if (contentLength > 30 * 1024 * 1024) throw new InvalidOperationException("请求内容过大。");
        byte[] body = new byte[contentLength];
        int offset = 0;
        while (offset < body.Length)
        {
            int read = stream.Read(body, offset, body.Length - offset);
            if (read <= 0) break;
            offset += read;
        }
        if (offset != body.Length) throw new InvalidDataException("请求内容传输不完整。");
        request.bodyBytes = body;
        request.body = Encoding.UTF8.GetString(body, 0, offset);
        return request;
    }

    private static object BuildTreeResponse()
    {
        string root;
        lock (StateLock) root = LibraryRoot;
        TreeNode node = BuildTreeNode(root, root, 0);
        var availablePapers = CollectPapers(node);
        var links = LoadAttachmentLinks();
        var duplicates = FindDuplicates(availablePapers);
        HideLinkedPapers(node, links);
        return new { libraryRoot = root, tree = node, availablePapers = availablePapers, attachments = links, duplicates = duplicates, scannedAt = DateTime.UtcNow.ToString("o"), revision = LibraryRevision };
    }

    private static TreeNode BuildTreeNode(string directory, string root, int depth)
    {
        TreeNode node = new TreeNode();
        node.name = String.Equals(directory, root, StringComparison.OrdinalIgnoreCase)
            ? new DirectoryInfo(root).Name : Path.GetFileName(directory);
        node.path = String.Equals(directory, root, StringComparison.OrdinalIgnoreCase) ? "" : MakeRelative(root, directory);
        node.paper = !String.Equals(directory, root, StringComparison.OrdinalIgnoreCase) && FindPdf(directory) != null;
        node.hasMarkdown = node.paper && File.Exists(Path.Combine(directory, "markdown.md"));
        node.children = new List<TreeNode>();
        if (node.paper)
        {
            ReviewRecord review = LoadReview(directory);
            node.status = review.status ?? "unread";
            node.title = review.title ?? "";
            node.parsedTitle = node.hasMarkdown
                ? ReadParsedTitle(Path.Combine(directory, "markdown.md")) : "";
            node.tags = review.tags ?? new List<string>();
            node.favorite = review.favorite;
            node.lastOpenedAt = review.lastOpenedAt ?? "";
            PaperAddedInfo added = ReadPaperAddedInfo(root, directory, true);
            node.addedAt = added.addedAt;
            node.addedTimeEstimated = added.estimated;
            return node;
        }
        if (depth >= 12) return node;
        try
        {
            string[] directories = Directory.GetDirectories(directory);
            Array.Sort(directories, StringComparer.CurrentCultureIgnoreCase);
            foreach (string child in directories)
            {
                if (String.Equals(child, Path.Combine(AppDirectory, "attachments"), StringComparison.OrdinalIgnoreCase) ||
                    String.Equals(child, Path.Combine(AppDirectory, "state"), StringComparison.OrdinalIgnoreCase)) continue;
                FileAttributes attributes;
                try { attributes = File.GetAttributes(child); } catch { continue; }
                string name = Path.GetFileName(child);
                if ((attributes & FileAttributes.Hidden) != 0 || name.StartsWith(".", StringComparison.Ordinal)) continue;
                TreeNode childNode = BuildTreeNode(child, root, depth + 1);
                if (childNode.paper || childNode.children.Count > 0) node.children.Add(childNode);
            }
        }
        catch { }
        return node;
    }

    private static void SelectRoot(Stream stream)
    {
        string selected = null;
        Exception failure = null;
        ManualResetEvent finished = new ManualResetEvent(false);
        Thread dialogThread = new Thread(new ThreadStart(delegate
        {
            try
            {
                Application.EnableVisualStyles();
                using (Form owner = new Form())
                using (FolderBrowserDialog dialog = new FolderBrowserDialog())
                {
                    owner.Text = "选择论文库文件夹";
                    owner.ShowInTaskbar = false;
                    owner.TopMost = true;
                    owner.StartPosition = FormStartPosition.Manual;
                    System.Drawing.Rectangle workArea = Screen.PrimaryScreen.WorkingArea;
                    owner.Location = new System.Drawing.Point(
                        workArea.Left + workArea.Width / 2,
                        workArea.Top + workArea.Height / 2);
                    owner.Size = new System.Drawing.Size(1, 1);
                    owner.Opacity = 0.01;
                    owner.Show();
                    owner.BringToFront();
                    owner.Activate();
                    dialog.Description = "选择包含 MinerU 论文结果的文件夹";
                    dialog.SelectedPath = Directory.Exists(LibraryRoot) ? LibraryRoot : AppDirectory;
                    dialog.ShowNewFolderButton = false;
                    if (dialog.ShowDialog(owner) == DialogResult.OK) selected = dialog.SelectedPath;
                    owner.Close();
                }
            }
            catch (Exception ex) { failure = ex; }
            finally { finished.Set(); }
        }));
        dialogThread.SetApartmentState(ApartmentState.STA);
        dialogThread.IsBackground = true;
        dialogThread.Start();
        finished.WaitOne();
        if (failure != null) throw failure;
        if (!String.IsNullOrEmpty(selected))
        {
            lock (StateLock)
            {
                LibraryRoot = Path.GetFullPath(selected);
                SaveSettings();
                WatchLibrary();
            }
        }
        WriteJson(stream, new { selected = !String.IsNullOrEmpty(selected), libraryRoot = LibraryRoot });
    }

    private static object GetPaper(string relativePath)
    {
        string directory = ResolvePaper(relativePath);
        string pdf = FindPdf(directory);
        if (pdf == null) throw new FileNotFoundException("该目录没有可阅读的 PDF。", directory);
        bool hasMarkdown = File.Exists(Path.Combine(directory, "markdown.md"));
        ReviewRecord review = LoadReview(directory);
        review.lastOpenedAt = DateTime.UtcNow.ToString("o");
        SaveReview(directory, review);
        return new
        {
            name = Path.GetFileName(directory),
            path = MakeRelative(LibraryRoot, directory),
            pdfName = Path.GetFileName(pdf),
            workingDirectory = directory,
            pdfPath = pdf,
            hasMarkdown = hasMarkdown,
            markdownPath = hasMarkdown ? Path.Combine(directory, "markdown.md") : null,
            itemKey = ReviewKey(directory),
            attachmentID = StablePositiveInt(directory),
            review = review
        };
    }

    private static void SavePaper(Stream stream, string body)
    {
        SaveRequest request = Json.Deserialize<SaveRequest>(body);
        if (request == null || request.review == null) throw new InvalidOperationException("保存内容无效。");
        string directory = ResolvePaper(request.paperPath);
        request.review.status = NormalizeStatus(request.review.status);
        if (request.review.annotations == null) request.review.annotations = new List<Annotation>();
        request.review.title = (request.review.title ?? "").Trim();
        if (request.review.tags == null) request.review.tags = new List<string>();
        request.review.tags = request.review.tags
            .Where(delegate(string tag) { return !String.IsNullOrWhiteSpace(tag); })
            .Select(delegate(string tag) { return tag.Trim(); })
            .Distinct(StringComparer.CurrentCultureIgnoreCase)
            .Take(30)
            .ToList();
        if (request.review.lastOpenedAt == null) request.review.lastOpenedAt = "";
        request.review.updatedAt = DateTime.UtcNow.ToString("o");
        SaveReview(directory, request.review);
        WriteJson(stream, new { saved = true, updatedAt = request.review.updatedAt });
    }

    private static void DeleteTag(Stream stream, string body)
    {
        TagRequest request = Json.Deserialize<TagRequest>(body);
        string tag = request == null ? "" : (request.tag ?? "").Trim();
        if (String.IsNullOrEmpty(tag)) throw new InvalidOperationException("标签名称不能为空。");

        string root;
        lock (StateLock) root = LibraryRoot;
        int affected = DeleteTagFromDirectory(root, tag, 0);
        WriteJson(stream, new { deleted = true, tag = tag, affected = affected });
    }

    private static void UpdateTag(Stream stream, string body)
    {
        TagUpdateRequest request = Json.Deserialize<TagUpdateRequest>(body);
        string source = request == null ? "" : (request.source ?? "").Trim();
        string target = request == null ? "" : (request.target ?? "").Trim();
        if (String.IsNullOrEmpty(source) || String.IsNullOrEmpty(target))
            throw new InvalidOperationException("原标签和目标标签都不能为空。");
        if (target.Length > 60) throw new InvalidOperationException("标签不能超过 60 个字符。");

        string root;
        lock (StateLock) root = LibraryRoot;
        int affected = UpdateTagInDirectory(root, source, target, 0);
        WriteJson(stream, new { updated = true, source = source, target = target, affected = affected });
    }

    private static int DeleteTagFromDirectory(string directory, string tag, int depth)
    {
        if (depth > 12) return 0;
        if (FindPdf(directory) != null)
        {
            ReviewRecord review = LoadReview(directory);
            int before = review.tags == null ? 0 : review.tags.Count;
            review.tags = (review.tags ?? new List<string>())
                .Where(delegate(string item) { return !String.Equals((item ?? "").Trim(), tag, StringComparison.CurrentCultureIgnoreCase); })
                .ToList();
            if (review.tags.Count == before) return 0;
            review.updatedAt = DateTime.UtcNow.ToString("o");
            SaveReview(directory, review);
            return 1;
        }

        int affected = 0;
        try
        {
            foreach (string child in Directory.GetDirectories(directory))
            {
                FileAttributes attributes;
                try { attributes = File.GetAttributes(child); } catch { continue; }
                string name = Path.GetFileName(child);
                if ((attributes & FileAttributes.Hidden) != 0 || name.StartsWith(".", StringComparison.Ordinal)) continue;
                affected += DeleteTagFromDirectory(child, tag, depth + 1);
            }
        }
        catch { }
        return affected;
    }

    private static int UpdateTagInDirectory(string directory, string source, string target, int depth)
    {
        if (depth > 12) return 0;
        if (FindPdf(directory) != null)
        {
            ReviewRecord review = LoadReview(directory);
            bool changed = false;
            List<string> tags = new List<string>();
            foreach (string item in review.tags ?? new List<string>())
            {
                string value = (item ?? "").Trim();
                if (String.Equals(value, source, StringComparison.CurrentCultureIgnoreCase))
                {
                    value = target;
                    changed = true;
                }
                if (!String.IsNullOrEmpty(value) && !tags.Contains(value, StringComparer.CurrentCultureIgnoreCase)) tags.Add(value);
            }
            if (!changed) return 0;
            review.tags = tags;
            review.updatedAt = DateTime.UtcNow.ToString("o");
            SaveReview(directory, review);
            return 1;
        }

        int affected = 0;
        try
        {
            foreach (string child in Directory.GetDirectories(directory))
            {
                FileAttributes attributes;
                try { attributes = File.GetAttributes(child); } catch { continue; }
                string name = Path.GetFileName(child);
                if ((attributes & FileAttributes.Hidden) != 0 || name.StartsWith(".", StringComparison.Ordinal)) continue;
                affected += UpdateTagInDirectory(child, source, target, depth + 1);
            }
        }
        catch { }
        return affected;
    }

    private static void ServeMarkdown(Stream stream, string paper)
    {
        string directory = ResolvePaper(paper);
        string path = Path.Combine(directory, "markdown.md");
        if (!File.Exists(path)) throw new FileNotFoundException("找不到 markdown.md。", path);
        WriteFile(stream, path, "text/markdown; charset=utf-8", null);
    }

    private static void ServePdf(Stream stream, string paper, Dictionary<string, string> headers)
    {
        string directory = ResolvePaper(paper);
        string path = FindPdf(directory);
        if (path == null) throw new FileNotFoundException("找不到原始 PDF。", directory);
        string range = null;
        headers.TryGetValue("Range", out range);
        WriteFile(stream, path, "application/pdf", range);
    }

    private static void ServeAsset(Stream stream, string paper, string relativeFile)
    {
        string directory = ResolvePaper(paper);
        if (String.IsNullOrWhiteSpace(relativeFile)) throw new FileNotFoundException("资源路径为空。");
        string full = Path.GetFullPath(Path.Combine(directory, relativeFile.Replace('/', Path.DirectorySeparatorChar)));
        string prefix = directory.TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
        if (!full.StartsWith(prefix, StringComparison.OrdinalIgnoreCase) || !File.Exists(full))
            throw new FileNotFoundException("找不到论文资源。", relativeFile);
        WriteFile(stream, full, MimeType(full), null);
    }

    private static object GetImagePath(string paper, string relativeFile)
    {
        string directory = ResolvePaper(paper);
        if (String.IsNullOrWhiteSpace(relativeFile)) throw new FileNotFoundException("资源路径为空。");
        string full = Path.GetFullPath(Path.Combine(directory, relativeFile.Replace('/', Path.DirectorySeparatorChar)));
        string prefix = directory.TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
        if (!full.StartsWith(prefix, StringComparison.OrdinalIgnoreCase) || !File.Exists(full))
            throw new FileNotFoundException("找不到论文图片。", relativeFile);
        string mime = MimeType(full);
        if (!mime.StartsWith("image/", StringComparison.OrdinalIgnoreCase))
            throw new InvalidOperationException("选择的资源不是图片。");
        return new { path = full, name = Path.GetFileName(full), size = new FileInfo(full).Length, type = mime };
    }

    private static string ResolvePaper(string relativePath)
    {
        string root;
        lock (StateLock) root = LibraryRoot;
        string relative = relativePath ?? "";
        string full = Path.GetFullPath(Path.Combine(root, relative.Replace('/', Path.DirectorySeparatorChar)));
        string prefix = root.TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
        if (!full.Equals(root, StringComparison.OrdinalIgnoreCase) && !full.StartsWith(prefix, StringComparison.OrdinalIgnoreCase))
            throw new UnauthorizedAccessException("论文路径超出当前论文库。");
        if (!Directory.Exists(full)) throw new DirectoryNotFoundException("论文目录不存在：" + full);
        return full;
    }

    private static string FindPdf(string directory)
    {
        string[] files;
        try { files = Directory.GetFiles(directory, "*.pdf", SearchOption.TopDirectoryOnly); }
        catch { return null; }
        foreach (string preferred in new[] { "source.pdf", "origin.pdf" })
        {
            string candidate = Path.Combine(directory, preferred);
            if (File.Exists(candidate)) return candidate;
        }
        foreach (string file in files)
            if (!Path.GetFileName(file).Equals("layout.pdf", StringComparison.OrdinalIgnoreCase)) return file;
        return null;
    }

    private static ReviewRecord LoadReview(string paperDirectory)
    {
        string path = ReviewPath(paperDirectory);
        string legacyPath = Path.Combine(PapersStateDirectory, ReviewKey(paperDirectory) + ".json");
        foreach (string candidate in new[] { path, legacyPath })
        {
            if (!File.Exists(candidate)) continue;
            try
            {
                string content = File.ReadAllText(candidate, Encoding.UTF8);
                ReviewRecord saved = Json.Deserialize<ReviewRecord>(content);
                if (saved != null)
                {
                    if (candidate == legacyPath)
                    {
                        // Keep the old file as a backup while migrating to a key shared by both computers.
                        try
                        {
                            lock (StateLock)
                                if (!File.Exists(path)) AtomicWrite(path, content);
                        }
                        catch (IOException) { }
                        catch (UnauthorizedAccessException) { }
                    }
                    saved.status = NormalizeStatus(saved.status);
                    if (saved.annotations == null) saved.annotations = new List<Annotation>();
                    if (saved.title == null) saved.title = "";
                    if (saved.tags == null) saved.tags = new List<string>();
                    if (saved.lastOpenedAt == null) saved.lastOpenedAt = "";
                    return saved;
                }
            }
            catch { }
        }
        return new ReviewRecord
        {
            status = "unread",
            note = "",
            title = "",
            tags = new List<string>(),
            favorite = false,
            lastOpenedAt = "",
            markdownScroll = 0,
            pdfWidth = 50,
            annotations = new List<Annotation>()
        };
    }

    private static void SaveReview(string paperDirectory, ReviewRecord review)
    {
        lock (StateLock) AtomicWrite(ReviewPath(paperDirectory), Json.Serialize(review));
    }

    private static string ReviewPath(string paperDirectory)
    {
        string root;
        lock (StateLock) root = LibraryRoot;
        string relative = MakeRelative(root, Path.GetFullPath(paperDirectory)).Replace('\\', '/').Trim('/');
        if (relative == ".." || relative.StartsWith("../", StringComparison.Ordinal))
            throw new UnauthorizedAccessException("论文目录不在当前论文库中。");
        string normalized = (relative.Length == 0 ? "." : relative).ToUpperInvariant();
        byte[] hash;
        using (SHA256 sha = SHA256.Create()) hash = sha.ComputeHash(Encoding.UTF8.GetBytes("paper-v2\n" + normalized));
        StringBuilder name = new StringBuilder("v2-");
        for (int i = 0; i < hash.Length; i++) name.Append(hash[i].ToString("x2"));
        return Path.Combine(PapersStateDirectory, name + ".json");
    }

    // The absolute-path key remains in use for local Codex conversation bindings.
    private static string ReviewKey(string paperDirectory)
    {
        string normalized = Path.GetFullPath(paperDirectory).TrimEnd(Path.DirectorySeparatorChar).ToUpperInvariant();
        byte[] hash;
        using (SHA256 sha = SHA256.Create()) hash = sha.ComputeHash(Encoding.UTF8.GetBytes(normalized));
        StringBuilder name = new StringBuilder();
        for (int i = 0; i < hash.Length; i++) name.Append(hash[i].ToString("x2"));
        return name.ToString();
    }

    private static int StablePositiveInt(string value)
    {
        byte[] hash;
        using (SHA256 sha = SHA256.Create()) hash = sha.ComputeHash(Encoding.UTF8.GetBytes(value.ToUpperInvariant()));
        return (BitConverter.ToInt32(hash, 0) & 0x7ffffffe) + 1;
    }

    private static long ParseLong(string value)
    {
        long parsed;
        return Int64.TryParse(value, out parsed) ? parsed : 0;
    }

    private static object GetAiPreferences()
    {
        lock (StateLock)
            return new { preferences = new Dictionary<string, string>(AiPreferences, StringComparer.Ordinal) };
    }

    private static void SaveAiPreferences(Stream stream, string body)
    {
        AiPreferencesRequest request = Json.Deserialize<AiPreferencesRequest>(body);
        if (request == null || request.preferences == null)
            throw new InvalidOperationException("AI 设置内容无效。");
        string[] allowed = {
            "includeItemContext", "paperOnlyChats", "paperThreads", "lastThreadId",
            "model", "reasoningEffort", "approvalPolicy", "approvalsReviewer", "sandbox",
            "networkAccess", "showWorkProcess", "sidebarHeight", "workingDirectory",
            "codexPath", "codexHome"
        };
        lock (StateLock)
        {
            foreach (KeyValuePair<string, string> pair in request.preferences)
            {
                if (Array.IndexOf(allowed, pair.Key) < 0) continue;
                AiPreferences[pair.Key] = pair.Value ?? "";
            }
            SaveSettings();
        }
        WriteJson(stream, new { saved = true });
    }

    private static CodexBridge GetCodex()
    {
        lock (StateLock)
        {
            if (Codex == null) Codex = new CodexBridge();
            return Codex;
        }
    }

    private static void HandleCodexRpc(Stream stream, string body)
    {
        RpcRequest request = Json.Deserialize<RpcRequest>(body);
        if (request == null || String.IsNullOrWhiteSpace(request.method))
            throw new InvalidOperationException("Codex 请求无效。");
        WriteJson(stream, new { result = GetCodex().Request(request.method, request.parameters) });
    }

    private static void HandleCodexResponse(Stream stream, string body)
    {
        RpcResponse response = Json.Deserialize<RpcResponse>(body);
        if (response == null || response.id == null) throw new InvalidOperationException("Codex 响应无效。");
        GetCodex().Respond(response.id, response.result, response.error);
        WriteJson(stream, new { ok = true });
    }

    private static string NormalizeStatus(string value)
    {
        return value == "skimmed" || value == "deep" ? value : "unread";
    }

    private static void AtomicWrite(string path, string content)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(path));
        string temp = path + ".tmp";
        File.WriteAllText(temp, content, new UTF8Encoding(false));
        if (File.Exists(path))
        {
            string backup = path + ".bak";
            try { File.Replace(temp, path, backup, true); if (File.Exists(backup)) File.Delete(backup); }
            catch { File.Delete(path); File.Move(temp, path); }
        }
        else File.Move(temp, path);
    }

    private static string MakeRelative(string root, string path)
    {
        Uri rootUri = new Uri(root.TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar);
        Uri pathUri = new Uri(path);
        return Uri.UnescapeDataString(rootUri.MakeRelativeUri(pathUri).ToString()).Replace('/', Path.DirectorySeparatorChar);
    }

    private static void WriteResource(Stream stream, string name, string contentType)
    {
        using (Stream resource = Assembly.GetExecutingAssembly().GetManifestResourceStream(name))
        {
            if (resource == null) throw new InvalidOperationException("程序资源缺失：" + name);
            byte[] data = new byte[resource.Length];
            int offset = 0;
            while (offset < data.Length)
            {
                int read = resource.Read(data, offset, data.Length - offset);
                if (read <= 0) break;
                offset += read;
            }
            WriteBytes(stream, 200, data, contentType, null);
        }
    }

    private static void WriteJson(Stream stream, object value)
    {
        WriteText(stream, 200, Json.Serialize(value), "application/json; charset=utf-8");
    }

    private static void WriteJsonError(Stream stream, int status, string message)
    {
        WriteText(stream, status, Json.Serialize(new { error = message }), "application/json; charset=utf-8");
    }

    private static void WriteFile(Stream stream, string path, string contentType, string rangeHeader)
    {
        FileInfo info = new FileInfo(path);
        long start = 0;
        long end = info.Length - 1;
        int status = 200;
        Dictionary<string, string> extra = new Dictionary<string, string>();
        extra["Accept-Ranges"] = "bytes";
        if (!String.IsNullOrEmpty(rangeHeader) && rangeHeader.StartsWith("bytes=", StringComparison.OrdinalIgnoreCase))
        {
            string[] bounds = rangeHeader.Substring(6).Split('-');
            long parsed;
            if (bounds.Length > 0 && Int64.TryParse(bounds[0], out parsed)) start = parsed;
            if (bounds.Length > 1 && Int64.TryParse(bounds[1], out parsed)) end = Math.Min(parsed, end);
            if (start <= end && start < info.Length)
            {
                status = 206;
                extra["Content-Range"] = "bytes " + start + "-" + end + "/" + info.Length;
            }
            else { WriteText(stream, 416, "Range Not Satisfiable", "text/plain; charset=utf-8"); return; }
        }
        long length = end - start + 1;
        WriteHeaders(stream, status, length, contentType, extra);
        using (FileStream file = File.OpenRead(path))
        {
            file.Position = start;
            byte[] buffer = new byte[65536];
            long remaining = length;
            while (remaining > 0)
            {
                int read = file.Read(buffer, 0, (int)Math.Min(buffer.Length, remaining));
                if (read <= 0) break;
                stream.Write(buffer, 0, read);
                remaining -= read;
            }
        }
    }

    private static void WriteText(Stream stream, int status, string value, string contentType)
    {
        WriteBytes(stream, status, Encoding.UTF8.GetBytes(value), contentType, null);
    }

    private static void WriteBytes(Stream stream, int status, byte[] data, string contentType, Dictionary<string, string> extra)
    {
        WriteHeaders(stream, status, data.Length, contentType, extra);
        stream.Write(data, 0, data.Length);
    }

    private static void WriteHeaders(Stream stream, int status, long length, string contentType, Dictionary<string, string> extra)
    {
        string reason = status == 200 ? "OK" : status == 206 ? "Partial Content" : status == 404 ? "Not Found" : status == 416 ? "Range Not Satisfiable" : status == 400 ? "Bad Request" : "Error";
        StringBuilder headers = new StringBuilder();
        headers.Append("HTTP/1.1 ").Append(status).Append(' ').Append(reason).Append("\r\n");
        headers.Append("Content-Length: ").Append(length).Append("\r\n");
        headers.Append("Content-Type: ").Append(contentType).Append("\r\n");
        headers.Append("Cache-Control: no-store\r\n");
        headers.Append("X-Content-Type-Options: nosniff\r\n");
        headers.Append("Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data: blob:; worker-src 'self'; frame-src 'self'; object-src 'self'\r\n");
        if (extra != null) foreach (KeyValuePair<string, string> pair in extra) headers.Append(pair.Key).Append(": ").Append(pair.Value).Append("\r\n");
        headers.Append("Connection: close\r\n\r\n");
        byte[] bytes = Encoding.ASCII.GetBytes(headers.ToString());
        stream.Write(bytes, 0, bytes.Length);
    }

    private static string MimeType(string path)
    {
        switch (Path.GetExtension(path).ToLowerInvariant())
        {
            case ".png": return "image/png";
            case ".jpg": case ".jpeg": return "image/jpeg";
            case ".gif": return "image/gif";
            case ".webp": return "image/webp";
            case ".svg": return "image/svg+xml";
            case ".pdf": return "application/pdf";
            case ".mp4": case ".m4v": return "video/mp4";
            case ".webm": return "video/webm";
            case ".ogg": case ".ogv": return "video/ogg";
            case ".json": return "application/json; charset=utf-8";
            case ".md": return "text/markdown; charset=utf-8";
            case ".txt": return "text/plain; charset=utf-8";
            default: return "application/octet-stream";
        }
    }

    private sealed class Request
    {
        public string method;
        public string target;
        public Dictionary<string, string> headers;
        public string body;
        public byte[] bodyBytes;
    }

    private sealed class Settings
    {
        public string libraryRoot { get; set; }
        public Dictionary<string, string> aiPreferences { get; set; }
    }

    private sealed class AiPreferencesRequest
    {
        public Dictionary<string, string> preferences { get; set; }
    }

    private sealed class TreeNode
    {
        public string name { get; set; }
        public string path { get; set; }
        public bool paper { get; set; }
        public bool hasMarkdown { get; set; }
        public string status { get; set; }
        public string title { get; set; }
        public string parsedTitle { get; set; }
        public List<string> tags { get; set; }
        public bool favorite { get; set; }
        public string lastOpenedAt { get; set; }
        public string addedAt { get; set; }
        public bool addedTimeEstimated { get; set; }
        public List<TreeNode> children { get; set; }
    }

    private sealed class SaveRequest
    {
        public string paperPath { get; set; }
        public ReviewRecord review { get; set; }
    }

    private sealed class TagRequest { public string tag { get; set; } }

    private sealed class TagUpdateRequest
    {
        public string source { get; set; }
        public string target { get; set; }
    }

    private sealed class ReviewRecord
    {
        public string status { get; set; }
        public string title { get; set; }
        public List<string> tags { get; set; }
        public bool favorite { get; set; }
        public string lastOpenedAt { get; set; }
        public string note { get; set; }
        public double markdownScroll { get; set; }
        public double pdfWidth { get; set; }
        public bool? pdfCollapsed { get; set; }
        public bool? markdownCollapsed { get; set; }
        public string updatedAt { get; set; }
        public List<Annotation> annotations { get; set; }
    }

    private sealed class Annotation
    {
        public string id { get; set; }
        public string quote { get; set; }
        public string prefix { get; set; }
        public string suffix { get; set; }
        public string comment { get; set; }
        public string kind { get; set; }
        public string createdAt { get; set; }
        public string updatedAt { get; set; }
    }

    private sealed class RpcRequest
    {
        public string method { get; set; }
        public object parameters { get; set; }
    }

    private sealed class RpcResponse
    {
        public object id { get; set; }
        public object result { get; set; }
        public object error { get; set; }
    }

    private sealed class CodexBridge : IDisposable
    {
        private readonly object gate = new object();
        private readonly object writeGate = new object();
        private readonly Dictionary<string, PendingRpc> pending = new Dictionary<string, PendingRpc>();
        private readonly List<BridgeEvent> events = new List<BridgeEvent>();
        private readonly Dictionary<string, string> threadDirectories = new Dictionary<string, string>();
        private Process process;
        private long nextID;
        private long nextSequence;
        private string binaryPath;
        private object account;
        private string stderrTail = "";
        private bool disposed;

        public object ConnectInfo()
        {
            EnsureStarted();
            return new
            {
                connected = process != null && !process.HasExited,
                binaryPath = binaryPath,
                account = account,
                translationWorkspace = TranslationWorkspaceDirectory
            };
        }

        public object Request(string method, object parameters)
        {
            EnsureStarted();
            object result = RequestCore(method, parameters ?? new Dictionary<string, object>(), 120000);
            RememberThreadDirectory(method, parameters, result);
            return result;
        }

        public object ReadHistory(string method, object parameters)
        {
            if (method != "thread/list" && method != "thread/read" && method != "thread/turns/list")
                throw new InvalidOperationException("历史导出只允许读取对话。");
            EnsureStarted();
            return RequestCore(method, parameters ?? new Dictionary<string, object>(), 20000);
        }

        public object ReadEvents(long after, int waitMilliseconds)
        {
            EnsureStarted();
            lock (gate)
            {
                if (!events.Exists(delegate(BridgeEvent item) { return item.seq > after; }))
                    Monitor.Wait(gate, waitMilliseconds);
                List<BridgeEvent> available = events.FindAll(delegate(BridgeEvent item) { return item.seq > after; });
                return new { events = available, last = nextSequence };
            }
        }

        public void Respond(object id, object result, object error)
        {
            EnsureStarted();
            Dictionary<string, object> message = new Dictionary<string, object>();
            message["id"] = id;
            if (error != null) message["error"] = error; else message["result"] = result;
            Send(message);
        }

        private void EnsureStarted()
        {
            lock (gate)
            {
                if (disposed) throw new ObjectDisposedException("CodexBridge");
                if (process != null && !process.HasExited) return;
                StartProcess();
            }
            object initialized = RequestCore("initialize", new Dictionary<string, object>
            {
                { "clientInfo", new Dictionary<string, object> { { "name", "ai-literature-reader" }, { "title", "PaperBench" }, { "version", "1.0.0" } } },
                { "capabilities", new Dictionary<string, object> { { "experimentalApi", true } } }
            }, 30000);
            Send(new Dictionary<string, object> { { "method", "initialized" }, { "params", new Dictionary<string, object>() } });
            try
            {
                object read = RequestCore("account/read", new Dictionary<string, object>(), 30000);
                Dictionary<string, object> map = read as Dictionary<string, object>;
                if (map != null && map.ContainsKey("account")) account = map["account"];
            }
            catch { account = null; }
        }

        private void StartProcess()
        {
            binaryPath = FindCodexExecutable();
            ProcessStartInfo info = new ProcessStartInfo(binaryPath, "app-server");
            info.UseShellExecute = false;
            info.CreateNoWindow = true;
            info.RedirectStandardInput = true;
            info.RedirectStandardOutput = true;
            info.RedirectStandardError = true;
            info.StandardOutputEncoding = new UTF8Encoding(false);
            info.StandardErrorEncoding = new UTF8Encoding(false);
            info.WorkingDirectory = AppDirectory;
            ApplySystemProxy(info);
            process = new Process();
            process.StartInfo = info;
            process.EnableRaisingEvents = true;
            process.OutputDataReceived += delegate(object sender, DataReceivedEventArgs args) { if (args.Data != null) HandleLine(args.Data); };
            process.ErrorDataReceived += delegate(object sender, DataReceivedEventArgs args)
            {
                if (String.IsNullOrWhiteSpace(args.Data)) return;
                lock (gate) stderrTail = (stderrTail + " " + args.Data).Trim().Substring(Math.Max(0, (stderrTail + " " + args.Data).Trim().Length - 3000));
            };
            process.Exited += delegate { FailAll("Codex App Server 已退出。" + (String.IsNullOrEmpty(stderrTail) ? "" : " " + stderrTail)); };
            if (!process.Start()) throw new InvalidOperationException("无法启动 Codex App Server。");
            process.BeginOutputReadLine();
            process.BeginErrorReadLine();
        }

        private static void ApplySystemProxy(ProcessStartInfo info)
        {
            try
            {
                IWebProxy systemProxy = WebRequest.GetSystemWebProxy();
                SetProxyEnvironment(info, systemProxy, "HTTPS_PROXY", "https://api.openai.com/");
                SetProxyEnvironment(info, systemProxy, "HTTP_PROXY", "http://example.com/");
            }
            catch { /* Keep the inherited environment if system proxy discovery fails. */ }
        }

        private static void SetProxyEnvironment(ProcessStartInfo info, IWebProxy systemProxy, string name, string destination)
        {
            if (!String.IsNullOrWhiteSpace(info.EnvironmentVariables[name])) return;
            Uri target = new Uri(destination);
            Uri proxy = systemProxy.GetProxy(target);
            if (proxy != null && proxy.IsAbsoluteUri && !proxy.Equals(target))
                info.EnvironmentVariables[name] = proxy.AbsoluteUri;
        }

        private object RequestCore(string method, object parameters, int timeout)
        {
            string id = Interlocked.Increment(ref nextID).ToString();
            PendingRpc wait = new PendingRpc();
            lock (gate) pending[id] = wait;
            Send(new Dictionary<string, object> { { "id", Int64.Parse(id) }, { "method", method }, { "params", parameters ?? new Dictionary<string, object>() } });
            if (!wait.signal.WaitOne(timeout))
            {
                lock (gate) pending.Remove(id);
                throw new TimeoutException(method + " 在 " + Math.Round(timeout / 1000.0) + " 秒内未响应。");
            }
            if (wait.error != null) throw new InvalidOperationException(wait.error);
            return wait.result;
        }

        private void Send(object message)
        {
            byte[] bytes = new UTF8Encoding(false).GetBytes(Json.Serialize(message) + "\n");
            lock (writeGate)
            {
                if (process == null || process.HasExited) throw new InvalidOperationException("Codex App Server 未连接。");
                process.StandardInput.BaseStream.Write(bytes, 0, bytes.Length);
                process.StandardInput.BaseStream.Flush();
            }
        }

        private void HandleLine(string line)
        {
            Dictionary<string, object> message;
            try { message = Json.DeserializeObject(line) as Dictionary<string, object>; }
            catch { return; }
            if (message == null) return;
            object id;
            object method;
            bool hasID = message.TryGetValue("id", out id) && id != null;
            bool hasMethod = message.TryGetValue("method", out method) && method != null;
            if (hasID && !hasMethod)
            {
                PendingRpc wait = null;
                lock (gate)
                {
                    pending.TryGetValue(Convert.ToString(id), out wait);
                    pending.Remove(Convert.ToString(id));
                }
                if (wait != null)
                {
                    object error;
                    object result;
                    if (message.TryGetValue("error", out error) && error != null) wait.error = Json.Serialize(error);
                    else if (message.TryGetValue("result", out result)) wait.result = result;
                    wait.signal.Set();
                }
                return;
            }
            if (!hasMethod) return;
            object parameters;
            message.TryGetValue("params", out parameters);
            if (hasID && String.Equals(Convert.ToString(method), "item/tool/call", StringComparison.Ordinal))
            {
                Dictionary<string, object> toolParams = parameters as Dictionary<string, object>;
                object toolName;
                if (toolParams != null && toolParams.TryGetValue("tool", out toolName) && String.Equals(Convert.ToString(toolName), "paper_workspace", StringComparison.Ordinal))
                {
                    ThreadPool.QueueUserWorkItem(delegate { ExecutePaperWorkspaceTool(id, toolParams); });
                    return;
                }
            }
            AddEvent(new BridgeEvent { type = hasID ? "serverRequest" : "notification", id = hasID ? id : null, method = Convert.ToString(method), parameters = parameters ?? new Dictionary<string, object>() });
        }

        private void RememberThreadDirectory(string method, object parameters, object result)
        {
            Dictionary<string, object> args = parameters as Dictionary<string, object>;
            Dictionary<string, object> response = result as Dictionary<string, object>;
            if (response == null) return;
            object threadValue;
            Dictionary<string, object> thread = response.TryGetValue("thread", out threadValue) ? threadValue as Dictionary<string, object> : response;
            if (thread == null) return;
            object idValue;
            if (!thread.TryGetValue("id", out idValue) || idValue == null) return;
            object cwdValue;
            string cwd = thread.TryGetValue("cwd", out cwdValue) ? Convert.ToString(cwdValue) : "";
            if (String.IsNullOrEmpty(cwd) && args != null && args.TryGetValue("cwd", out cwdValue)) cwd = Convert.ToString(cwdValue);
            if (String.IsNullOrEmpty(cwd)) return;
            lock (gate) threadDirectories[Convert.ToString(idValue)] = cwd;
        }

        private void ExecutePaperWorkspaceTool(object requestID, Dictionary<string, object> parameters)
        {
            try
            {
                object threadValue;
                object argumentsValue;
                string threadID = parameters.TryGetValue("threadId", out threadValue) ? Convert.ToString(threadValue) : "";
                Dictionary<string, object> arguments = parameters.TryGetValue("arguments", out argumentsValue) ? argumentsValue as Dictionary<string, object> : null;
                if (arguments == null) arguments = new Dictionary<string, object>();
                string directory;
                lock (gate)
                {
                    if (!threadDirectories.TryGetValue(threadID, out directory)) throw new InvalidOperationException("未找到该对话对应的论文工作区。");
                }
                directory = ValidatePaperWorkspace(directory);
                object actionValue;
                string action = arguments.TryGetValue("action", out actionValue) ? Convert.ToString(actionValue) : "list";
                string text = action == "read" ? ReadPaperText(directory, arguments) : ListPaperFiles(directory);
                Respond(requestID, new Dictionary<string, object>
                {
                    { "success", true },
                    { "contentItems", new object[] { new Dictionary<string, object> { { "type", "inputText" }, { "text", text } } } }
                }, null);
            }
            catch (Exception ex)
            {
                Respond(requestID, new Dictionary<string, object>
                {
                    { "success", false },
                    { "contentItems", new object[] { new Dictionary<string, object> { { "type", "inputText" }, { "text", ex.Message } } } }
                }, null);
            }
        }

        private static string ValidatePaperWorkspace(string directory)
        {
            string root;
            lock (StateLock) root = Path.GetFullPath(LibraryRoot);
            string full = Path.GetFullPath(directory);
            string rootPrefix = root.TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
            if (!full.Equals(root, StringComparison.OrdinalIgnoreCase) && !full.StartsWith(rootPrefix, StringComparison.OrdinalIgnoreCase))
                throw new UnauthorizedAccessException("工作区不在当前论文库中。");
            if (!Directory.Exists(full)) throw new DirectoryNotFoundException("论文工作区不存在。");
            return full;
        }

        private static string ListPaperFiles(string directory)
        {
            StringBuilder output = new StringBuilder("Files in paper workspace:\n");
            int count = 0;
            foreach (string file in Directory.GetFiles(directory, "*", SearchOption.AllDirectories))
            {
                if (++count > 300) { output.Append("… file list truncated\n"); break; }
                FileInfo info = new FileInfo(file);
                output.Append(MakeRelative(directory, file).Replace('\\', '/')).Append("\t").Append(info.Length).Append(" bytes\n");
            }
            return output.ToString();
        }

        private static string ReadPaperText(string directory, Dictionary<string, object> arguments)
        {
            object pathValue;
            string relative = arguments.TryGetValue("path", out pathValue) ? Convert.ToString(pathValue) : "";
            if (String.IsNullOrWhiteSpace(relative)) throw new InvalidOperationException("read 操作需要 path。");
            string full = Path.GetFullPath(Path.Combine(directory, relative.Replace('/', Path.DirectorySeparatorChar)));
            string prefix = directory.TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
            if (!full.StartsWith(prefix, StringComparison.OrdinalIgnoreCase) || !File.Exists(full)) throw new FileNotFoundException("论文文件不存在。", relative);
            string extension = Path.GetExtension(full).ToLowerInvariant();
            string[] allowed = { ".md", ".txt", ".json", ".csv", ".tsv", ".yaml", ".yml", ".tex", ".bib" };
            if (Array.IndexOf(allowed, extension) < 0) throw new InvalidOperationException("该工具仅读取文本文件；图片请从 Markdown 中选择后作为图片附件发送。");
            object startValue;
            object maxValue;
            int startLine = arguments.TryGetValue("startLine", out startValue) ? Math.Max(1, Convert.ToInt32(startValue)) : 1;
            int maxLines = arguments.TryGetValue("maxLines", out maxValue) ? Math.Max(1, Math.Min(800, Convert.ToInt32(maxValue))) : 240;
            StringBuilder output = new StringBuilder();
            output.Append("File: ").Append(relative.Replace('\\', '/')).Append("\n");
            int lineNumber = 0;
            int emitted = 0;
            using (StreamReader reader = new StreamReader(full, Encoding.UTF8, true))
            {
                string line;
                while ((line = reader.ReadLine()) != null)
                {
                    lineNumber++;
                    if (lineNumber < startLine) continue;
                    if (emitted++ >= maxLines || output.Length > 180000) break;
                    output.Append(lineNumber).Append(": ").Append(line).Append("\n");
                }
                if (!reader.EndOfStream) output.Append("… truncated; call read again with startLine=").Append(lineNumber + 1).Append("\n");
            }
            return output.ToString();
        }

        private void AddEvent(BridgeEvent value)
        {
            lock (gate)
            {
                value.seq = ++nextSequence;
                events.Add(value);
                if (events.Count > 2000) events.RemoveRange(0, events.Count - 1500);
                Monitor.PulseAll(gate);
            }
        }

        private void FailAll(string message)
        {
            lock (gate)
            {
                foreach (PendingRpc wait in pending.Values) { wait.error = message; wait.signal.Set(); }
                pending.Clear();
                AddEvent(new BridgeEvent { type = "disconnected", method = "bridge/disconnected", parameters = new { message = message } });
            }
        }

        private static string FindCodexExecutable()
        {
            List<string> candidates = new List<string>();
            string local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
            string root = Path.Combine(local, "OpenAI", "Codex", "bin");
            if (Directory.Exists(root))
            {
                try { candidates.AddRange(Directory.GetFiles(root, "codex.exe", SearchOption.AllDirectories)); } catch { }
            }
            string appData = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
            string npmRoot = Path.Combine(appData, "npm", "node_modules", "@openai");
            if (Directory.Exists(npmRoot))
            {
                try { candidates.AddRange(Directory.GetFiles(npmRoot, "codex.exe", SearchOption.AllDirectories)); } catch { }
            }
            string pathValue = Environment.GetEnvironmentVariable("PATH") ?? "";
            foreach (string part in pathValue.Split(';'))
            {
                try { if (!String.IsNullOrWhiteSpace(part)) candidates.Add(Path.Combine(part.Trim(' ', '"'), "codex.exe")); } catch { }
            }
            candidates.RemoveAll(delegate(string path) { return !File.Exists(path); });
            if (candidates.Count == 0) throw new FileNotFoundException("没有找到 codex.exe。请先安装并登录 Codex CLI。");
            candidates.Sort(delegate(string left, string right) { return File.GetLastWriteTimeUtc(right).CompareTo(File.GetLastWriteTimeUtc(left)); });
            return candidates[0];
        }

        public void Dispose()
        {
            lock (gate)
            {
                if (disposed) return;
                disposed = true;
                foreach (PendingRpc wait in pending.Values) { wait.error = "应用正在关闭。"; wait.signal.Set(); }
                pending.Clear();
                try { if (process != null && !process.HasExited) process.Kill(); } catch { }
                try { if (process != null) process.Dispose(); } catch { }
                process = null;
            }
        }

        private sealed class PendingRpc
        {
            public readonly ManualResetEvent signal = new ManualResetEvent(false);
            public object result;
            public string error;
        }

        private sealed class BridgeEvent
        {
            public long seq { get; set; }
            public string type { get; set; }
            public object id { get; set; }
            public string method { get; set; }
            public object parameters { get; set; }
        }
    }
}
