using System;
using System.Globalization;

namespace TrackStudioInstallerUi
{
  internal static class InstallerText
  {
    private static bool isChinese = string.Equals(
      CultureInfo.CurrentUICulture.TwoLetterISOLanguageName, "zh", StringComparison.OrdinalIgnoreCase
    );

    internal static void SetPreviewLanguage(string language)
    {
      if (string.Equals(language, "zh", StringComparison.OrdinalIgnoreCase)) isChinese = true;
      if (string.Equals(language, "en", StringComparison.OrdinalIgnoreCase)) isChinese = false;
    }

    internal static string Get(string chinese, string english)
    {
      return isChinese ? chinese : english;
    }
  }
}
