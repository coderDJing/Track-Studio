using System;
using System.Windows;
using System.Windows.Media;

namespace TrackStudioInstallerUi
{
  internal sealed class WaveformArtwork : FrameworkElement
  {
    private static readonly Color Accent = Color.FromRgb(0, 120, 212);

    protected override void OnRender(DrawingContext drawingContext)
    {
      base.OnRender(drawingContext);
      double width = ActualWidth;
      double height = ActualHeight;
      if (width <= 0 || height <= 0)
      {
        return;
      }

      Pen gridPen = new Pen(new SolidColorBrush(Color.FromArgb(76, 59, 59, 59)), 1);
      for (double x = 0; x <= width; x += 32)
      {
        drawingContext.DrawLine(gridPen, new Point(x, 0), new Point(x, height));
      }
      for (double y = 0; y <= height; y += 32)
      {
        drawingContext.DrawLine(gridPen, new Point(0, y), new Point(width, y));
      }

      Pen centerPen = new Pen(new SolidColorBrush(Color.FromArgb(130, 0, 120, 212)), 1);
      centerPen.DashStyle = new DashStyle(new double[] { 3, 5 }, 0);
      drawingContext.DrawLine(centerPen, new Point(0, height * 0.5), new Point(width, height * 0.5));

      DrawWave(drawingContext, width, height, height * 0.29, 64, 0.25, 0.08);
      DrawWave(drawingContext, width, height, height * 0.70, 48, 0.19, 0.11);

      Brush playheadBrush = new SolidColorBrush(Color.FromArgb(175, 0, 120, 212));
      double playheadX = width * 0.64;
      drawingContext.DrawRectangle(playheadBrush, null, new Rect(playheadX, 34, 1, height - 68));
      drawingContext.DrawEllipse(playheadBrush, null, new Point(playheadX, 34), 3, 3);
    }

    private static void DrawWave(
      DrawingContext drawingContext,
      double width,
      double height,
      double centerY,
      double amplitude,
      double frequencyA,
      double frequencyB
    )
    {
      Brush strong = new SolidColorBrush(Color.FromArgb(210, Accent.R, Accent.G, Accent.B));
      Brush soft = new SolidColorBrush(Color.FromArgb(74, Accent.R, Accent.G, Accent.B));
      double step = 5;
      int index = 0;

      for (double x = 0; x < width; x += step)
      {
        double envelope = 0.34 + (Math.Sin(index * frequencyB) + 1) * 0.23;
        double signal = Math.Abs(Math.Sin(index * frequencyA) * 0.68 + Math.Sin(index * 0.71) * 0.32);
        double barHeight = 4 + amplitude * envelope * signal;
        Brush brush = index % 5 == 0 ? strong : soft;
        drawingContext.DrawRoundedRectangle(
          brush,
          null,
          new Rect(x, centerY - barHeight, 2, barHeight * 2),
          1,
          1
        );
        index++;
      }
    }
  }
}
