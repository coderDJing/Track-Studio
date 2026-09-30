using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

namespace TrackStudioInstallerUi
{
  internal sealed class InstallerEngineDialogMonitor
  {
    private const uint WmGetText = 0x000D;
    private const uint SmtoAbortIfHung = 0x0002;
    private readonly HashSet<string> recorded = new HashSet<string>(StringComparer.Ordinal);

    private delegate bool WindowCallback(IntPtr windowHandle, IntPtr parameter);

    [DllImport("user32.dll")]
    private static extern bool EnumWindows(WindowCallback callback, IntPtr parameter);

    [DllImport("user32.dll")]
    private static extern bool EnumChildWindows(IntPtr parent, WindowCallback callback, IntPtr parameter);

    [DllImport("user32.dll")]
    private static extern bool IsWindowVisible(IntPtr windowHandle);

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr windowHandle, out uint processId);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetClassName(IntPtr windowHandle, StringBuilder className, int capacity);

    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr SendMessageTimeout(IntPtr windowHandle, uint message,
      IntPtr capacity, StringBuilder text, uint flags, uint timeout, out IntPtr result);

    internal void Capture(int engineProcessId, IntPtr engineWindowHandle)
    {
      if (recorded.Count >= 12) return;
      EnumWindows(delegate(IntPtr windowHandle, IntPtr parameter)
      {
        uint processId;
        GetWindowThreadProcessId(windowHandle, out processId);
        if (windowHandle == engineWindowHandle || processId != (uint)engineProcessId ||
            !IsWindowVisible(windowHandle) ||
            !string.Equals(ClassName(windowHandle), "#32770", StringComparison.Ordinal)) return true;

        List<string> parts = new List<string>();
        AddText(parts, windowHandle);
        EnumChildWindows(windowHandle, delegate(IntPtr child, IntPtr unused)
        {
          if (parts.Count < 16 && string.Equals(ClassName(child), "Static", StringComparison.Ordinal))
            AddText(parts, child);
          return true;
        }, IntPtr.Zero);
        if (parts.Count < 2) return true;

        string description = string.Join(" | ", parts.ToArray());
        if (description.Length > 1600) description = description.Substring(0, 1600);
        if (recorded.Add(description))
          InstallerDiagnosticLog.Write("native engine dialog " + description);
        return recorded.Count < 12;
      }, IntPtr.Zero);
    }

    private static string ClassName(IntPtr windowHandle)
    {
      StringBuilder name = new StringBuilder(64);
      GetClassName(windowHandle, name, name.Capacity);
      return name.ToString();
    }

    private static void AddText(List<string> parts, IntPtr windowHandle)
    {
      StringBuilder text = new StringBuilder(2048);
      IntPtr result;
      if (SendMessageTimeout(windowHandle, WmGetText, new IntPtr(text.Capacity), text,
          SmtoAbortIfHung, 80, out result) == IntPtr.Zero) return;
      string value = text.ToString().Trim();
      if (!string.IsNullOrWhiteSpace(value) && !parts.Contains(value)) parts.Add(value);
    }
  }
}
