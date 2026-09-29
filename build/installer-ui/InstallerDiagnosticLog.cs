using System;
using System.IO;
using System.Text;

namespace TrackStudioInstallerUi
{
  internal static class InstallerDiagnosticLog
  {
    private static readonly object Sync = new object();

    internal static void Write(string message)
    {
      try
      {
        string directory = Path.Combine(
          Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData),
          "Track Studio");
        Directory.CreateDirectory(directory);
        string line = DateTimeOffset.Now.ToString("o") + " [frontend] " + message + Environment.NewLine;
        lock (Sync)
        {
          File.AppendAllText(Path.Combine(directory, "installer-ui.log"), line, Encoding.UTF8);
        }
      }
      catch (Exception)
      {
        // Diagnostics must never change installer behavior.
      }
    }
  }
}
