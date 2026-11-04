import path from 'node:path'
import type { ISongInfo } from '../../types/globals'

// Older scans could persist a failed MP3 metadata read as a complete cache entry.
export const needsMetadataRetry = (info: ISongInfo): boolean =>
  info.analysisOnly === true ||
  (path.extname(info.filePath).toLowerCase() === '.mp3' &&
    !String(info.duration || '').trim() &&
    String(info.title || '').trim() === String(info.fileName || '').trim() &&
    !String(info.artist || '').trim() &&
    !info.bitrate)
