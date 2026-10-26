;(async () => {
  if (window.__windowsAuditCleanup) window.__windowsAuditCleanup()
  const vue = await import(
    performance.getEntriesByType('resource').find((e) => /\/deps\/vue\.js/.test(e.name)).name
  )
  const overview = {
    startAt: '2026-10-26T09:00:00Z',
    endAt: '2026-10-26T09:30:00Z',
    durationMs: 1800000,
    scannedCount: 100000,
    analyzeFailedCount: 999,
    importedToPlaylistCount: 90000,
    duplicatesRemovedCount: 9001,
    fingerprintAddedCount: 80000,
    fingerprintAlreadyExistingCount: 10000,
    fingerprintTotalBefore: 1000000,
    fingerprintTotalAfter: 1080000,
    isComparisonSongFingerprint: true,
    isPushSongFingerprintLibrary: true
  }
  const fixtures = [
    {
      name: 'import-summary',
      component: 'importFinishedSummaryDialog.vue',
      props: { summary: overview }
    },
    {
      name: 'fingerprint-summary',
      component: 'addSongFingerprintFinishedDialog.vue',
      props: { summary: overview }
    },
    {
      name: 'conversion-errors',
      component: 'conversionFinishedSummaryDialog.vue',
      props: {
        summary: {
          total: 100,
          success: 20,
          failed: 80,
          skipped: 0,
          overwritten: 0,
          renamed: 20,
          backupCount: 0,
          fingerprintAddedCount: 20,
          durationMs: 100000
        },
        errors: Array.from({ length: 80 }, (_, i) => ({
          filePath: `FIXTURE/Long artist name and very long filename ${i}.flac`,
          message: 'DISPLAY FIXTURE: ' + 'long error detail for wrapping. '.repeat(30)
        }))
      }
    },
    {
      name: 'cloud-summary',
      component: 'cloudSyncSummaryDialog.vue',
      props: {
        summary: {
          addedToServerCount: 100000,
          pulledToClientCount: 200000,
          curatedArtistClientInitialCount: 300000,
          curatedArtistClientCountAfter: 400000,
          curatedArtistServerInitialCount: 500000,
          curatedArtistServerCountAfter: 600000,
          clientInitialCount: 1000000,
          totalClientCountAfter: 1200000,
          serverInitialCount: 3000000,
          totalServerCountAfter: 3100000
        }
      }
    },
    {
      name: 'rename-result',
      component: 'playlistBatchRename/ResultDialog.vue',
      props: {
        result: {
          summary: { total: 100, success: 0, failed: 100, skipped: 0, cancelled: 0 },
          items: Array.from({ length: 100 }, (_, i) => ({
            id: `fixture-${i}`,
            order: i,
            filePath: `FIXTURE/Long original filename ${i}.mp3`,
            originalFileName: `Long original filename ${i}.mp3`,
            targetFileName: 'Long new title and artist name '.repeat(8) + i + '.mp3',
            status: 'file_in_use'
          })),
          updates: []
        }
      }
    }
  ]
  const index = window.__windowsAuditResultIndex || 0
  if (index >= fixtures.length) return { complete: true }
  const fixture = fixtures[index]
  const { default: Component } = await import('/src/components/' + fixture.component)
  const host = document.createElement('div')
  host.dataset.windowsAuditFixture = fixture.name
  document.body.appendChild(host)
  const cleanup = () => {
    vue.render(null, host)
    host.remove()
    delete window.__windowsAuditCleanup
  }
  window.__windowsAuditCleanup = cleanup
  const vnode = vue.createVNode(Component, { ...fixture.props, onClose: cleanup })
  vnode.appContext = window.__FRKB_APP_CONTEXT__
  vue.render(vnode, host)
  window.__windowsAuditResultIndex = index + 1
  return { fixture: fixture.name, index, displayOnly: true }
})()
