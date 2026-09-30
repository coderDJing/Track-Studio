Add-Type -AssemblyName System.Drawing

$repoRoot = Split-Path -Parent $PSScriptRoot
$waveformPath = Join-Path $repoRoot 'docs/public/assets/unified-waveforms/deck-a.bin'
$iconPath = Join-Path $repoRoot 'build/icon.png'
$outputRoot = Join-Path $repoRoot 'docs/public/assets'
$waveform = [System.IO.File]::ReadAllBytes($waveformPath)
$icon = [System.Drawing.Image]::FromFile($iconPath)
$cueColors = @('#20c997', '#2f80ed', '#9b51e0', '#eb5757', '#f2c94c', '#ff6b9a', '#27ae60', '#56ccf2')
$cards = @(
  @{ File = 'og-track-studio-zh.png'; Line1 = '终结混乱的'; Line2 = 'DJ 音频工作站'; Font = 'Microsoft YaHei UI' },
  @{ File = 'og-track-studio-en.png'; Line1 = 'End the Chaos.'; Line2 = 'The Ultimate DJ Audio Workspace.'; Font = 'Segoe UI' }
)

try {
  foreach ($card in $cards) {
    $bitmap = [System.Drawing.Bitmap]::new(1200, 630)
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $graphics.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
    $graphics.Clear([System.Drawing.ColorTranslator]::FromHtml('#181818'))

    $panelBrush = [System.Drawing.SolidBrush]::new([System.Drawing.ColorTranslator]::FromHtml('#1f1f1f'))
    $mainBrush = [System.Drawing.SolidBrush]::new([System.Drawing.ColorTranslator]::FromHtml('#cccccc'))
    $secondaryBrush = [System.Drawing.SolidBrush]::new([System.Drawing.ColorTranslator]::FromHtml('#a8abb2'))
    $blueBrush = [System.Drawing.SolidBrush]::new([System.Drawing.ColorTranslator]::FromHtml('#0078d4'))
    $borderPen = [System.Drawing.Pen]::new([System.Drawing.ColorTranslator]::FromHtml('#3b3b3b'), 2)
    $mainFont = [System.Drawing.Font]::new('Segoe UI Semibold', 58, [System.Drawing.FontStyle]::Regular)
    $lineFont = [System.Drawing.Font]::new($card.Font, 30, [System.Drawing.FontStyle]::Regular)
    $smallFont = [System.Drawing.Font]::new('Segoe UI Semibold', 17, [System.Drawing.FontStyle]::Regular)
    $tinyFont = [System.Drawing.Font]::new('Segoe UI', 14, [System.Drawing.FontStyle]::Regular)

    try {
      $graphics.FillRectangle($panelBrush, 54, 340, 1092, 222)
      $graphics.DrawRectangle($borderPen, 54, 340, 1092, 222)
      $graphics.DrawImage($icon, 66, 64, 104, 104)
      $graphics.DrawString('Track Studio', $mainFont, $mainBrush, 187, 64)
      $graphics.FillRectangle($blueBrush, 76, 207, 5, 99)
      $graphics.DrawString($card.Line1, $lineFont, $mainBrush, 99, 199)
      $graphics.DrawString($card.Line2, $lineFont, $mainBrush, 99, 252)

      $overviewOffset = 9 * 144000 + 36000
      for ($bar = 0; $bar -lt 510; $bar++) {
        $sample = [int][math]::Floor($bar * 3840 / 510)
        $height = [math]::Max(3, [int]($waveform[$overviewOffset + $sample] * 0.65))
        $detailSample = [int][math]::Floor($sample * 144000 / 3840)
        $red = [int]$waveform[6 * 144000 + $detailSample]
        $green = [int]$waveform[7 * 144000 + $detailSample]
        $blue = [int]$waveform[8 * 144000 + $detailSample]
        $waveColor = [System.Drawing.Color]::FromArgb(230, $red, $green, $blue)
        $wavePen = [System.Drawing.Pen]::new($waveColor, 2)
        try {
          $x = 86 + 2 * $bar
          $graphics.DrawLine($wavePen, $x, 452 - $height, $x, 452 + $height)
        } finally {
          $wavePen.Dispose()
        }
      }

      for ($cue = 0; $cue -lt 8; $cue++) {
        $x = 114 + $cue * 135
        $cueBrush = [System.Drawing.SolidBrush]::new([System.Drawing.ColorTranslator]::FromHtml($cueColors[$cue]))
        try {
          $graphics.FillRectangle($cueBrush, $x, 351, 27, 23)
          $graphics.DrawString([char]([int][char]'A' + $cue), $tinyFont, [System.Drawing.Brushes]::Black, $x + 6, 350)
        } finally {
          $cueBrush.Dispose()
        }
      }

      $graphics.DrawString('WINDOWS  /  macOS', $smallFont, $secondaryBrush, 76, 580)
      $graphics.DrawString('TRACK STUDIO', $smallFont, $secondaryBrush, 994, 580)
      $outputPath = Join-Path $outputRoot $card.File
      $bitmap.Save($outputPath, [System.Drawing.Imaging.ImageFormat]::Png)
      Write-Output $outputPath
    } finally {
      $tinyFont.Dispose()
      $smallFont.Dispose()
      $lineFont.Dispose()
      $mainFont.Dispose()
      $borderPen.Dispose()
      $blueBrush.Dispose()
      $secondaryBrush.Dispose()
      $mainBrush.Dispose()
      $panelBrush.Dispose()
      $graphics.Dispose()
      $bitmap.Dispose()
    }
  }
} finally {
  $icon.Dispose()
}
