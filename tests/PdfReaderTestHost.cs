using System;
using System.IO;
using System.Net.Sockets;
using System.Reflection;
using System.Threading;

// Starts the real embedded-resource executable from an isolated test directory.
internal static class PdfReaderTestHost
{
    private static void Main(string[] args)
    {
        Type app = Assembly.LoadFrom(Path.GetFullPath(args[0])).GetType("MinerULibraryReview");
        MethodInfo main = app.GetMethod("Main", BindingFlags.Static | BindingFlags.NonPublic);
        Thread thread = new Thread(new ThreadStart(delegate { main.Invoke(null, new object[] { new string[] { "--no-browser" } }); }));
        thread.SetApartmentState(ApartmentState.STA); thread.Start();
        FieldInfo field = app.GetField("Listener", BindingFlags.Static | BindingFlags.NonPublic);
        for (int i = 0; i < 100; i++)
        {
            TcpListener listener = (TcpListener)field.GetValue(null);
            if (listener != null) try { Console.WriteLine("PDF_TEST_URL=http://" + listener.LocalEndpoint); break; } catch { }
            Thread.Sleep(100);
        }
        thread.Join();
    }
}
