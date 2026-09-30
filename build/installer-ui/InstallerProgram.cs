using System;
using System.Windows;
using System.Windows.Threading;

namespace TrackStudioInstallerUi
{
  internal static class Program
  {
    [STAThread]
    private static int Main(string[] args)
    {
      try
      {
        InstallerOptions options = InstallerOptions.Parse(args);
        InstallerDiagnosticLog.SetVersion(options.Version);
        InstallerDiagnosticLog.Write("start mode=" +
          (options.IsUpdate ? "update" : options.IsUninstall ? "uninstall" : "install") +
          " preview=" + options.Preview);
        InstallerText.SetPreviewLanguage(options.PreviewLanguage);
        if (!options.Preview && string.IsNullOrWhiteSpace(options.SessionFile))
        {
          return 2;
        }

        Application application = new Application
        {
          ShutdownMode = ShutdownMode.OnMainWindowClose
        };
        application.DispatcherUnhandledException += delegate(object sender,
          DispatcherUnhandledExceptionEventArgs eventArgs)
        {
          InstallerDiagnosticLog.Write("dispatcher exception " + eventArgs.Exception);
        };
        AppDomain.CurrentDomain.UnhandledException += delegate(object sender,
          UnhandledExceptionEventArgs eventArgs)
        {
          InstallerDiagnosticLog.Write("unhandled exception " + eventArgs.ExceptionObject);
        };
        application.Run(new InstallerWindow(options));
        return 0;
      }
      catch (Exception exception)
      {
        InstallerDiagnosticLog.Write("fatal " + exception);
        return 1;
      }
    }
  }
}
