using System;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Shapes;

namespace TrackStudioInstallerUi
{
  internal static class InstallerUninstallView
  {
    private static string T(string chinese, string english) { return InstallerText.Get(chinese, english); }

    private static readonly Color WeakTextColor = Color.FromRgb(168, 171, 178);
    private static readonly Color BorderColor = Color.FromRgb(59, 59, 59);
    private static readonly Color AccentColor = Color.FromRgb(0, 120, 212);
    private static readonly Color DangerColor = Color.FromRgb(178, 57, 52);

    internal static UIElement CreateReady(
      string version,
      Action uninstall,
      Action cancel,
      out TextBlock inlineMessage
    )
    {
      StackPanel content = new StackPanel();
      content.Children.Add(CreateEyebrow(T("WINDOWS 卸载程序", "WINDOWS UNINSTALLER")));
      content.Children.Add(new TextBlock
      {
        Text = T("卸载 Track Studio", "Uninstall Track Studio"),
        Foreground = Brushes.White,
        FontSize = 30,
        FontWeight = FontWeights.SemiBold,
        Margin = new Thickness(0, 12, 0, 0)
      });
      content.Children.Add(new TextBlock
      {
        Text = T("从这台电脑移除 Track Studio。", "Remove Track Studio from this computer."),
        Foreground = new SolidColorBrush(WeakTextColor),
        FontSize = 13,
        Margin = new Thickness(0, 9, 0, 0)
      });
      inlineMessage = new TextBlock
      {
        Foreground = new SolidColorBrush(Color.FromRgb(232, 121, 111)),
        FontSize = 11,
        Height = 22,
        Margin = new Thickness(0, 32, 0, 0)
      };
      content.Children.Add(inlineMessage);

      StackPanel actions = new StackPanel
      {
        Orientation = Orientation.Horizontal,
        Margin = new Thickness(0, 10, 0, 0)
      };
      actions.Children.Add(CreateButton(T("确认卸载", "Uninstall"), true, uninstall));
      Border cancelButton = CreateButton(T("取消", "Cancel"), false, cancel);
      cancelButton.Margin = new Thickness(10, 0, 0, 0);
      actions.Children.Add(cancelButton);
      content.Children.Add(actions);

      content.Children.Add(new TextBlock
      {
        Text = string.IsNullOrWhiteSpace(version)
          ? T("WINDOWS 10 / 11  ·  64 位", "WINDOWS 10 / 11  ·  64-BIT")
          : T("版本 ", "VERSION ") + version + T("  ·  WINDOWS 10 / 11  ·  64 位",
            "  ·  WINDOWS 10 / 11  ·  64-BIT"),
        Foreground = new SolidColorBrush(Color.FromRgb(105, 108, 115)),
        FontSize = 9,
        Margin = new Thickness(0, 28, 0, 0)
      });
      return content;
    }

    internal static UIElement CreateComplete(Action finish)
    {
      StackPanel content = new StackPanel { VerticalAlignment = VerticalAlignment.Center };
      Grid successMark = new Grid
      {
        Width = 54,
        Height = 54,
        HorizontalAlignment = HorizontalAlignment.Left
      };
      successMark.Children.Add(new Ellipse
      {
        Fill = new SolidColorBrush(Color.FromArgb(35, 0, 120, 212)),
        Stroke = new SolidColorBrush(AccentColor),
        StrokeThickness = 1
      });
      successMark.Children.Add(new TextBlock
      {
        Text = "✓",
        Foreground = new SolidColorBrush(Color.FromRgb(110, 191, 246)),
        FontFamily = new FontFamily("Segoe UI Symbol"),
        FontSize = 29,
        FontWeight = FontWeights.SemiBold,
        HorizontalAlignment = HorizontalAlignment.Center,
        VerticalAlignment = VerticalAlignment.Center,
        Margin = new Thickness(0, -3, 0, 0)
      });
      content.Children.Add(successMark);
      content.Children.Add(new TextBlock
      {
        Text = T("Track Studio 已卸载", "Track Studio has been uninstalled"),
        Foreground = Brushes.White,
        FontSize = 28,
        FontWeight = FontWeights.SemiBold,
        Margin = new Thickness(0, 22, 0, 0)
      });
      content.Children.Add(new TextBlock
      {
        Text = T("应用程序已从这台电脑移除。", "The application has been removed from this computer."),
        Foreground = new SolidColorBrush(WeakTextColor),
        FontSize = 13,
        Margin = new Thickness(0, 9, 0, 0)
      });
      Border finishButton = CreateButton(T("完成", "Finish"), false, finish);
      finishButton.Width = 124;
      finishButton.Margin = new Thickness(0, 30, 0, 0);
      content.Children.Add(finishButton);
      return content;
    }

    private static TextBlock CreateEyebrow(string text)
    {
      return new TextBlock
      {
        Text = text,
        Foreground = new SolidColorBrush(Color.FromRgb(96, 174, 229)),
        FontSize = 10,
        FontWeight = FontWeights.SemiBold
      };
    }

    private static Border CreateButton(string label, bool destructive, Action action)
    {
      Color normal = destructive ? DangerColor : Color.FromRgb(31, 31, 31);
      Color hover = destructive ? Color.FromRgb(198, 68, 62) : Color.FromRgb(42, 42, 42);
      Border button = new Border
      {
        Width = destructive ? 142 : 112,
        Height = 42,
        Background = new SolidColorBrush(normal),
        BorderBrush = new SolidColorBrush(destructive ? DangerColor : BorderColor),
        BorderThickness = new Thickness(1),
        CornerRadius = new CornerRadius(4),
        Cursor = Cursors.Hand,
        Child = new TextBlock
        {
          Text = label,
          Foreground = Brushes.White,
          FontSize = 12,
          FontWeight = FontWeights.SemiBold,
          HorizontalAlignment = HorizontalAlignment.Center,
          VerticalAlignment = VerticalAlignment.Center
        }
      };
      button.MouseEnter += delegate { button.Background = new SolidColorBrush(hover); };
      button.MouseLeave += delegate { button.Background = new SolidColorBrush(normal); };
      button.MouseLeftButtonUp += delegate { action(); };
      return button;
    }
  }
}
