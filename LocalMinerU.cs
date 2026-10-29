using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Text;
using System.Threading;
using System.Windows.Forms;

internal static partial class MinerULibraryReview
{
    private static readonly object MinerUJobLock = new object();
    private sealed class MinerUJob
    {
        public string state = "running";
        public string message = "正在启动本机 MinerU…";
        public string tier = "";
    }
    private static readonly Dictionary<string, MinerUJob> MinerUJobs = new Dictionary<string, MinerUJob>(StringComparer.OrdinalIgnoreCase);
    private static int MinerUOwnedApiPid;
    private static string MinerUOwnedRoot;
    private static string MinerUOwnedKit;
    private static string MinerUOwnedPidPath;
    private static int MinerUCleanupGeneration;
    private static string MinerULocationPath { get { return Path.Combine(StateDirectory, "mineru-location.txt"); } }

    private static bool TryResolveMinerU(string candidate, out string root, out string python, out string kit, out bool legacy)
    {
        root = python = kit = null;
        legacy = false;
        if (String.IsNullOrWhiteSpace(candidate)) return false;
        try
        {
            string path = Path.GetFullPath(candidate.Trim().Trim('"'));
            if (File.Exists(path)) path = Path.GetDirectoryName(path);
            var roots = new List<string> { path, Path.Combine(path, ".venv"), Path.Combine(path, "venv") };
            if (String.Equals(Path.GetFileName(path), "Scripts", StringComparison.OrdinalIgnoreCase))
                roots.Add(Path.GetDirectoryName(path));
            foreach (string item in roots)
            {
                string oldPython = Path.Combine(item, "runtime", "venv", "Scripts", "python.exe");
                string oldKit = Path.Combine(item, "runtime", "venv", "Scripts", "mineru-kit.exe");
                if (File.Exists(oldPython) && File.Exists(oldKit) && File.Exists(Path.Combine(item, "config", "api-key.txt")))
                { root = item; python = oldPython; kit = oldKit; legacy = true; return true; }
                string venvPython = Path.Combine(item, "Scripts", "python.exe");
                string venvKit = Path.Combine(item, "Scripts", "mineru-kit.exe");
                if (File.Exists(venvPython) && File.Exists(venvKit))
                { root = item; python = venvPython; kit = venvKit; return true; }
                string globalPython = Path.Combine(item, "python.exe");
                string globalKit = Path.Combine(item, "Scripts", "mineru-kit.exe");
                if (File.Exists(globalPython) && File.Exists(globalKit))
                { root = item; python = globalPython; kit = globalKit; return true; }
            }
        }
        catch { }
        return false;
    }

    private static string FindLocalMinerU()
    {
        var candidates = new List<string>();
        try { if (File.Exists(MinerULocationPath)) candidates.Add(File.ReadAllText(MinerULocationPath, Encoding.UTF8).Trim()); } catch { }
        candidates.Add(AppDirectory);
        candidates.Add(Path.GetDirectoryName(AppDirectory));
        candidates.Add(Environment.GetEnvironmentVariable("PAPERBENCH_MINERU_ROOT"));
        candidates.Add(Environment.GetEnvironmentVariable("MINERU_ROOT"));
        candidates.Add(Environment.GetEnvironmentVariable("VIRTUAL_ENV"));
        string pathVariable = Environment.GetEnvironmentVariable("PATH") ?? "";
        candidates.AddRange(pathVariable.Split(new[] { Path.PathSeparator }, StringSplitOptions.RemoveEmptyEntries));
        foreach (DriveInfo drive in DriveInfo.GetDrives())
            try { if (drive.IsReady) candidates.Add(Path.Combine(drive.RootDirectory.FullName, "MinerU")); } catch { }
        foreach (string candidate in candidates.Where(x => !String.IsNullOrWhiteSpace(x)))
        {
            string root, python, kit; bool legacy;
            if (TryResolveMinerU(candidate, out root, out python, out kit, out legacy)) return root;
        }
        return null;
    }

    private static void LocalMinerUStatus(Stream stream, string paper)
    {
        string root = FindLocalMinerU();
        string state = "idle", message = "", tier = "";
        int running;
        lock (MinerUJobLock)
        {
            MinerUJob job;
            if (paper != null && MinerUJobs.TryGetValue(paper, out job)) { state = job.state; message = job.message; tier = job.tier; }
            running = MinerUJobs.Values.Count(x => x.state == "running");
        }
        WriteJson(stream, new { available = root != null, root = root, state = state, message = message, tier = tier, running = running, capacity = 2 });
    }

