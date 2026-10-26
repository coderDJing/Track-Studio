;(async () => {
  window.__windowsAuditCleanup?.()
  const vue = await import(
    performance.getEntriesByType('resource').find((e) => /\/deps\/vue\.js/.test(e.name)).name
  )
  const fixtures = [
    ['fingerprint-import', 'importSongFingerprintDialog.vue', {}],
    ['fingerprint-export', 'exportSongFingerprintDialog.vue', {}],
    ['fingerprint-manual', 'manualAddSongFingerprintDialog.vue', {}],
    [
      'xml-export',
      'rekordboxXmlExportDialog.vue',
      {
        dialogTitle: 'DISPLAY FIXTURE — Rekordbox XML',
        defaultExportDirName: 'Display fixture export',
        defaultXmlFileName: 'display-fixture.xml',
        defaultXmlPlaylistName: 'Long English playlist name '.repeat(6)
      }
    ],
    [
      'mixtape-output',
      'mixtapeOutputDialog.vue',
      {
        outputFilename: 'Display fixture long mixtape name '.repeat(6),
        outputFormat: 'wav',
        outputPath: ''
      }
    ],
    [
      'edit-save',
      'HorizontalBrowseAudioEditSaveDialog.vue',
      {
        originalTitle: 'DISPLAY FIXTURE ' + 'Long track and artist name '.repeat(12),
        originalFormat: 'mp3',
        versionPreviewName: 'Long new version name '.repeat(15) + '.mp3',
        losslessSource: false
      }
    ],
    ['edit-leave', 'HorizontalBrowseAudioEditLeaveDialog.vue', {}],
    [
      'player-shortcut',
      'playerGlobalShortcutDialog.vue',
      { actionKey: 'togglePlayPause', mode: 'action' }
    ],
    ['analysis-range', 'analysisBpmRangeDialog.vue', { count: 100000, initialRangeId: '70-180' }],
    [
      'reanalysis',
      'trackReanalysisDialog.vue',
      {
        count: 100000,
        initialSelection: {
          key: true,
          beatGrid: true,
          waveform: true,
          energy: true,
          structure: true
        },
        canSelectStructureAlone: false,
        purpose: 'reanalysis'
      }
    ],
    [
      'similar-error',
      'batchSimilarTracksDialog.vue',
      {
        seeds: [],
        initialErrorText:
          'DISPLAY FIXTURE: ' +
          'Long recommendation service error detail for wrapping and scrolling. '.repeat(24)
      }
    ],
    [
      'runtime-progress',
      'AnalysisRuntimeDownloadOverlay.vue',
      {
        visible: true,
        title: 'DISPLAY FIXTURE — Runtime preparation',
        text: 'Displaying progress only; no download was requested.',
        percent: 75,
        hint: 'Display fixture: waiting for analysis runtime preparation. '.repeat(8)
      }
    ],
    [
      'sync-first-align',
      'curatedLibrarySyncJoinDialog.vue',
      {
        title: 'DISPLAY FIXTURE — First alignment',
        intro: 'Display fixture only; no alignment or sync is performed.',
        localCountLabel: 'Local',
        cloudCountLabel: 'Cloud',
        localCount: 100000,
        cloudCount: 100000,
        countUnit: 'tracks',
        mergeLabel: 'Merge both libraries',
        mergeHint: 'Display long English first alignment explanation. '.repeat(8),
        mergeBadge: 'Recommended',
        cloudWinsLabel: 'Use cloud library',
        cloudWinsHint: 'Display cloud option explanation. '.repeat(8),
        localWinsLabel: 'Use local library',
        localWinsHint: 'Display local option explanation. '.repeat(8),
        cancelLabel: 'Cancel'
      }
    ]
  ]
  const index = window.__windowsAuditConfigIndex || 0
  if (index >= fixtures.length) return { complete: true }
  const [name, file, props] = fixtures[index]
  const { default: Component } = await import('/src/components/' + file)
  const host = document.createElement('div')
  host.dataset.windowsAuditFixture = name
  document.body.appendChild(host)
  const cleanup = () => {
    document.removeEventListener('keydown', blockKeys, true)
    vue.render(null, host)
    host.remove()
    delete window.__windowsAuditCleanup
  }
  const blockKeys = (e) => {
    if (e.key !== 'Escape') {
      e.preventDefault()
      e.stopImmediatePropagation()
    }
  }
  document.addEventListener('keydown', blockKeys, true)
  host.addEventListener(
    'click',
    (e) => {
      e.preventDefault()
      e.stopImmediatePropagation()
    },
    true
  )
  window.__windowsAuditCleanup = cleanup
  const vnode = vue.createVNode(Component, {
    ...props,
    onClose: cleanup,
    onCancel: cleanup,
    onConfirm: cleanup,
    onSave: cleanup,
    onDiscard: cleanup,
    confirmCallback: cleanup,
    cancelCallback: cleanup
  })
  vnode.appContext = window.__FRKB_APP_CONTEXT__
  vue.render(vnode, host)
  window.__windowsAuditConfigIndex = index + 1
  return { fixture: name, displayOnly: true, index }
})()
