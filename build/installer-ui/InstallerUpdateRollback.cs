using System;
using System.IO;
using Microsoft.Win32;

namespace TrackStudioInstallerUi
{
  internal sealed class InstallerUpdateRollback
  {
    private readonly InstallerOptions options;
    private readonly string installLocation;
    private readonly string stagingLocation;
    private readonly string backupLocation;
    private readonly string uninstallString;
    private readonly string quietUninstallString;
    private readonly string displayVersion;
    private readonly string displayIcon;

    private InstallerUpdateRollback(InstallerOptions options)
    {
      this.options = options;
      installLocation = Read("installLocation");
      stagingLocation = Read("stagingLocation");
      backupLocation = Read("backupLocation");
      uninstallString = Read("uninstallString");
      quietUninstallString = Read("quietUninstallString");
      displayVersion = Read("displayVersion");
      displayIcon = Read("displayIcon");
    }

    internal static InstallerUpdateRollback Capture(InstallerOptions options)
    {
      InstallerUpdateRollback snapshot = new InstallerUpdateRollback(options);
      InstallerDiagnosticLog.Write("rollback snapshot path=" + snapshot.installLocation +
        " uninstallRegistered=" + !string.IsNullOrWhiteSpace(snapshot.uninstallString));
      return snapshot;
    }

    private string Read(string key)
    {
      return InstallerSession.Read(options.SessionFile, "rollback", key);
    }

    internal bool RestoreFiles()
    {
      if (string.IsNullOrWhiteSpace(installLocation)) return false;
      try
      {
        bool hasBackup = !string.IsNullOrWhiteSpace(backupLocation) && Directory.Exists(backupLocation);
        if (hasBackup)
        {
          if (Directory.Exists(installLocation)) Directory.Delete(installLocation, true);
          Directory.Move(backupLocation, installLocation);
        }
        if (!string.IsNullOrWhiteSpace(stagingLocation) && Directory.Exists(stagingLocation))
        {
          Directory.Delete(stagingLocation, true);
        }
        return Directory.Exists(installLocation);
      }
      catch (Exception exception)
      {
        InstallerDiagnosticLog.Write("rollback files failed " + exception);
        return false;
      }
    }

    internal bool RestoreRegistration()
    {
      if (string.IsNullOrWhiteSpace(installLocation) ||
          string.IsNullOrWhiteSpace(uninstallString) ||
          string.IsNullOrWhiteSpace(options.InstallRegistryKey) ||
          string.IsNullOrWhiteSpace(options.UninstallRegistryKey)) return false;
      try
      {
        using (RegistryKey installKey = Registry.LocalMachine.CreateSubKey(options.InstallRegistryKey))
        {
          if (installKey == null) return false;
          installKey.SetValue("InstallLocation", installLocation, RegistryValueKind.String);
        }
        using (RegistryKey uninstallKey = Registry.LocalMachine.CreateSubKey(options.UninstallRegistryKey))
        {
          if (uninstallKey == null) return false;
          uninstallKey.SetValue("UninstallString", uninstallString, RegistryValueKind.String);
          uninstallKey.SetValue("QuietUninstallString", quietUninstallString, RegistryValueKind.String);
          if (!string.IsNullOrWhiteSpace(displayVersion))
            uninstallKey.SetValue("DisplayVersion", displayVersion, RegistryValueKind.String);
          if (!string.IsNullOrWhiteSpace(displayIcon))
            uninstallKey.SetValue("DisplayIcon", displayIcon, RegistryValueKind.String);
        }
        return true;
      }
      catch (Exception exception)
      {
        InstallerDiagnosticLog.Write("rollback registration failed " + exception);
        return false;
      }
    }
  }
}
