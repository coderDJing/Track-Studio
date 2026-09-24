using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Threading;

namespace TrackStudioInstallerUi
{
  internal sealed class InstallerEngineLifetime
  {
    private readonly Process engine;
    private readonly IntPtr windowHandle;
    private volatile bool stopRequested;

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr windowHandle, out uint processId);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool PostMessage(IntPtr windowHandle, uint message, IntPtr wordParameter,
      IntPtr longParameter);

    private InstallerEngineLifetime(Process engine, IntPtr windowHandle)
    {
      this.engine = engine;
      this.windowHandle = windowHandle;
    }

    internal static InstallerEngineLifetime Attach(IntPtr windowHandle)
    {
      if (windowHandle == IntPtr.Zero) return null;

      uint processId;
      GetWindowThreadProcessId(windowHandle, out processId);
      if (processId == 0) return null;

      try
      {
        Process engine = Process.GetProcessById((int)processId);
        if (engine.HasExited)
        {
          engine.Dispose();
          return null;
        }
        return new InstallerEngineLifetime(engine, windowHandle);
      }
      catch (ArgumentException)
      {
        return null;
      }
      catch (InvalidOperationException)
      {
        return null;
      }
      catch (Win32Exception)
      {
        return null;
      }
    }

    internal void WatchParentExit()
    {
      Thread watcher = new Thread(delegate()
      {
        try
        {
          engine.WaitForExit();
        }
        catch (InvalidOperationException)
        {
          // The parent is already gone; the frontend must not remain open.
        }
        catch (Win32Exception)
        {
          // The parent handle became unavailable; the frontend must not remain open.
        }
        if (!stopRequested)
        {
          Environment.Exit(0);
        }
      });
      watcher.IsBackground = true;
      watcher.Name = "Track Studio installer parent watcher";
      watcher.Start();
    }

    internal bool Stop()
    {
      try
      {
        stopRequested = true;
        if (engine.HasExited) return true;
        PostMessage(windowHandle, 0x0010, IntPtr.Zero, IntPtr.Zero);
        if (!engine.WaitForExit(1200))
        {
          engine.Kill();
          engine.WaitForExit(5000);
        }
        return engine.HasExited;
      }
      catch (InvalidOperationException)
      {
        return true;
      }
      catch (Win32Exception)
      {
        return false;
      }
    }
  }
}
