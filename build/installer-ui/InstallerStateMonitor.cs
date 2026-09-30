using System;
using System.Globalization;
using System.IO;

namespace TrackStudioInstallerUi
{
  internal sealed partial class InstallerWindow
  {
    private void HandleUnexpectedEngineExit(int exitCode)
    {
      RecordExtractionSnapshot();
      if (!options.IsUpdate || updateRollback == null) return;
      bool filesRestored = updateRollback.RestoreFiles();
      bool registrationRestored = updateRollback.RestoreRegistration();
      InstallerDiagnosticLog.Write("unexpected exit rollback code=" + exitCode +
        " files=" + filesRestored + " registration=" + registrationRestored);
    }

    private void RecordExtractionSnapshot()
    {
      try
      {
        string sessionDirectory = Path.GetDirectoryName(options.SessionFile);
        if (string.IsNullOrWhiteSpace(sessionDirectory)) return;
        string archivePath = Path.Combine(sessionDirectory, "app-64.7z");
        string outputDirectory = Path.Combine(sessionDirectory, "7z-out");
        long archiveBytes = File.Exists(archivePath) ? new FileInfo(archivePath).Length : -1;
        int fileCount = 0;
        long extractedBytes = 0;
        DateTime latestCreation = DateTime.MinValue;
        string latestFile = string.Empty;
        bool truncated = false;
        if (Directory.Exists(outputDirectory))
        {
          foreach (string filePath in Directory.EnumerateFiles(
            outputDirectory, "*", SearchOption.AllDirectories))
          {
            if (fileCount >= 20000) { truncated = true; break; }
            FileInfo file = new FileInfo(filePath);
            fileCount++;
            extractedBytes += file.Length;
            if (file.CreationTimeUtc > latestCreation)
            {
              latestCreation = file.CreationTimeUtc;
              latestFile = filePath.Substring(outputDirectory.Length).TrimStart(Path.DirectorySeparatorChar);
            }
          }
        }
        InstallerDiagnosticLog.Write("extraction snapshot archiveBytes=" + archiveBytes +
          " outputExists=" + Directory.Exists(outputDirectory) + " files=" + fileCount +
          " bytes=" + extractedBytes + " latestCreatedFile=" + latestFile +
          " latestCreatedUtc=" + (latestCreation == DateTime.MinValue ? "unknown" :
            latestCreation.ToString("o")) + " truncated=" + truncated);
      }
      catch (Exception exception)
      {
        InstallerDiagnosticLog.Write("extraction snapshot failed " + exception);
      }
    }

    private void StateTimerTick(object sender, EventArgs eventArgs)
    {
      if (installStarted && !installFinished && engineLifetime != null)
        engineDialogMonitor.Capture(engineLifetime.ProcessId, options.EngineWindowHandle);

      if (!File.Exists(options.SessionFile))
      {
        missingSessionTicks++;
        if (missingSessionTicks >= 8)
        {
          InstallerDiagnosticLog.Write("session file disappeared while installing");
          allowWindowClose = true;
          Close();
        }
        return;
      }

      missingSessionTicks = 0;
      string state = InstallerSession.Read(options.SessionFile, "engine", "state");
      string progressValue = InstallerSession.Read(options.SessionFile, "engine", "progress");
      int progress;
      if (int.TryParse(progressValue, NumberStyles.Integer, CultureInfo.InvariantCulture, out progress))
      {
        SetInstallationProgress(progress);
      }
      if (!options.IsUninstall && installStarted && !installFinished)
      {
        int nativeProgress = ReadNativeEngineProgress();
        if (nativeProgress > progress) SetInstallationProgress(nativeProgress);
      }
      if (string.Equals(state, "success", StringComparison.OrdinalIgnoreCase))
      {
        if (!installFinished) InstallerDiagnosticLog.Write("engine reported success");
        if (engineLifetime != null) engineLifetime.Disarm();
        StopInstallationProgressWorker();
        SetInstallationProgress(100);
        if (options.IsUninstall) ShowUninstallCompleteView();
        else ShowCompleteView();
      }
      else if (string.Equals(state, "failed", StringComparison.OrdinalIgnoreCase))
      {
        if (!operationFailed) InstallerDiagnosticLog.Write("engine reported failure: " +
          InstallerSession.Read(options.SessionFile, "engine", "message"));
        ShowErrorView(InstallerSession.Read(options.SessionFile, "engine", "message"));
      }
    }
  }
}