    private static void SelectLocalMinerU(Stream stream)
    {
        IntPtr owner = GetForegroundWindow();
        string selected = MaterialChooseFolder(owner, "选择 MinerU 安装目录或 .venv 文件夹");
        if (selected != null)
        {
            string root, python, kit; bool legacy;
            if (!TryResolveMinerU(selected, out root, out python, out kit, out legacy))
                throw new InvalidOperationException("未找到 MinerU 命令。请选择包含 .venv 的文件夹、.venv 本身，或现有 MinerU 安装目录。");
            AtomicWrite(MinerULocationPath, root);
        }
        WriteJson(stream, new { selected = selected != null, available = FindLocalMinerU() != null });
    }

    private static void StartLocalMinerU(Stream stream, string body)
    {
        lock (PdfProcessingLock) StartLocalMinerUCore(stream, body);
    }

    private static void StartLocalMinerUCore(Stream stream, string body)
    {
        Dictionary<string, string> request = Json.Deserialize<Dictionary<string, string>>(body);
        string paper = request == null || !request.ContainsKey("paper") ? null : request["paper"];
        string directory = ResolvePaper(paper);
        lock (MinerUJobLock)
        {
            MinerUJob current;
            if (MinerUJobs.TryGetValue(paper, out current) && current.state == "running") throw new InvalidOperationException("这篇论文已经在解析中。");
        }
        bool removePrevious = request.ContainsKey("removePrevious") && request["removePrevious"] == "true";
        var manifest = LoadParseManifest(directory);
        if (File.Exists(Path.Combine(directory, "markdown.md")))
        {
            string warning = CompleteParsing(directory, manifest, "fine", manifest.fine == null ? new[] { "markdown.md", "structured_content.json" } : manifest.fine.Keys.ToArray(), removePrevious, true);
            InterlockedIncrementLibrary();
            WriteJson(stream, new { started = false, reused = true, preferredTextPath = PreferredPaperText(directory), message = "已使用现有精细解析结果" + warning }); return;
        }
        string pdf = FindPdf(directory);
        if (pdf == null) throw new FileNotFoundException("论文 PDF 不存在。", directory);
        string root = FindLocalMinerU();
        if (root == null) throw new InvalidOperationException("未找到可用的本机 MinerU，请选择安装目录。");
        AtomicWrite(ParseManifestPath(directory), Json.Serialize(manifest));
        lock (MinerUJobLock)
        {
            MinerUJob existing;
            if (MinerUJobs.TryGetValue(paper, out existing) && existing.state == "running") throw new InvalidOperationException("这篇论文已经在解析中。");
            if (MinerUJobs.Values.Count(x => x.state == "running") >= 2) throw new InvalidOperationException("已有两篇论文正在解析，请等待其中一篇完成。");
            MinerUJobs[paper] = new MinerUJob();
            MinerUCleanupGeneration++;
        }
        Thread worker = new Thread(delegate() { RunLocalMinerU(root, paper, directory, pdf, removePrevious); });
        // Let an in-flight parse finish even if the reading window closes.
        worker.IsBackground = false;
        worker.Start();
        WriteJson(stream, new { started = true });
    }

