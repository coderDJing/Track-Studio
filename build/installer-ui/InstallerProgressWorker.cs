using System;
using System.Globalization;
using System.IO;
using System.Threading;

namespace TrackStudioInstallerUi
{
  internal sealed partial class InstallerWindow
  {
    private Thread installationProgressWorker;
    private volatile bool installationProgressStopRequested;

    private void StartInstallationProgressWorker(string selectedPath)
    {
      if (options.EstimatedSizeKb <= 0) return;
      StopInstallationProgressWorker();
      string progressDirectory = selectedPath;
      if (options.IsUpdate)
      {
        string stagingDirectory = InstallerSession.Read(options.SessionFile, "rollback", "stagingLocation");
        if (!string.IsNullOrWhiteSpace(stagingDirectory)) progressDirectory = stagingDirectory;
      }

      installationProgressStopRequested = false;
      installationProgressWorker = new Thread(new ThreadStart(delegate
      {
        MonitorInstallationProgress(progressDirectory);
      })) { IsBackground = true };
      installationProgressWorker.Start();
    }

    private void StopInstallationProgressWorker()
    {
      installationProgressStopRequested = true;
      if (installationProgressWorker != null && installationProgressWorker.IsAlive)
        installationProgressWorker.Join(1500);
      installationProgressWorker = null;
    }

    private void MonitorInstallationProgress(string directory)
    {
      long estimatedBytes = options.EstimatedSizeKb * 1024;
      while (!installationProgressStopRequested && !installFinished)
      {
        string progressDirectory = InstallerSession.Read(
          options.SessionFile, "engine", "progressDirectory");
        if (string.IsNullOrWhiteSpace(progressDirectory)) progressDirectory = directory;
        long writtenBytes = GetDirectorySize(progressDirectory);
        int progress = estimatedBytes <= 0 ? 0
          : (int)Math.Min(99, Math.Max(0, writtenBytes * 100 / estimatedBytes));
        try
        {
          InstallerSession.Write(options.SessionFile, "engine", "progress",
            progress.ToString(CultureInfo.InvariantCulture));
        }
        catch (Exception) { }
        Thread.Sleep(350);
      }
    }

    private static long GetDirectorySize(string directory)
    {
      if (!Directory.Exists(directory)) return 0;
      long total = 0;
      try
      {
        foreach (string file in Directory.GetFiles(directory, "*", SearchOption.AllDirectories))
        {
          try { total += new FileInfo(file).Length; }
          catch (IOException) { }
          catch (UnauthorizedAccessException) { }
        }
      }
      catch (IOException) { }
      catch (UnauthorizedAccessException) { }
      return total;
    }
  }
}
