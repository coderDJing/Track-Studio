using System;
using System.Windows;

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
        InstallerText.SetPreviewLanguage(options.PreviewLanguage);
        if (!options.Preview && string.IsNullOrWhiteSpace(options.SessionFile))
        {
          return 2;
        }

        Application application = new Application
        {
          ShutdownMode = ShutdownMode.OnMainWindowClose
        };
        application.Run(new InstallerWindow(options));
        return 0;
      }
      catch (Exception)
      {
        return 1;
      }
    }
  }
}