    private static void RunLocalMinerU(string root, string paper, string directory, string pdf, bool removePrevious)
    {
        string staging = Path.Combine(StateDirectory, "mineru-staging", Guid.NewGuid().ToString("N"));
        string helper = staging + ".py";
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(staging));
            using (Stream resource = Assembly.GetExecutingAssembly().GetManifestResourceStream("MinerUParseHelper"))
            {
                if (resource == null) throw new InvalidOperationException("程序缺少 MinerU 解析组件。");
                using (FileStream target = new FileStream(helper, FileMode.Create, FileAccess.Write, FileShare.Read)) resource.CopyTo(target);
            }
            string resolved, python, kit; bool legacy;
            if (!TryResolveMinerU(root, out resolved, out python, out kit, out legacy))
                throw new InvalidOperationException("MinerU 环境已移动或不完整，请重新选择安装目录。");
            ProcessStartInfo info = new ProcessStartInfo(python);
            info.Arguments = "\"" + helper + "\" \"" + pdf + "\" --output \"" + staging + "\" --tier auto";
            info.WorkingDirectory = root;
            info.UseShellExecute = false;
            info.CreateNoWindow = true;
            info.RedirectStandardOutput = true;
            info.RedirectStandardError = true;
            info.EnvironmentVariables["PAPERBENCH_MINERU_ROOT"] = root;
            info.EnvironmentVariables["PAPERBENCH_MINERU_KIT"] = kit;
            info.EnvironmentVariables["PAPERBENCH_MINERU_LAYOUT"] = legacy ? "legacy" : "standard";
            info.EnvironmentVariables["PAPERBENCH_MINERU_STATE"] = StateDirectory;
            info.EnvironmentVariables["PAPERBENCH_MINERU_API_URL"] = "http://127.0.0.1:8000";
            string output, error;
            using (Process process = Process.Start(info))
            {
                if (process == null) throw new InvalidOperationException("无法启动 MinerU Python 环境。");
                System.Threading.Tasks.Task<string> stderr = System.Threading.Tasks.Task.Factory.StartNew(() => process.StandardError.ReadToEnd());
                output = process.StandardOutput.ReadToEnd();
                error = stderr.Result;
                process.WaitForExit();
                int startedPid = ReadStartedApiPid(error);
                if (startedPid > 0) lock (MinerUJobLock)
                {
                    MinerUOwnedApiPid = startedPid;
                    MinerUOwnedRoot = root;
                    MinerUOwnedKit = kit;
                    MinerUOwnedPidPath = legacy ? Path.Combine(root, "state", "api.pid") : Path.Combine(StateDirectory, "mineru-api.pid");
                }
                if (process.ExitCode != 0) throw new InvalidOperationException("MinerU 解析失败：" + (error.Length > 700 ? error.Substring(error.Length - 700) : error));
            }
            if (!File.Exists(Path.Combine(staging, "markdown.md")) || !File.Exists(Path.Combine(staging, "structured_content.json")))
                throw new InvalidDataException("MinerU 返回的结果缺少 Markdown 或结构化内容。");
            if (!Directory.Exists(directory) || !File.Exists(pdf) || File.Exists(Path.Combine(directory, "markdown.md")))
                throw new InvalidOperationException("解析期间论文目录已变化，未覆盖原有文件。");
            string[] generated = Directory.GetFiles(staging, "*", SearchOption.AllDirectories)
                .Select(x => MakeRelative(staging, x).Replace('\\', '/')).Where(x => !x.EndsWith(".pdf", StringComparison.OrdinalIgnoreCase)).ToArray();
            // An old parse may leave an images directory containing personal
            // files. Merge new files only after checking every destination.
            string[] publish = Directory.GetFiles(staging, "*", SearchOption.AllDirectories)
                .Where(x => !String.Equals(Path.GetFileName(x), Path.GetFileName(pdf), StringComparison.OrdinalIgnoreCase)).ToArray();
            foreach (string file in publish)
            {
                string target = Path.Combine(directory, MakeRelative(staging, file)); MaterialNoLinks(target);
                if (File.Exists(target) || Directory.Exists(target)) throw new IOException("论文目录已有同名文件：" + MakeRelative(staging, file));
            }
            var published = new List<string>();
            try
            {
                foreach (string file in publish.OrderBy(x => String.Equals(Path.GetFileName(x), "markdown.md", StringComparison.OrdinalIgnoreCase) ? 1 : 0))
                {
                    string target = Path.Combine(directory, MakeRelative(staging, file));
                    Directory.CreateDirectory(Path.GetDirectoryName(target)); File.Move(file, target); published.Add(target);
                }
            }
            catch
            {
                foreach (string target in published)
                {
                    string original = Path.Combine(staging, MakeRelative(directory, target));
                    Directory.CreateDirectory(Path.GetDirectoryName(original)); File.Move(target, original);
                }
                throw;
            }
            string cleanupWarning;
            lock (PdfProcessingLock) cleanupWarning = CompleteParsing(directory, LoadParseManifest(directory), "fine", generated, removePrevious);
            string tier = "";
            try { Dictionary<string, object> result = Json.Deserialize<Dictionary<string, object>>(output); if (result != null && result.ContainsKey("tier")) tier = Convert.ToString(result["tier"]); } catch { }
            lock (MinerUJobLock) { MinerUJobs[paper].state = "completed"; MinerUJobs[paper].tier = tier; MinerUJobs[paper].message = "解析完成，已在原论文目录加入 Markdown 和图片。" + cleanupWarning; }
            Interlocked.Increment(ref LibraryRevision);
        }
        catch (Exception ex)
        {
            lock (MinerUJobLock) { MinerUJobs[paper].state = "failed"; MinerUJobs[paper].message = ex.Message; }
        }
        finally
        {
            try { if (Directory.Exists(staging)) Directory.Delete(staging, true); } catch { }
            try { if (File.Exists(helper)) File.Delete(helper); } catch { }
            if (Stopping) StopOwnedMinerUIfIdle();
            else ScheduleMinerUIdleShutdown();
        }
    }

    private static int ReadStartedApiPid(string stderr)
    {
        const string marker = "PAPERBENCH_API_STARTED=";
        int at = stderr.IndexOf(marker, StringComparison.Ordinal);
        if (at < 0) return 0;
        at += marker.Length;
        int end = at;
        while (end < stderr.Length && Char.IsDigit(stderr[end])) end++;
        int pid;
        return Int32.TryParse(stderr.Substring(at, end - at), out pid) ? pid : 0;
    }

    private static void ScheduleMinerUIdleShutdown()
    {
        int generation;
        lock (MinerUJobLock)
        {
            if (MinerUOwnedApiPid <= 0 || MinerUJobs.Values.Any(x => x.state == "running")) return;
            generation = ++MinerUCleanupGeneration;
        }
        Thread cleanup = new Thread(delegate()
        {
            Thread.Sleep(90000);
            int pid;
            string root;
            string kit, pidPath;
            lock (MinerUJobLock)
            {
                if (generation != MinerUCleanupGeneration || MinerUJobs.Values.Any(x => x.state == "running")) return;
                pid = MinerUOwnedApiPid;
                root = MinerUOwnedRoot;
                kit = MinerUOwnedKit;
                pidPath = MinerUOwnedPidPath;
            }
            if (pid <= 0 || root == null || kit == null || pidPath == null) return;
            try
            {
                int recorded;
                if (!Int32.TryParse(File.ReadAllText(pidPath).Trim(), out recorded) || recorded != pid) return;
                using (Process process = Process.GetProcessById(pid))
                {
                    string expected = Path.GetFullPath(kit);
                    if (!String.Equals(Path.GetFullPath(process.MainModule.FileName), expected, StringComparison.OrdinalIgnoreCase)) return;
                    process.Kill();
                    process.WaitForExit(15000);
                }
                File.Delete(pidPath);
                lock (MinerUJobLock) { if (MinerUOwnedApiPid == pid) { MinerUOwnedApiPid = 0; MinerUOwnedRoot = null; MinerUOwnedKit = null; MinerUOwnedPidPath = null; } }
            }
            catch { }
        });
        cleanup.IsBackground = true;
        cleanup.Start();
    }

    private static void StopOwnedMinerUIfIdle()
    {
        int pid;
        string root;
        string kit, pidPath;
        lock (MinerUJobLock)
        {
            if (MinerUJobs.Values.Any(x => x.state == "running")) return;
            pid = MinerUOwnedApiPid;
            root = MinerUOwnedRoot;
            kit = MinerUOwnedKit;
            pidPath = MinerUOwnedPidPath;
            MinerUCleanupGeneration++;
        }
        if (pid <= 0 || root == null || kit == null || pidPath == null) return;
        try
        {
            int recorded;
            if (!Int32.TryParse(File.ReadAllText(pidPath).Trim(), out recorded) || recorded != pid) return;
            using (Process process = Process.GetProcessById(pid))
            {
                string expected = Path.GetFullPath(kit);
                if (!String.Equals(Path.GetFullPath(process.MainModule.FileName), expected, StringComparison.OrdinalIgnoreCase)) return;
                process.Kill();
                process.WaitForExit(15000);
            }
            File.Delete(pidPath);
            lock (MinerUJobLock) { if (MinerUOwnedApiPid == pid) { MinerUOwnedApiPid = 0; MinerUOwnedRoot = null; MinerUOwnedKit = null; MinerUOwnedPidPath = null; } }
        }
        catch { }
    }
}
