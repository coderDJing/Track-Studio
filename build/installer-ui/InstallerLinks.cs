using System;
using System.Diagnostics;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Documents;
using System.Windows.Media;

namespace TrackStudioInstallerUi
{
  internal static class InstallerLinks
  {
    private const string GitHubUrl = "https://github.com/coderDJing/Track-Studio";
    private const string WebsiteUrl = "https://coderDJing.github.io/Track-Studio/";
    private const string EnglishWebsiteUrl = "https://coderDJing.github.io/Track-Studio/en/";

    internal static UIElement Create()
    {
      TextBlock footer = new TextBlock
      {
        FontSize = 11,
        HorizontalAlignment = HorizontalAlignment.Right,
        VerticalAlignment = VerticalAlignment.Bottom,
        Margin = new Thickness(0, 0, 52, 19)
      };
      footer.Inlines.Add(CreateLink("GitHub", GitHubUrl));
      footer.Inlines.Add(new Run("  ·  ")
      {
        Foreground = new SolidColorBrush(Color.FromRgb(105, 108, 115))
      });
      footer.Inlines.Add(CreateLink(
        InstallerText.Get("官网", "Website"),
        InstallerText.Get(WebsiteUrl, EnglishWebsiteUrl)
      ));
      return footer;
    }

    private static Hyperlink CreateLink(string label, string url)
    {
      Hyperlink link = new Hyperlink(new Run(label))
      {
        NavigateUri = new Uri(url),
        Foreground = new SolidColorBrush(Color.FromRgb(96, 174, 229)),
        TextDecorations = null
      };
      link.MouseEnter += delegate { link.TextDecorations = TextDecorations.Underline; };
      link.MouseLeave += delegate { link.TextDecorations = null; };
      link.Click += delegate(object sender, RoutedEventArgs eventArgs)
      {
        eventArgs.Handled = true;
        try
        {
          Process.Start(new ProcessStartInfo(url) { UseShellExecute = true });
        }
        catch (Exception)
        {
          MessageBox.Show(
            InstallerText.Get("无法打开链接，请检查默认浏览器设置。",
              "Could not open the link. Check your default browser settings."),
            InstallerText.Get("打开链接失败", "Could not open link"),
            MessageBoxButton.OK,
            MessageBoxImage.Warning
          );
        }
      };
      return link;
    }
  }
}
