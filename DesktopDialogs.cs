using System;
using System.Runtime.InteropServices;
using System.Threading;

internal static partial class MinerULibraryReview
{
    private static readonly object ExportFolderDialogGate = new object();

    // Windows Common Item Dialog, not the legacy FolderBrowserDialog tree.
    // Create and release all COM objects on a fresh STA for each invocation.
    private static string ChooseModernExportFolder(IntPtr owner)
    {
        int initialized = CoInitializeEx(IntPtr.Zero, 2); // COINIT_APARTMENTTHREADED
        if (initialized < 0) Marshal.ThrowExceptionForHR(initialized);
        IntPtr previousDpi = IntPtr.Zero;
        object instance = null;
        ExportShellItem result = null;
        System.Windows.Forms.Timer focusTimer = null;
        try
        {
            try { previousDpi = SetThreadDpiAwarenessContext(new IntPtr(-4)); } // PER_MONITOR_AWARE_V2, only this UI thread
            catch (EntryPointNotFoundException) { }
            instance = Activator.CreateInstance(Type.GetTypeFromCLSID(new Guid("DC1C5A9C-E88A-4DDE-A5A1-60F82A20AEF7")));
            var dialog = (ExportFileDialog)instance;
            uint flags; dialog.GetOptions(out flags);
            dialog.SetOptions(flags | 0x20u | 0x40u | 0x800u | 0x02000000u); // PICKFOLDERS, FORCEFILESYSTEM, PATHMUSTEXIST, DONTADDTORECENT
            dialog.SetTitle("选择阅读资料的导出位置（将在其中新建文件夹）");
            dialog.SetOkButtonLabel("选择此文件夹");
            Guid client = new Guid("B30282E9-714C-419A-9241-6E4C61C1EB07");
            dialog.SetClientGuid(ref client);

            // The native window is created by Show. Raise it once after it is visible,
            // rather than trying to activate an invisible WinForms owner.
            focusTimer = new System.Windows.Forms.Timer { Interval = 100 };
            focusTimer.Tick += delegate
            {
                try
                {
                    IntPtr window;
                    ((ExportOleWindow)instance).GetWindow(out window);
                    if (window == IntPtr.Zero || !IsWindowVisible(window)) return;
                    BringWindowToFront(window);
                    const uint showFlags = 0x0001 | 0x0002 | 0x0040;
                    SetWindowPos(window, new IntPtr(-1), 0, 0, 0, 0, showFlags);
                    focusTimer.Stop(); // No repeated focus stealing while the user works.
                }
                catch (COMException) { }
                catch (InvalidCastException) { focusTimer.Stop(); }
            };
            focusTimer.Start();
            int shown = dialog.Show(IsWindow(owner) ? owner : IntPtr.Zero);
            if (shown == unchecked((int)0x800704C7)) return null; // user cancelled
            if (shown < 0) Marshal.ThrowExceptionForHR(shown);
            dialog.GetResult(out result);
            IntPtr path;
            result.GetDisplayName(0x80058000u, out path); // SIGDN_FILESYSPATH
            try { return Marshal.PtrToStringUni(path); }
            finally { Marshal.FreeCoTaskMem(path); }
        }
        finally
        {
            if (focusTimer != null) { focusTimer.Stop(); focusTimer.Dispose(); }
            if (result != null && Marshal.IsComObject(result)) Marshal.ReleaseComObject(result);
            if (instance != null && Marshal.IsComObject(instance)) Marshal.FinalReleaseComObject(instance);
            if (previousDpi != IntPtr.Zero) SetThreadDpiAwarenessContext(previousDpi);
            CoUninitialize();
        }
    }

    [DllImport("ole32.dll")] private static extern int CoInitializeEx(IntPtr reserved, uint coInit);
    [DllImport("ole32.dll")] private static extern void CoUninitialize();
    [DllImport("user32.dll")] private static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
    [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool IsWindow(IntPtr window);
    [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool IsWindowVisible(IntPtr window);

    [ComImport, Guid("42F85136-DB7E-439C-85F1-E4075D135FC8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface ExportFileDialog
    {
        [PreserveSig] int Show(IntPtr owner);
        void SetFileTypes(uint count, IntPtr filters);
        void SetFileTypeIndex(uint index);
        void GetFileTypeIndex(out uint index);
        void Advise(IntPtr events, out uint cookie);
        void Unadvise(uint cookie);
        void SetOptions(uint options);
        void GetOptions(out uint options);
        void SetDefaultFolder(ExportShellItem folder);
        void SetFolder(ExportShellItem folder);
        void GetFolder(out ExportShellItem folder);
        void GetCurrentSelection(out ExportShellItem item);
        void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string name);
        void GetFileName(out IntPtr name);
        void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string title);
        void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string label);
        void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string label);
        void GetResult(out ExportShellItem item);
        void AddPlace(ExportShellItem item, uint placement);
        void SetDefaultExtension([MarshalAs(UnmanagedType.LPWStr)] string extension);
        void Close(int result);
        void SetClientGuid(ref Guid guid);
        void ClearClientData();
        void SetFilter(IntPtr filter);
    }

    [ComImport, Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface ExportShellItem
    {
        void BindToHandler(IntPtr context, ref Guid handler, ref Guid iid, out IntPtr result);
        void GetParent(out ExportShellItem parent);
        void GetDisplayName(uint displayName, out IntPtr name);
        void GetAttributes(uint mask, out uint attributes);
        void Compare(ExportShellItem other, uint hint, out int order);
    }

    [ComImport, Guid("00000114-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface ExportOleWindow
    {
        void GetWindow(out IntPtr window);
        void ContextSensitiveHelp([MarshalAs(UnmanagedType.Bool)] bool enter);
    }
}
