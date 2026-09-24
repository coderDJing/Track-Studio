using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Controls.Primitives;
using System.Windows.Input;
using System.Windows.Interop;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using System.Windows.Shapes;
using System.Windows.Threading;
using System.Threading;
using Forms = System.Windows.Forms;
using IOPath = System.IO.Path;
using ShapePath = System.Windows.Shapes.Path;
namespace TrackStudioInstallerUi
{
  internal sealed partial class InstallerWindow : Window
  {
    private static string T(string chinese, string english) { return InstallerText.Get(chinese, english); }
    private static readonly Color WindowColor = Color.FromRgb(24, 24, 24);
    private static readonly Color SurfaceColor = Color.FromRgb(31, 31, 31);
    private static readonly Color WaveColor = Color.FromRgb(21, 21, 21);
    private static readonly Color BorderColor = Color.FromRgb(59, 59, 59);
    private static readonly Color TextColor = Color.FromRgb(204, 204, 204);
    private static readonly Color WeakTextColor = Color.FromRgb(168, 171, 178);
    private static readonly Color AccentColor = Color.FromRgb(0, 120, 212);
    private static readonly Color AccentHoverColor = Color.FromRgb(16, 132, 225);
    private readonly InstallerOptions options;
    private readonly Grid bodyHost;
    private readonly DispatcherTimer stateTimer;
    private readonly DispatcherTimer heartbeatTimer;
    private InstallerEngineLifetime engineLifetime;
    private TextBox installPathBox;
    private TextBlock inlineMessage;
    private Grid installationProgressTrack;
    private Border installationProgressBar;
    private TextBlock installationProgressLabel;
    private CheckBox launchAfterInstall;
    private bool installStarted;
    private bool installFinished;
    private bool operationFailed;
    private bool allowWindowClose;
    private bool finishSent;
    private bool installDirectoryExistedAtStart;
    private string activeInstallDirectory = string.Empty;
    private int missingSessionTicks;
    private Thread uninstallWorker;
    private volatile bool uninstallCancelRequested;
    private bool uninstallWorkerActive;
    [DllImport("dwmapi.dll")]
    private static extern int DwmSetWindowAttribute(IntPtr windowHandle, int attribute, ref int value,
      int valueSize);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool PostMessage(IntPtr windowHandle, uint message, IntPtr wordParameter,
      IntPtr longParameter);

    internal InstallerWindow(InstallerOptions options)
    {
      this.options = options;
      Title = options.IsUninstall
        ? T("Track Studio 卸载", "Track Studio Uninstall")
        : options.IsUpdate
          ? T("Track Studio 更新", "Track Studio Update")
          : T("Track Studio 安装", "Track Studio Setup");
      Width = 860;
      Height = 520;
      MinWidth = Width;
      MinHeight = Height;
      MaxWidth = Width;
      MaxHeight = Height;
      WindowStyle = WindowStyle.None;
      ResizeMode = ResizeMode.NoResize;
      AllowsTransparency = false;
      Background = new SolidColorBrush(WindowColor);
      WindowStartupLocation = WindowStartupLocation.CenterScreen;
      ShowInTaskbar = true;
      FontFamily = new FontFamily("Microsoft YaHei UI");
      UseLayoutRounding = true;
      SnapsToDevicePixels = true;
      Border frame = new Border();
      frame.Background = new SolidColorBrush(WindowColor);
      frame.BorderBrush = new SolidColorBrush(BorderColor);
      frame.BorderThickness = new Thickness(1);
      frame.CornerRadius = new CornerRadius(10);
      Grid root = new Grid();
      root.RowDefinitions.Add(new RowDefinition { Height = new GridLength(48) });
      root.RowDefinitions.Add(new RowDefinition { Height = new GridLength(1, GridUnitType.Star) });
      frame.Child = root;
      Content = frame;
      UIElement titleBar = CreateTitleBar();
      Grid.SetRow(titleBar, 0);
      root.Children.Add(titleBar);
      Grid body = new Grid();
      body.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(292) });
      body.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
      Grid.SetRow(body, 1);
      root.Children.Add(body);
      UIElement artwork = CreateArtworkPanel();
      Grid.SetColumn(artwork, 0);
      body.Children.Add(artwork);
      bodyHost = new Grid();
      bodyHost.Margin = new Thickness(52, 42, 52, 40);
      Grid.SetColumn(bodyHost, 1);
      body.Children.Add(bodyHost);
      UIElement links = InstallerLinks.Create();
      Grid.SetColumn(links, 1);
      body.Children.Add(links);

