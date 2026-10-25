using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Threading;

internal static partial class MinerULibraryReview
{
    private sealed class PaperRecycleRequest
    {
        public string path { get; set; }
        public string directory { get; set; }
        public string libraryRoot { get; set; }
        public string keep { get; set; }
        public string hash { get; set; }
    }

    private static string ValidateRecyclePaper(string root, string path)
    {
        string directory = MaterialResolve(root, path);
        if (String.IsNullOrEmpty(FindPdf(directory)) && !File.Exists(Path.Combine(directory, "markdown.md")))
            throw new IOException("该目录不是论文目录。");
        if (MaterialInside(StateDirectory, directory) || MaterialInside(AttachmentDirectory, directory) || MaterialInside(AppDirectory, directory))
            throw new IOException("该目录包含程序或独立保存的资料，不能移至回收站。");
        ValidateRecycleContents(directory);
        var links = LoadAttachmentLinks();
        if (links.Any(x => x.kind == "parsed" && MaterialInside(Path.Combine(root, x.path), directory) && !MaterialInside(Path.Combine(root, x.parent), directory) && Directory.Exists(Path.Combine(root, x.parent))))
            throw new IOException("这篇论文仍被其他论文作为解析附件使用。请先在对应论文的附件管理中解除关联，再移至回收站。");
        return directory;
    }

    private static void ValidateRecycleContents(string directory)
    {
        foreach (string entry in Directory.EnumerateFileSystemEntries(directory))
        {
            if ((File.GetAttributes(entry) & FileAttributes.ReparsePoint) != 0)
                throw new IOException("目录中含有符号链接或目录联接，请先手动处理：" + entry);
            if (!Directory.Exists(entry)) continue;
            if (!String.IsNullOrEmpty(FindPdf(entry)) || File.Exists(Path.Combine(entry, "markdown.md")))
                throw new IOException("目录中还包含其他论文，请先整理后再移至回收站：" + entry);
            ValidateRecycleContents(entry);
        }
    }

    private static object PreviewPaperRecycle(string path)
    {
        lock (StateLock)
        {
            string root = Path.GetFullPath(LibraryRoot);
            string directory = ValidateRecyclePaper(root, path);
            MaterialSource source = MaterialReadSource(root, directory);
            var links = LoadAttachmentLinks().Where(x => x.parent.Equals(path, StringComparison.OrdinalIgnoreCase)).ToList();
            return new { path = path, directory = directory, libraryRoot = root, title = source.title,
                annotations = source.review.annotations == null ? 0 : source.review.annotations.Count,
                hasNote = !String.IsNullOrWhiteSpace(source.review.note), hasCitation = source.citation != null,
                attachments = links.Count, warnings = source.warnings };
        }
    }

    private static void RecyclePaper(Stream stream, string body)
    {
        PaperRecycleRequest request = Json.Deserialize<PaperRecycleRequest>(body);
        if (request == null) throw new IOException("请选择要移至回收站的论文。");
        // Keep root selection and paper-state writes serialized until the Shell finishes.
        lock (StateLock)
        {
            string root = Path.GetFullPath(LibraryRoot);
            if (!root.Equals(request.libraryRoot, StringComparison.OrdinalIgnoreCase)) throw new IOException("论文库已切换，请重新打开确认窗口。");
            string directory = ValidateRecyclePaper(root, request.path);
            if (!directory.Equals(request.directory, StringComparison.OrdinalIgnoreCase)) throw new IOException("论文路径发生变化，请重新确认。");
            if (!String.IsNullOrWhiteSpace(request.keep))
            {
                string keep = MaterialResolve(root, request.keep);
                if (MaterialInside(keep, directory)) throw new IOException("不能移走需要保留的论文目录。");
                string targetPdf = FindPdf(directory), keepPdf = FindPdf(keep);
                if (targetPdf == null || keepPdf == null) throw new IOException("论文 PDF 已变化，请刷新重复列表。");
                var hashes = new Dictionary<string, PdfHashCacheEntry>(StringComparer.OrdinalIgnoreCase);
                if (HashPdf(targetPdf, hashes) != request.hash || HashPdf(keepPdf, hashes) != request.hash)
                    throw new IOException("PDF 内容已变化，无法确认重复，请刷新后重试。");
            }
            Exception failure = null;
            Thread thread = new Thread(delegate()
            {
                try { RecycleDirectoryWithShell(directory); }
                catch (Exception ex) { failure = ex; }
            });
            thread.SetApartmentState(ApartmentState.STA);
            thread.Start(); thread.Join();
            if (failure != null) throw new IOException("未能移至回收站：" + failure.Message, failure);
            Interlocked.Increment(ref LibraryRevision);
            WriteJson(stream, new { recycled = true });
        }
    }

