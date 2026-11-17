import { describe, expect, it } from 'vitest'
import { validateRequestLibrary } from './validate'
import type { RekordboxXmlExportRequest } from '../../../shared/rekordboxXmlExport'

const baseRequest = (
  sourceLibraryName: RekordboxXmlExportRequest['sourceLibraryName'],
  mode: RekordboxXmlExportRequest['mode']
): RekordboxXmlExportRequest => ({
  jobId: 'job',
  targetRootDir: '/tmp/export',
  exportDirName: 'Export',
  xmlFileName: 'Export.xml',
  xmlPlaylistName: 'Export',
  mode,
  sourceLibraryName,
  source: {
    kind: 'selected-tracks',
    songListUUID: 'list',
    tracks: [{ filePath: '/tmp/song.mp3' }]
  }
})

describe('validateRequestLibrary', () => {
  it('accepts a NetEase copy export', () => {
    expect(validateRequestLibrary(baseRequest('NeteaseLibrary', 'copy'))).toEqual({ ok: true })
  })

  it('rejects moving NetEase cache files', () => {
    expect(validateRequestLibrary(baseRequest('NeteaseLibrary', 'move'))).toMatchObject({
      ok: false,
      code: 'MOVE_NOT_ALLOWED'
    })
  })

  it('still accepts copy and move for supported core libraries', () => {
    expect(validateRequestLibrary(baseRequest('FilterLibrary', 'copy'))).toEqual({ ok: true })
    expect(validateRequestLibrary(baseRequest('SetLibrary', 'move'))).toEqual({ ok: true })
  })
})
