using System;
using System.ComponentModel;
using System.IO;
using Microsoft.Win32;
using System.Windows;

namespace TrackStudioInstallerUi
{
  internal sealed partial class InstallerWindow
  {
    private void RequestClose()
    {
      if (options.Preview)
      {
        allowWindowClose = true;
        Close();
        return;
      }

      if (installFinished && !operationFailed)
      {
        if (options.IsUpdate) FinishUpdate();
        else if (options.IsUninstall) FinishUninstall();
        else FinishInstall();
        return;
      }

      if (installStarted && !operationFailed)
      {
        string warning = options.IsUninstall
          ? InstallerText.Get("正在卸载。现在停止可能留下未完整移除的程序文件。确定关闭吗？",
              "Uninstallation is in progress. Stopping now may leave application files behind. Close anyway?")
          : options.IsUpdate
            ? InstallerText.Get("正在更新。现在停止可能留下不完整的版本。确定关闭吗？",
                "An update is in progress. Stopping now may leave an incomplete version. Close anyway?")
            : InstallerText.Get("正在安装。关闭后会清理已写入的临时文件。确定关闭吗？",
                "Installation is in progress. Closing will clean up the files already written. Close anyway?");
        if (MessageBox.Show(this, warning, "Track Studio", MessageBoxButton.YesNo,
            MessageBoxImage.Warning) != MessageBoxResult.Yes)
        {
          return;
        }
      }

      try
      {
        InstallerSession.Write(options.SessionFile, "frontend", "command", "cancel");
      }
      catch (Exception)
      {
        // Closing the engine is still required if the session file is unavailable.
      }

      if (options.IsUninstall && uninstallWorkerActive)
      {
        uninstallCancelRequested = true;
        if (uninstallWorker != null && uninstallWorker.IsAlive && !uninstallWorker.Join(5000))
        {
          MessageBox.Show(this, InstallerText.Get(
            "无法停止卸载清理任务，请稍后再试。",
            "The uninstall cleanup task could not be stopped. Try again shortly."
          ), "Track Studio", MessageBoxButton.OK, MessageBoxImage.Warning);
          return;
        }
        uninstallWorkerActive = false;
      }

      StopInstallationProgressWorker();

      if (engineLifetime != null && !engineLifetime.Stop())
      {
        MessageBox.Show(this, InstallerText.Get(
          "无法结束后台进程，请在任务管理器中结束当前安装或卸载程序。",
          "The background process could not be stopped. End the installer or uninstaller in Task Manager."
        ), "Track Studio", MessageBoxButton.OK, MessageBoxImage.Error);
        return;
      }

      if (options.IsUpdate && !RestoreUpdateFiles())
      {
        MessageBox.Show(this, InstallerText.Get(
          "更新已停止，但无法恢复旧版本文件。请不要启动应用或卸载程序，先重新运行更新。",
          "The update stopped, but the previous version files could not be restored. Do not start or uninstall the app; run the update again first."
        ), "Track Studio", MessageBoxButton.OK, MessageBoxImage.Warning);
      }

      if (options.IsUpdate && !RestoreUpdateRegistration())
      {
        MessageBox.Show(this, InstallerText.Get(
          "更新已停止，但无法恢复旧版本的安装登记。请不要启动卸载程序，先重新运行更新。",
          "The update stopped, but the previous installation registration could not be restored. Do not uninstall yet; run the update again first."
        ), "Track Studio", MessageBoxButton.OK, MessageBoxImage.Warning);
      }

      if (installStarted && !installFinished && !options.IsUpdate && !options.IsUninstall &&
          !installDirectoryExistedAtStart)
      {
        try
        {
          if (Directory.Exists(activeInstallDirectory))
          {
            Directory.Delete(activeInstallDirectory, true);
          }
        }
        catch (Exception)
        {
          MessageBox.Show(this, InstallerText.Get(
            "已停止安装，但未能清理全部临时文件。请稍后删除安装目录。",
            "Installation stopped, but some temporary files could not be removed. Delete the install folder later."
          ), "Track Studio", MessageBoxButton.OK, MessageBoxImage.Warning);
        }
      }

      allowWindowClose = true;
      Close();
    }

    private bool RestoreUpdateRegistration()
    {
      if (string.IsNullOrWhiteSpace(options.InstallRegistryKey) ||
          string.IsNullOrWhiteSpace(options.UninstallRegistryKey))
      {
        return true;
      }

      try
      {
        string installLocation = InstallerSession.Read(options.SessionFile, "rollback", "installLocation");
        string uninstallString = InstallerSession.Read(options.SessionFile, "rollback", "uninstallString");
        string quietUninstallString = InstallerSession.Read(
          options.SessionFile, "rollback", "quietUninstallString");
        if (string.IsNullOrWhiteSpace(installLocation) || string.IsNullOrWhiteSpace(uninstallString))
        {
          return true;
        }

        using (RegistryKey installKey = Registry.LocalMachine.CreateSubKey(options.InstallRegistryKey))
        {
          if (installKey != null)
          {
            installKey.SetValue("InstallLocation", installLocation, RegistryValueKind.String);
          }
        }
        using (RegistryKey uninstallKey = Registry.LocalMachine.CreateSubKey(options.UninstallRegistryKey))
        {
          if (uninstallKey != null)
          {
            uninstallKey.SetValue("UninstallString", uninstallString, RegistryValueKind.String);
            uninstallKey.SetValue("QuietUninstallString", quietUninstallString, RegistryValueKind.String);
          }
        }
        return true;
      }
      catch (Exception)
      {
        return false;
      }
    }

    private bool RestoreUpdateFiles()
    {
      try
      {
        string installLocation = InstallerSession.Read(options.SessionFile, "rollback", "installLocation");
        string stagingLocation = InstallerSession.Read(options.SessionFile, "rollback", "stagingLocation");
        string backupLocation = InstallerSession.Read(options.SessionFile, "rollback", "backupLocation");
        if (string.IsNullOrWhiteSpace(installLocation)) return true;

        bool hasBackup = !string.IsNullOrWhiteSpace(backupLocation) && Directory.Exists(backupLocation);
        bool hasOriginal = Directory.Exists(installLocation);
        if (hasBackup)
        {
          if (hasOriginal) Directory.Delete(installLocation, true);
          Directory.Move(backupLocation, installLocation);
        }

        if (!string.IsNullOrWhiteSpace(stagingLocation) && Directory.Exists(stagingLocation))
        {
          Directory.Delete(stagingLocation, true);
        }
        return true;
      }
      catch (Exception)
      {
        return false;
      }
    }

    private void WindowClosing(object sender, CancelEventArgs eventArgs)
    {
      if (!allowWindowClose)
      {
        eventArgs.Cancel = true;
        Dispatcher.BeginInvoke(new Action(RequestClose));
      }
    }
  }
}
