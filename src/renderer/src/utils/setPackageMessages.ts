import { t } from './translate'
import type { SetPackageFailure } from '@shared/setPackage'

export const getSetPackageFailureLines = (failure: SetPackageFailure): string[] => {
  const headlineByCode: Record<string, string> = {
    EMPTY_SET: t('library.setPackageEmptySet'),
    MISSING_FILES: t('library.setPackageMissingFiles'),
    TRACKS_MISMATCH: t('library.setPackageTracksChanged'),
    PACKAGE_FILE_MISSING: t('library.setPackageFileMissing'),
    PACKAGE_FILE_CORRUPTED: t('library.setPackageFileCorrupted'),
    MANIFEST_INVALID: t('library.setPackageInvalidManifest'),
    MANIFEST_VERSION_UNSUPPORTED: t('library.setPackageVersionUnsupported'),
    NO_SPACE: t('library.setPackageNoSpace')
  }
  const headline =
    headlineByCode[failure.code] ||
    t('library.setPackageFailedReason', { message: failure.message || t('common.unknownError') })
  const names = Array.isArray(failure.fileNames) ? failure.fileNames.filter(Boolean) : []
  const lines = [headline, ...names.slice(0, 10)]
  if (names.length > 10) {
    lines.push(t('library.setPackageMoreFiles', { count: names.length - 10 }))
  }
  return lines
}
