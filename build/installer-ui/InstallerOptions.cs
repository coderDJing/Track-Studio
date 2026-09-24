using System;
using System.Collections.Generic;
using System.Globalization;
using IOPath = System.IO.Path;

namespace TrackStudioInstallerUi
{
  internal sealed class InstallerOptions
  {
    internal string SessionFile = string.Empty;
    internal string InstallDirectory = string.Empty;
    internal string Version = string.Empty;
    internal string PreviewLanguage = string.Empty;
    internal string InstallRegistryKey = string.Empty;
    internal string UninstallRegistryKey = string.Empty;
    internal long EstimatedSizeKb;
    internal bool Preview;
    internal bool IsUpdate;
    internal bool IsUninstall;
    internal IntPtr EngineWindowHandle = IntPtr.Zero;

    internal static InstallerOptions Parse(string[] args)
    {
      InstallerOptions options = new InstallerOptions();
      Dictionary<string, string> values = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);

      for (int index = 0; index < args.Length; index++)
      {
        string key = args[index];
        if (string.Equals(key, "--preview", StringComparison.OrdinalIgnoreCase))
        {
          options.Preview = true;
          continue;
        }

        if (key.StartsWith("--", StringComparison.Ordinal) && index + 1 < args.Length)
        {
          values[key] = args[++index];
        }
      }

      string value;
      if (values.TryGetValue("--session-file", out value)) options.SessionFile = value;
      if (values.TryGetValue("--install-dir", out value)) options.InstallDirectory = value;
      if (values.TryGetValue("--version", out value)) options.Version = value;
      if (values.TryGetValue("--install-registry-key", out value)) options.InstallRegistryKey = value;
      if (values.TryGetValue("--uninstall-registry-key", out value))
        options.UninstallRegistryKey = value;
      if (values.TryGetValue("--estimated-size-kb", out value))
      {
        long estimatedSizeKb;
        if (long.TryParse(value, NumberStyles.Integer, CultureInfo.InvariantCulture, out estimatedSizeKb))
          options.EstimatedSizeKb = estimatedSizeKb;
      }
      if (values.TryGetValue("--mode", out value))
      {
        options.IsUpdate = string.Equals(value, "update", StringComparison.OrdinalIgnoreCase);
        options.IsUninstall = string.Equals(value, "uninstall", StringComparison.OrdinalIgnoreCase);
      }
      if (values.TryGetValue("--engine-window", out value))
        options.EngineWindowHandle = ParseWindowHandle(value);
      if (options.Preview && values.TryGetValue("--language", out value))
        options.PreviewLanguage = value;

      if (string.IsNullOrWhiteSpace(options.InstallDirectory))
      {
        options.InstallDirectory = IOPath.Combine(
          Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles),
          "Track Studio"
        );
      }

      return options;
    }

    private static IntPtr ParseWindowHandle(string value)
    {
      long handle;
      if (value.StartsWith("0x", StringComparison.OrdinalIgnoreCase))
      {
        return long.TryParse(
          value.Substring(2), NumberStyles.HexNumber, CultureInfo.InvariantCulture, out handle
        ) ? new IntPtr(handle) : IntPtr.Zero;
      }

      return long.TryParse(value, NumberStyles.Integer, CultureInfo.InvariantCulture, out handle)
        ? new IntPtr(handle)
        : IntPtr.Zero;
    }
  }
}
