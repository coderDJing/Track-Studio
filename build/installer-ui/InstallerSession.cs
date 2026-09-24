using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

namespace TrackStudioInstallerUi
{
  internal static class InstallerSession
  {
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool WritePrivateProfileString(
      string section,
      string key,
      string value,
      string filePath
    );

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    private static extern uint GetPrivateProfileString(
      string section,
      string key,
      string defaultValue,
      StringBuilder result,
      uint size,
      string filePath
    );

    internal static void Write(string filePath, string section, string key, string value)
    {
      if (string.IsNullOrWhiteSpace(filePath))
      {
        return;
      }

      if (!WritePrivateProfileString(section, key, value, filePath))
      {
        throw new InvalidOperationException(InstallerText.Get(
          "无法写入安装会话。请重新运行安装程序。",
          "The installer session could not be saved. Run the installer again."
        ));
      }
    }

    internal static string Read(string filePath, string section, string key)
    {
      if (string.IsNullOrWhiteSpace(filePath) || !File.Exists(filePath))
      {
        return string.Empty;
      }

      StringBuilder value = new StringBuilder(4096);
      GetPrivateProfileString(section, key, string.Empty, value, (uint)value.Capacity, filePath);
      return value.ToString();
    }
  }
}
