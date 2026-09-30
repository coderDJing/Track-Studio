using System;
using System.IO;
using System.Text;

namespace TrackStudioInstallerUi
{
  internal static class InstallerDiagnosticLog
  {
    private static readonly object Sync = new object();
    private static string version = "unknown";

    internal static void SetVersion(string value)
    {
      if (!string.IsNullOrWhiteSpace(value)) version = value.Trim();
    }

    internal static void Write(string message)
    {
      try
      {
        string directory = Path.Combine(
          Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData),
          "Track Studio");
        Directory.CreateDirectory(directory);
        string line = DateTimeOffset.Now.ToString("o") + " [v" + version + "] [frontend] " +
          message + Environment.NewLine;
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