    private static void RecycleDirectoryWithShell(string directory)
    {
        int initialized = CoInitializeEx(IntPtr.Zero, 2);
        Marshal.ThrowExceptionForHR(initialized);
        object instance = null; ExportShellItem item = null;
        try
        {
            instance = Activator.CreateInstance(Type.GetTypeFromCLSID(new Guid("3AD05575-8857-4850-9277-11B85BDB8E09")));
            RecycleFileOperation operation = (RecycleFileOperation)instance;
            // Windows 8+: recycle explicitly; confirmation is already shown in the application.
            // The progress sink independently vetoes permanent deletion, including fallback requests.
            operation.SetOperationFlags(0x00080000u | 0x20000000u | 0x00100000u | 0x0400u | 0x0004u | 0x0010u);
            Guid iid = typeof(ExportShellItem).GUID;
            Marshal.ThrowExceptionForHR(RecycleCreateShellItem(directory, IntPtr.Zero, ref iid, out item));
            RecycleProgress guard = new RecycleProgress();
            operation.DeleteItem(item, guard);
            operation.PerformOperations();
            bool aborted; operation.GetAnyOperationsAborted(out aborted);
            if (guard.failure < 0) Marshal.ThrowExceptionForHR(guard.failure);
            if (aborted || !guard.recycled || Directory.Exists(directory))
                throw new IOException("操作未完成，或系统无法将该目录放入回收站。未执行永久删除。");
            GC.KeepAlive(guard);
        }
        finally
        {
            if (item != null) Marshal.ReleaseComObject(item);
            if (instance != null) Marshal.FinalReleaseComObject(instance);
            CoUninitialize();
        }
    }

    [DllImport("shell32.dll", EntryPoint = "SHCreateItemFromParsingName", CharSet = CharSet.Unicode, PreserveSig = true)]
    private static extern int RecycleCreateShellItem(string path, IntPtr context, ref Guid iid, out ExportShellItem item);