      stateTimer = new DispatcherTimer();
      stateTimer.Interval = TimeSpan.FromMilliseconds(240);
      stateTimer.Tick += StateTimerTick;
      heartbeatTimer = new DispatcherTimer { Interval = TimeSpan.FromSeconds(1) };
      heartbeatTimer.Tick += MarkFrontendAlive;
      Closing += WindowClosing;
      SourceInitialized += ApplyNativeWindowStyle;
      Loaded += FrontendLoaded;
      if (options.IsUninstall)
      {
        ShowUninstallReadyView();
      }
      else if (options.IsUpdate)
      {
        installStarted = true;
        ShowInstallingView();
        Loaded += BeginUpdateAfterWindowIsVisible;
      }
      else
      {
        ShowReadyView();
      }
      if (!options.Preview)
      {
        stateTimer.Start();
      }
    }

    private void FrontendLoaded(object sender, RoutedEventArgs eventArgs)
    {
      if (options.Preview) return;
      engineLifetime = InstallerEngineLifetime.Attach(options.EngineWindowHandle);
      if (engineLifetime == null)
      {
        allowWindowClose = true;
        Close();
        return;
      }
      engineLifetime.WatchParentExit();
      try
      {
        InstallerSession.Write(options.SessionFile, "frontend", "state", "ready");
        MarkFrontendAlive(sender, eventArgs);
        heartbeatTimer.Start();
      }
      catch (Exception exception)
      {
        ShowErrorView(exception.Message);
      }
    }

    private void MarkFrontendAlive(object sender, EventArgs eventArgs)
    {
      InstallerSession.Write(options.SessionFile, "frontend", "heartbeat",
        Environment.TickCount.ToString(CultureInfo.InvariantCulture));
    }

    private void ApplyNativeWindowStyle(object sender, EventArgs eventArgs)
    {
      IntPtr windowHandle = new WindowInteropHelper(this).Handle;
      int enabled = 1;
      int rounded = 2;
      DwmSetWindowAttribute(windowHandle, 20, ref enabled, sizeof(int));
      DwmSetWindowAttribute(windowHandle, 33, ref rounded, sizeof(int));
    }

    private UIElement CreateTitleBar()
    {
      Grid titleBar = new Grid();
      titleBar.Background = new SolidColorBrush(WindowColor);
      titleBar.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
      titleBar.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(48) });
      titleBar.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(48) });
      StackPanel identity = new StackPanel
      {
        Orientation = Orientation.Horizontal,
        VerticalAlignment = VerticalAlignment.Center,
        Margin = new Thickness(18, 0, 0, 0)
      };
      identity.Children.Add(new Image
      {
        Source = LoadProjectLogo(),
        Width = 30,
        Height = 30,
        Stretch = Stretch.Uniform,
        Margin = new Thickness(0, 0, 11, 0)
      });
      identity.Children.Add(new TextBlock
      {
        Text = "TRACK STUDIO",
        Foreground = new SolidColorBrush(TextColor),
        FontSize = 13,
        FontWeight = FontWeights.SemiBold,
        VerticalAlignment = VerticalAlignment.Center
      });
      Border dragRegion = new Border { Background = Brushes.Transparent, Child = identity };
      dragRegion.MouseLeftButtonDown += delegate
      {
        if (Mouse.LeftButton == MouseButtonState.Pressed)
        {
          DragMove();
        }
      };
      titleBar.Children.Add(dragRegion);

      Border minimize = CreateChromeButton(false);
      minimize.MouseLeftButtonUp += delegate { WindowState = WindowState.Minimized; };
      Grid.SetColumn(minimize, 1);
      titleBar.Children.Add(minimize);

      Border close = CreateChromeButton(true);
      close.MouseLeftButtonUp += delegate { RequestClose(); };
      Grid.SetColumn(close, 2);
      titleBar.Children.Add(close);
      return titleBar;
    }

    private static BitmapImage LoadProjectLogo()
    {
      using (Stream logoStream = Assembly.GetExecutingAssembly().GetManifestResourceStream("TrackStudioInstallerUi.logo.png"))
      {
        if (logoStream == null) throw new InvalidOperationException(T(
          "安装程序缺少 Track Studio 标志资源。", "The Track Studio logo is missing."));
        BitmapImage logo = new BitmapImage();
        logo.BeginInit();
        logo.CacheOption = BitmapCacheOption.OnLoad;
        logo.StreamSource = logoStream;
        logo.EndInit();
        logo.Freeze();
        return logo;
      }
    }
    private static Border CreateChromeButton(bool destructive)
    {
      Color hoverColor = destructive ? Color.FromRgb(196, 43, 28) : SurfaceColor;
      Border button = new Border { Background = Brushes.Transparent };
      ShapePath icon = new ShapePath
      {
        Data = Geometry.Parse(destructive ? "M 3,3 L 13,13 M 13,3 L 3,13" : "M 3,8 L 13,8"),
        Stroke = new SolidColorBrush(WeakTextColor),
        StrokeThickness = 1.6,
        StrokeStartLineCap = PenLineCap.Round,
        StrokeEndLineCap = PenLineCap.Round,
        StrokeLineJoin = PenLineJoin.Round,
        Width = 16,
        Height = 16,
        Stretch = Stretch.None,
        HorizontalAlignment = HorizontalAlignment.Center,
        VerticalAlignment = VerticalAlignment.Center
      };
      button.Child = icon;
      button.MouseEnter += delegate
      {
        button.Background = new SolidColorBrush(hoverColor);
        icon.Stroke = new SolidColorBrush(TextColor);
      };
      button.MouseLeave += delegate
      {
        button.Background = Brushes.Transparent;
        icon.Stroke = new SolidColorBrush(WeakTextColor);
      };
      return button;
    }

    private UIElement CreateArtworkPanel()
    {
      Grid panel = new Grid();
      panel.Background = new SolidColorBrush(WaveColor);
      panel.ClipToBounds = true;

      WaveformArtwork artwork = new WaveformArtwork { Opacity = 0.9 };
      panel.Children.Add(artwork);

      Rectangle tint = new Rectangle
      {
        Fill = new LinearGradientBrush(
          Color.FromArgb(12, 0, 120, 212),
          Color.FromArgb(104, 0, 0, 0),
          90
        )
      };
      panel.Children.Add(tint);

      StackPanel copy = new StackPanel
      {
        VerticalAlignment = VerticalAlignment.Bottom,
        Margin = new Thickness(28, 0, 28, 34)
      };
      Border pill = new Border
      {
        Background = new SolidColorBrush(Color.FromArgb(34, 0, 120, 212)),
        BorderBrush = new SolidColorBrush(Color.FromArgb(140, 0, 120, 212)),
        BorderThickness = new Thickness(1),
        CornerRadius = new CornerRadius(3),
        Padding = new Thickness(8, 4, 8, 4),
        HorizontalAlignment = HorizontalAlignment.Left,
        Child = new TextBlock
        {
          Text = T("快速音频工作流", "RAPID AUDIO WORKFLOW"),
          Foreground = new SolidColorBrush(Color.FromRgb(113, 188, 240)),
          FontSize = 9,
          FontWeight = FontWeights.SemiBold
        }
      };
      copy.Children.Add(pill);
      copy.Children.Add(new TextBlock
      {
        Text = T("让音乐库整理，\n更快进入节奏。", "Organize music.\nFind your flow."),
        Foreground = Brushes.White,
        FontSize = 22,
        FontWeight = FontWeights.SemiBold,
        LineHeight = 33,
        Margin = new Thickness(0, 14, 0, 0)
      });
      copy.Children.Add(new TextBlock
      {
        Text = T("分析、试听与编排，一站完成。", "Analyze, audition and arrange."),
        Foreground = new SolidColorBrush(WeakTextColor),
        FontSize = 12,
        Margin = new Thickness(0, 12, 0, 0)
      });
      panel.Children.Add(copy);
      return panel;
    }

    private void ShowReadyView()
    {
      bodyHost.Children.Clear();
      StackPanel content = new StackPanel();

      TextBlock eyebrow = CreateEyebrow(T("WINDOWS 安装程序", "WINDOWS INSTALLER"));
      content.Children.Add(eyebrow);
      content.Children.Add(new TextBlock
      {
        Text = T("安装 Track Studio", "Install Track Studio"),
        Foreground = Brushes.White,
        FontSize = 30,
        FontWeight = FontWeights.SemiBold,
        Margin = new Thickness(0, 12, 0, 0)
      });
      content.Children.Add(new TextBlock
      {
        Text = T("选择安装位置，然后开始。现有版本会安全升级。",
          "Choose where to install. An existing version will be upgraded safely."),
        Foreground = new SolidColorBrush(WeakTextColor),
        FontSize = 13,
        Margin = new Thickness(0, 9, 0, 0)
      });

      content.Children.Add(new TextBlock
      {
        Text = T("安装位置", "Install location"),
        Foreground = new SolidColorBrush(TextColor),
        FontSize = 12,
        Margin = new Thickness(0, 30, 0, 8)
      });

      Grid pathRow = new Grid();
      pathRow.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
      pathRow.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(88) });

      Border pathBorder = new Border
      {
        Background = new SolidColorBrush(WaveColor),
        BorderBrush = new SolidColorBrush(BorderColor),
        BorderThickness = new Thickness(1),
        CornerRadius = new CornerRadius(4),
        Height = 42
      };
      installPathBox = new TextBox
      {
        Text = options.InstallDirectory,
        Background = Brushes.Transparent,
        BorderThickness = new Thickness(0),
        Foreground = new SolidColorBrush(TextColor),
        CaretBrush = new SolidColorBrush(AccentColor),
        FontSize = 12,
        VerticalContentAlignment = VerticalAlignment.Center,
        Padding = new Thickness(12, 0, 8, 0)
      };
      pathBorder.Child = installPathBox;
      pathRow.Children.Add(pathBorder);

      Border browse = CreateButton(T("浏览", "Browse"), false, BrowseForFolder);
      browse.Margin = new Thickness(10, 0, 0, 0);
      Grid.SetColumn(browse, 1);
      pathRow.Children.Add(browse);
      content.Children.Add(pathRow);

      inlineMessage = new TextBlock
      {
        Foreground = new SolidColorBrush(Color.FromRgb(232, 121, 111)),
        FontSize = 11,
        Height = 22,
        Margin = new Thickness(0, 7, 0, 0)
      };
      content.Children.Add(inlineMessage);

      Border install = CreateButton(T("开始安装", "Install"), true, BeginInstall);
      install.Width = 142;
      install.HorizontalAlignment = HorizontalAlignment.Left;
      install.Margin = new Thickness(0, 16, 0, 0);
      content.Children.Add(install);

      string footer = string.IsNullOrWhiteSpace(options.Version)
        ? T("WINDOWS 10 / 11  ·  64 位", "WINDOWS 10 / 11  ·  64-BIT")
        : T("版本 ", "VERSION ") + options.Version + T("  ·  WINDOWS 10 / 11  ·  64 位",
          "  ·  WINDOWS 10 / 11  ·  64-BIT");
      content.Children.Add(new TextBlock
      {
        Text = footer,
        Foreground = new SolidColorBrush(Color.FromRgb(105, 108, 115)),
        FontSize = 9,
        Margin = new Thickness(0, 28, 0, 0)
      });

      bodyHost.Children.Add(content);
    }

    private void ShowUninstallReadyView()
    {
      bodyHost.Children.Clear();
      bodyHost.Children.Add(InstallerUninstallView.CreateReady(
        options.Version, BeginUninstall, RequestClose, out inlineMessage
      ));
    }

    private void ShowInstallingView()
    {
      bodyHost.Children.Clear();
      Grid content = new Grid();
      content.RowDefinitions.Add(new RowDefinition { Height = new GridLength(1, GridUnitType.Star) });
      content.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });

      StackPanel main = new StackPanel { VerticalAlignment = VerticalAlignment.Center };
      main.Children.Add(CreateEyebrow(options.IsUninstall ? T("正在卸载", "UNINSTALLING")
        : options.IsUpdate ? T("正在更新", "UPDATING") : T("正在安装", "INSTALLING")));
      main.Children.Add(new TextBlock
      {
        Text = options.IsUninstall
          ? T("正在卸载 Track Studio", "Uninstalling Track Studio")
          : options.IsUpdate
          ? T("正在更新 Track Studio", "Updating Track Studio")
          : T("正在准备你的工作台", "Preparing your workspace"),
        Foreground = Brushes.White,
        FontSize = 27,
        FontWeight = FontWeights.SemiBold,
        Margin = new Thickness(0, 13, 0, 0)
      });
      main.Children.Add(new TextBlock
      {
        Text = options.IsUninstall
          ? T("正在移除应用程序，请保持此窗口打开。",
              "Removing the application. Please keep this window open.")
          : options.IsUpdate
          ? T("正在安装新版本，完成后会自动重新启动。",
              "Installing the new version. Track Studio will restart when complete.")
          : T("正在安装 Track Studio，请保持此窗口打开。",
              "Installing Track Studio. Please keep this window open."),
        Foreground = new SolidColorBrush(WeakTextColor),
        FontSize = 13,
        Margin = new Thickness(0, 10, 0, 0)
      });

      installationProgressTrack = new Grid
      {
        Height = 4,
        Background = new SolidColorBrush(Color.FromRgb(47, 47, 47)),
        ClipToBounds = true,
        Margin = new Thickness(0, 32, 0, 0)
      };
      installationProgressBar = new Border
      {
        Width = 0,
        HorizontalAlignment = HorizontalAlignment.Left,
        Background = new SolidColorBrush(AccentColor),
        CornerRadius = new CornerRadius(2)
      };
      installationProgressTrack.Children.Add(installationProgressBar);
      main.Children.Add(installationProgressTrack);

      installationProgressLabel = new TextBlock
      {
        Text = options.IsUninstall
          ? T("正在准备卸载…", "Preparing uninstallation…")
          : options.IsUpdate
          ? T("正在准备更新…", "Preparing update…")
          : T("正在准备安装…", "Preparing installation…"),
        Foreground = new SolidColorBrush(WeakTextColor),
        FontSize = 11,
        Margin = new Thickness(0, 10, 0, 0)
      };
      main.Children.Add(installationProgressLabel);
      content.Children.Add(main);

      TextBlock hint = new TextBlock
      {
        Text = options.IsUninstall
          ? T("卸载过程中请保持此窗口打开", "Keep this window open during uninstallation")
          : options.IsUpdate
          ? T("更新过程中请保持此窗口打开", "Keep this window open during the update")
          : T("安装过程中无需进行其他操作", "No action is needed during installation"),
        Foreground = new SolidColorBrush(Color.FromRgb(105, 108, 115)),
        FontSize = 10,
        HorizontalAlignment = HorizontalAlignment.Left
      };
      Grid.SetRow(hint, 1);
      content.Children.Add(hint);
      bodyHost.Children.Add(content);
    }

    private void SetInstallationProgress(int progress)
    {
      if (installationProgressTrack == null || installationProgressBar == null ||
          installationProgressLabel == null)
      {
        return;
      }

      int clamped = Math.Max(0, Math.Min(100, progress));
      double trackWidth = installationProgressTrack.ActualWidth;
      installationProgressBar.Width = trackWidth > 0 ? trackWidth * clamped / 100 : 0;
       string chinesePrefix = options.IsUninstall ? "正在卸载 · "
         : options.IsUpdate ? "正在更新 · " : "正在安装 · ";
       string englishPrefix = options.IsUninstall ? "Uninstalling · "
         : options.IsUpdate ? "Updating · " : "Installing · ";
       installationProgressLabel.Text = T(chinesePrefix + clamped + "%",
         englishPrefix + clamped + "%");
    }

    private void ShowCompleteView()
    {
      if (installFinished)
      {
        return;
      }

      installFinished = true;
      stateTimer.Stop();
      bodyHost.Children.Clear();

      StackPanel content = new StackPanel { VerticalAlignment = VerticalAlignment.Center };
      Grid successMark = new Grid { Width = 54, Height = 54, HorizontalAlignment = HorizontalAlignment.Left };
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
        Text = options.IsUpdate
          ? T("Track Studio 已更新", "Track Studio is updated")
          : T("Track Studio 已安装", "Track Studio is installed"),
        Foreground = Brushes.White,
        FontSize = 28,
        FontWeight = FontWeights.SemiBold,
        Margin = new Thickness(0, 22, 0, 0)
      });
      content.Children.Add(new TextBlock
      {
        Text = options.IsUpdate
          ? T("新版本已经准备好，正在重新启动。",
              "The new version is ready. Track Studio is restarting.")
          : T("现在可以开始整理、分析和试听你的音乐库。",
              "You can now organize, analyze and audition your music library."),
        Foreground = new SolidColorBrush(WeakTextColor),
        FontSize = 13,
        Margin = new Thickness(0, 9, 0, 0)
      });

      if (options.IsUpdate)
      {
        content.Children.Add(new TextBlock
        {
          Text = T("正在重启 TRACK STUDIO…", "RESTARTING TRACK STUDIO…"),
          Foreground = new SolidColorBrush(Color.FromRgb(96, 174, 229)),
          FontSize = 10,
          FontWeight = FontWeights.SemiBold,
          Margin = new Thickness(0, 26, 0, 0)
        });
        bodyHost.Children.Add(content);

        DispatcherTimer restartTimer = new DispatcherTimer { Interval = TimeSpan.FromMilliseconds(900) };
        restartTimer.Tick += delegate
        {
          restartTimer.Stop();
          FinishUpdate();
        };
        restartTimer.Start();
        return;
      }

      launchAfterInstall = new CheckBox
      {
        Content = T("启动 Track Studio", "Launch Track Studio"),
        IsChecked = true,
        Foreground = new SolidColorBrush(TextColor),
        FontSize = 12,
        Margin = new Thickness(0, 26, 0, 0)
      };
      content.Children.Add(launchAfterInstall);

      Border finish = CreateButton(T("完成", "Finish"), true, FinishInstall);
      finish.Width = 124;
      finish.HorizontalAlignment = HorizontalAlignment.Left;
      finish.Margin = new Thickness(0, 24, 0, 0);
      content.Children.Add(finish);
      bodyHost.Children.Add(content);
    }

    private void ShowUninstallCompleteView()
    {
      if (installFinished) return;
      installFinished = true;
      stateTimer.Stop();
      bodyHost.Children.Clear();
      bodyHost.Children.Add(InstallerUninstallView.CreateComplete(FinishUninstall));
    }

    private void ShowErrorView(string message)
    {
      operationFailed = true;
      stateTimer.Stop();
      bodyHost.Children.Clear();
      StackPanel content = new StackPanel { VerticalAlignment = VerticalAlignment.Center };
      content.Children.Add(CreateEyebrow(options.IsUninstall
        ? T("卸载已停止", "UNINSTALLATION STOPPED")
        : T("安装已停止", "INSTALLATION STOPPED")));
      content.Children.Add(new TextBlock
      {
        Text = options.IsUninstall
          ? T("卸载未能完成", "Uninstallation could not finish")
          : T("安装未能完成", "Installation could not finish"),
        Foreground = Brushes.White,
        FontSize = 28,
        FontWeight = FontWeights.SemiBold,
        Margin = new Thickness(0, 13, 0, 0)
      });
      content.Children.Add(new TextBlock
      {
        Text = string.IsNullOrWhiteSpace(message)
          ? options.IsUninstall
            ? T("请关闭窗口后重新运行卸载程序。", "Close this window and run the uninstaller again.")
            : T("请关闭窗口后重新运行安装程序。", "Close this window and run the installer again.")
          : message,
        Foreground = new SolidColorBrush(WeakTextColor),
        FontSize = 13,
        TextWrapping = TextWrapping.Wrap,
        MaxWidth = 450,
        Margin = new Thickness(0, 10, 0, 0)
      });
      Border close = CreateButton(T("关闭", "Close"), false, RequestClose);
      close.Width = 112;
      close.HorizontalAlignment = HorizontalAlignment.Left;
      close.Margin = new Thickness(0, 26, 0, 0);
      content.Children.Add(close);
      bodyHost.Children.Add(content);
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

    private static Border CreateButton(string text, bool primary, Action action)
    {
      Color normal = primary ? AccentColor : SurfaceColor;
      Color hover = primary ? AccentHoverColor : Color.FromRgb(42, 42, 42);
      Border button = new Border
      {
        Height = 42,
        Background = new SolidColorBrush(normal),
        BorderBrush = primary ? new SolidColorBrush(AccentColor) : new SolidColorBrush(BorderColor),
        BorderThickness = new Thickness(1),
        CornerRadius = new CornerRadius(4),
        Cursor = Cursors.Hand,
        Child = new TextBlock
        {
          Text = text,
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

    private void BrowseForFolder()
    {
      using (Forms.FolderBrowserDialog dialog = new Forms.FolderBrowserDialog())
      {
        dialog.Description = T("选择 Track Studio 的安装位置", "Choose where to install Track Studio");
        dialog.SelectedPath = installPathBox.Text;
        dialog.ShowNewFolderButton = true;
        Forms.DialogResult result = dialog.ShowDialog();
        if (result == Forms.DialogResult.OK && !string.IsNullOrWhiteSpace(dialog.SelectedPath))
        {
          installPathBox.Text = dialog.SelectedPath;
          installPathBox.CaretIndex = installPathBox.Text.Length;
        }
      }
    }

    private void BeginInstall()
    {
      string selectedPath = installPathBox.Text.Trim();
      string validationMessage = ValidateInstallPath(selectedPath);
      if (!string.IsNullOrEmpty(validationMessage))
      {
        inlineMessage.Text = validationMessage;
        return;
      }

      if (IsTrackStudioRunning())
      {
        inlineMessage.Text = T("请先关闭正在运行的 Track Studio，再开始安装。",
          "Close Track Studio before starting the installation.");
        return;
      }

      inlineMessage.Text = string.Empty;
      StartInstallation(selectedPath);
    }

    private void BeginUninstall()
    {
      if (installStarted) return;
      if (IsTrackStudioRunning())
      {
        inlineMessage.Text = T("请先关闭正在运行的 Track Studio，再开始卸载。",
          "Close Track Studio before starting the uninstallation.");
        return;
      }

      installStarted = true;
      ShowInstallingView();
      if (options.Preview)
      {
        DispatcherTimer previewTimer = new DispatcherTimer { Interval = TimeSpan.FromSeconds(2.4) };
        previewTimer.Tick += delegate
        {
          previewTimer.Stop();
          ShowUninstallCompleteView();
        };
        previewTimer.Start();
        return;
      }

      StartUninstallWorker();
    }

    private void StartUninstallWorker()
    {
      uninstallCancelRequested = false;
      uninstallWorkerActive = true;
      InstallerSession.Write(options.SessionFile, "engine", "progress", "0");
      uninstallWorker = new Thread(RunUninstallWorker)
      {
        IsBackground = true
      };
      uninstallWorker.Start();
    }

    private void RunUninstallWorker()
    {
      string errorMessage = string.Empty;
      try
      {
        string installDirectory = options.InstallDirectory;
        if (!Directory.Exists(installDirectory))
        {
          throw new DirectoryNotFoundException(T("找不到 Track Studio 安装目录。",
            "The Track Studio installation directory could not be found."));
        }
        List<string> files = new List<string>(Directory.GetFiles(
          installDirectory, "*", SearchOption.AllDirectories));
        long totalBytes = 0;
        List<string> deletableFiles = new List<string>(files.Count);
        foreach (string file in files)
        {
          if (IsUninstallerFile(file)) continue;
          FileInfo info = new FileInfo(file);
          totalBytes += info.Length;
          deletableFiles.Add(file);
        }
        long deletedBytes = 0;
        WriteUninstallProgress(0);
        foreach (string file in deletableFiles)
        {
          if (uninstallCancelRequested) return;
          FileInfo info = new FileInfo(file);
          long fileSize = info.Exists ? info.Length : 0;
          File.Delete(file);
          deletedBytes += fileSize;
          int progress = totalBytes <= 0 ? 99 : (int)Math.Min(99, deletedBytes * 99 / totalBytes);
          WriteUninstallProgress(progress);
        }
        List<string> directories = new List<string>(Directory.GetDirectories(
          installDirectory, "*", SearchOption.AllDirectories));
        directories.Sort(delegate(string left, string right)
        {
          return right.Length.CompareTo(left.Length);
        });
        foreach (string directory in directories)
        {
          if (uninstallCancelRequested) return;
          try { Directory.Delete(directory, false); }
          catch (DirectoryNotFoundException) { }
        }
        WriteUninstallProgress(99);
      }
      catch (Exception exception)
      {
        errorMessage = exception.Message;
      }
      Dispatcher.BeginInvoke(new Action(delegate
      {
        uninstallWorkerActive = false;
        if (uninstallCancelRequested) return;
        if (!string.IsNullOrWhiteSpace(errorMessage))
        {
          ShowErrorView(errorMessage);
          return;
        }
        try
        {
          InstallerSession.Write(options.SessionFile, "frontend", "command", "uninstall");
          AdvanceEnginePage();
        }
        catch (Exception exception)
        {
          ShowErrorView(exception.Message);
        }
      }));
    }
    private void WriteUninstallProgress(int progress)
    {
      InstallerSession.Write(options.SessionFile, "engine", "progress", progress.ToString(
        CultureInfo.InvariantCulture));
    }

    private static bool IsUninstallerFile(string path)
    {
      string fileName = IOPath.GetFileName(path);
      return fileName.StartsWith("Uninstall ", StringComparison.OrdinalIgnoreCase);
    }

    private void BeginUpdateAfterWindowIsVisible(object sender, RoutedEventArgs eventArgs)
    {
      DispatcherTimer startTimer = new DispatcherTimer { Interval = TimeSpan.FromMilliseconds(450) };
      startTimer.Tick += delegate
      {
        startTimer.Stop();
        StartInstallation(options.InstallDirectory);
      };
      startTimer.Start();
    }

    private void StartInstallation(string selectedPath)
    {
      installStarted = true;
      activeInstallDirectory = selectedPath;
      installDirectoryExistedAtStart = Directory.Exists(selectedPath);
      ShowInstallingView();

      if (options.Preview)
      {
        DispatcherTimer previewTimer = new DispatcherTimer { Interval = TimeSpan.FromSeconds(2.4) };
        previewTimer.Tick += delegate
        {
          previewTimer.Stop();
          ShowCompleteView();
        };
        previewTimer.Start();
        return;
      }

      try
      {
        InstallerSession.Write(options.SessionFile, "frontend", "installPath", selectedPath);
        StartInstallationProgressWorker(selectedPath);
        InstallerSession.Write(options.SessionFile, "frontend", "command", "install");
        AdvanceEnginePage();
        stateTimer.Start();
      }
      catch (Exception exception)
      {
        ShowErrorView(exception.Message);
      }
    }

    private void FinishUpdate()
    {
      if (finishSent)
      {
        return;
      }

      finishSent = true;
      if (!options.Preview)
      {
        try
        {
          InstallerSession.Write(options.SessionFile, "frontend", "launch", "1");
          InstallerSession.Write(options.SessionFile, "frontend", "command", "finish");
          AdvanceEnginePage();
        }
        catch (Exception exception)
        {
          finishSent = false;
          ShowErrorView(exception.Message);
          return;
        }
      }

      allowWindowClose = true;
      Close();
    }

    private static string ValidateInstallPath(string path)
    {
      if (string.IsNullOrWhiteSpace(path))
      {
        return T("请选择安装位置。", "Choose an install location.");
      }

      try
      {
        if (!IOPath.IsPathRooted(path) || string.IsNullOrWhiteSpace(IOPath.GetPathRoot(path)))
        {
          return T("请输入完整的 Windows 路径。", "Enter a complete Windows path.");
        }

        if (path.IndexOfAny(IOPath.GetInvalidPathChars()) >= 0)
        {
          return T("安装路径包含无效字符。", "The install path contains invalid characters.");
        }
      }
      catch (Exception)
      {
        return T("安装路径无效，请重新选择。", "Choose a valid install path.");
      }

      return string.Empty;
    }

    private static bool IsTrackStudioRunning()
    {
      Process[] processes = Process.GetProcessesByName("FRKB");
      try
      {
        return processes.Length > 0;
      }
      finally
      {
        foreach (Process process in processes)
        {
          process.Dispose();
        }
      }
    }

    private void StateTimerTick(object sender, EventArgs eventArgs)
    {
      if (!File.Exists(options.SessionFile))
      {
        missingSessionTicks++;
        if (missingSessionTicks >= 8)
        {
          allowWindowClose = true;
          Close();
        }
        return;
      }

      missingSessionTicks = 0;
      string state = InstallerSession.Read(options.SessionFile, "engine", "state");
      string progressValue = InstallerSession.Read(options.SessionFile, "engine", "progress");
      int progress;
      if (int.TryParse(progressValue, NumberStyles.Integer, CultureInfo.InvariantCulture, out progress))
      {
        SetInstallationProgress(progress);
      }
      if (!options.IsUninstall && installStarted && !installFinished)
      {
        int nativeProgress = ReadNativeEngineProgress();
        if (nativeProgress > progress) SetInstallationProgress(nativeProgress);
      }
      if (string.Equals(state, "success", StringComparison.OrdinalIgnoreCase))
      {
        StopInstallationProgressWorker();
        SetInstallationProgress(100);
        if (options.IsUninstall) ShowUninstallCompleteView();
        else ShowCompleteView();
      }
      else if (string.Equals(state, "failed", StringComparison.OrdinalIgnoreCase))
      {
        ShowErrorView(InstallerSession.Read(options.SessionFile, "engine", "message"));
      }
    }


    private void FinishInstall()
    {
      bool shouldLaunch = launchAfterInstall != null && launchAfterInstall.IsChecked == true;
      if (!options.Preview)
      {
        try
        {
          InstallerSession.Write(options.SessionFile, "frontend", "launch", shouldLaunch ? "1" : "0");
          InstallerSession.Write(options.SessionFile, "frontend", "command", "finish");
          AdvanceEnginePage();
        }
        catch (Exception exception)
        {
          ShowErrorView(exception.Message);
          return;
        }
      }

      allowWindowClose = true;
      Close();
    }

    private void FinishUninstall()
    {
      if (!options.Preview)
      {
        try
        {
          InstallerSession.Write(options.SessionFile, "frontend", "command", "finish");
          AdvanceEnginePage();
        }
        catch (Exception exception)
        {
          ShowErrorView(exception.Message);
          return;
        }
      }
      allowWindowClose = true;
      Close();
    }

    private void AdvanceEnginePage()
    {
      if (options.EngineWindowHandle == IntPtr.Zero)
      {
        throw new InvalidOperationException(T("安装引擎窗口不可用。请重新运行安装程序。",
          "The installer engine window is unavailable. Run the installer again."));
      }

      if (!PostMessage(options.EngineWindowHandle, 0x0111, new IntPtr(1), IntPtr.Zero))
      {
        throw new InvalidOperationException(T("无法通知安装引擎继续。请重新运行安装程序。",
          "The installer engine could not continue. Run the installer again."));
      }
    }

  }

}
