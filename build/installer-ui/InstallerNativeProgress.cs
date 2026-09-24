using System;
using System.Runtime.InteropServices;

namespace TrackStudioInstallerUi
{
  internal sealed partial class InstallerWindow
  {
    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr GetDlgItem(IntPtr parentHandle, int controlId);

    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr FindWindowEx(IntPtr parentHandle, IntPtr childAfter,
      string className, string windowName);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr SendMessage(IntPtr windowHandle, uint message, IntPtr wordParameter,
      IntPtr longParameter);

    private int ReadNativeEngineProgress()
    {
      if (options.EngineWindowHandle == IntPtr.Zero) return 0;
      const uint ProgressBarGetPosition = 0x0408;
      IntPtr progressWindow = GetDlgItem(options.EngineWindowHandle, 1004);
      if (progressWindow == IntPtr.Zero)
      {
        progressWindow = FindWindowEx(options.EngineWindowHandle, IntPtr.Zero,
          "msctls_progress32", string.Empty);
      }
      if (progressWindow == IntPtr.Zero) return 0;
      long value = SendMessage(progressWindow, ProgressBarGetPosition, IntPtr.Zero, IntPtr.Zero).ToInt64();
      return value > 100 ? 100 : value < 0 ? 0 : (int)value;
    }
  }
}