    [ComImport, Guid("947AAB5F-0A5C-4C13-B4D6-4BF7836FC9F8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface RecycleFileOperation
    {
        void Advise(RecycleProgressSink sink, out uint cookie);
        void Unadvise(uint cookie);
        void SetOperationFlags(uint flags);
        void SetProgressMessage([MarshalAs(UnmanagedType.LPWStr)] string message);
        void SetProgressDialog(IntPtr dialog);
        void SetProperties(IntPtr properties);
        void SetOwnerWindow(IntPtr owner);
        void ApplyPropertiesToItem(ExportShellItem item);
        void ApplyPropertiesToItems(IntPtr items);
        void RenameItem(ExportShellItem item, [MarshalAs(UnmanagedType.LPWStr)] string name, RecycleProgressSink sink);
        void RenameItems(IntPtr items, [MarshalAs(UnmanagedType.LPWStr)] string name);
        void MoveItem(ExportShellItem item, ExportShellItem destination, [MarshalAs(UnmanagedType.LPWStr)] string name, RecycleProgressSink sink);
        void MoveItems(IntPtr items, ExportShellItem destination);
        void CopyItem(ExportShellItem item, ExportShellItem destination, [MarshalAs(UnmanagedType.LPWStr)] string name, RecycleProgressSink sink);
        void CopyItems(IntPtr items, ExportShellItem destination);
        void DeleteItem(ExportShellItem item, RecycleProgressSink sink);
        void DeleteItems(IntPtr items);
        void NewItem(ExportShellItem destination, uint attributes, [MarshalAs(UnmanagedType.LPWStr)] string name, [MarshalAs(UnmanagedType.LPWStr)] string template, RecycleProgressSink sink);
        void PerformOperations();
        void GetAnyOperationsAborted([MarshalAs(UnmanagedType.Bool)] out bool aborted);
    }

    [ComVisible(true), Guid("04B0F1A7-9490-44BC-96E1-4296A31252E2"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface RecycleProgressSink
    {
        [PreserveSig] int StartOperations();
        [PreserveSig] int FinishOperations(int result);
        [PreserveSig] int PreRenameItem(uint flags, IntPtr item, [MarshalAs(UnmanagedType.LPWStr)] string name);
        [PreserveSig] int PostRenameItem(uint flags, IntPtr item, [MarshalAs(UnmanagedType.LPWStr)] string name, int result, IntPtr created);
        [PreserveSig] int PreMoveItem(uint flags, IntPtr item, IntPtr destination, [MarshalAs(UnmanagedType.LPWStr)] string name);
        [PreserveSig] int PostMoveItem(uint flags, IntPtr item, IntPtr destination, [MarshalAs(UnmanagedType.LPWStr)] string name, int result, IntPtr created);
        [PreserveSig] int PreCopyItem(uint flags, IntPtr item, IntPtr destination, [MarshalAs(UnmanagedType.LPWStr)] string name);
        [PreserveSig] int PostCopyItem(uint flags, IntPtr item, IntPtr destination, [MarshalAs(UnmanagedType.LPWStr)] string name, int result, IntPtr created);
        [PreserveSig] int PreDeleteItem(uint flags, IntPtr item);
        [PreserveSig] int PostDeleteItem(uint flags, IntPtr item, int result, IntPtr created);
        [PreserveSig] int PreNewItem(uint flags, IntPtr destination, [MarshalAs(UnmanagedType.LPWStr)] string name);
        [PreserveSig] int PostNewItem(uint flags, IntPtr destination, [MarshalAs(UnmanagedType.LPWStr)] string name, [MarshalAs(UnmanagedType.LPWStr)] string template, uint attributes, int result, IntPtr created);
        [PreserveSig] int UpdateProgress(uint total, uint complete);
        [PreserveSig] int ResetTimer();
        [PreserveSig] int PauseTimer();
        [PreserveSig] int ResumeTimer();
    }

    [ComVisible(true), ClassInterface(ClassInterfaceType.None)]
    public sealed class RecycleProgress : RecycleProgressSink
    {
        public int failure; public bool recycled;
        public int StartOperations() { return 0; }
        public int FinishOperations(int result) { if (result < 0) failure = result; return 0; }
        public int PreDeleteItem(uint flags, IntPtr item)
        {
            // Veto any Shell request that is no longer a recycling operation.
            if ((flags & 0x80) != 0) return 0;
            failure = unchecked((int)0x800704C7); return failure;
        }
        public int PostDeleteItem(uint flags, IntPtr item, int result, IntPtr created)
        { if (result < 0) failure = result; else if (created != IntPtr.Zero) recycled = true; return 0; }
        public int PreRenameItem(uint f, IntPtr i, string n) { return 0; }
        public int PostRenameItem(uint f, IntPtr i, string n, int r, IntPtr c) { return 0; }
        public int PreMoveItem(uint f, IntPtr i, IntPtr d, string n) { return 0; }
        public int PostMoveItem(uint f, IntPtr i, IntPtr d, string n, int r, IntPtr c) { return 0; }
        public int PreCopyItem(uint f, IntPtr i, IntPtr d, string n) { return 0; }
        public int PostCopyItem(uint f, IntPtr i, IntPtr d, string n, int r, IntPtr c) { return 0; }
        public int PreNewItem(uint f, IntPtr d, string n) { return 0; }
        public int PostNewItem(uint f, IntPtr d, string n, string t, uint a, int r, IntPtr c) { return 0; }
        public int UpdateProgress(uint t, uint c) { return 0; }
        public int ResetTimer() { return 0; }
        public int PauseTimer() { return 0; }
        public int ResumeTimer() { return 0; }
    }
}
