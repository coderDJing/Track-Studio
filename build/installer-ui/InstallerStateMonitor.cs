using System;
using System.Globalization;
using System.IO;

namespace TrackStudioInstallerUi
{
  internal sealed partial class InstallerWindow
  {
    private void StateTimerTick(object sender, EventArgs eventArgs)
    {
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
