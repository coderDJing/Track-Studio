;(async () => {
  if (window.__windowsAuditCleanup) window.__windowsAuditCleanup()
  const vue = await import(
    performance.getEntriesByType('resource').find((e) => /\/deps\/vue\.js/.test(e.name)).name
  )
  const state = await import('/src/utils/bpmFixActions.ts')
  if (state.bpmFixSnapshot.value) throw Error('Existing real BPM task: fixture refused')
  const { default: Component } = await import('/src/components/BpmFixDialog.vue')
  const host = document.createElement('div')
  host.dataset.windowsAuditFixture =
    'BPM display only, 80 synthetic tracks; no IPC analysis or repair'
  document.body.appendChild(host)
  state.bpmFixSnapshot.value = {
    id: 'windows-audit-display-only',
    status: 'ready',
    stage: 'ready',
    current: 80,
    currentPercent: 100,
    percent: 100,
    tracks: Array.from({ length: 80 }, (_, i) => ({
      id: `fixture-${i}`,
      filePath: `FIXTURE/Windows display sample ${i + 1} — very long artist and track name for truncation checking.wav`,
      status: 'ready',
      analysis: {
        sourceBpm: 127.52,
        referenceBpm: 128,
        confidence: 0.8,
        agreement: 0.97,
        regularity: 0.95,
        driftMs: 3,
        coverage: 0.99,
        filledBeats: 2,
        ignoredDetections: 1,
        tempoAmbiguous: false,
        durationSec: 300
      }
    }))
  }
  state.bpmFixDraft.tracks = Object.fromEntries(
    state.bpmFixSnapshot.value.tracks.map((t) => [
      t.id,
      { id: t.id, enabled: false, tempoFactor: 1, targetBpm: null, allowLowConfidence: false }
    ])
  )
  const cleanup = () => {
    vue.render(null, host)
    host.remove()
    state.bpmFixSnapshot.value = null
    state.bpmFixDraft.tracks = {}
    state.bpmFixFocusedId.value = ''
    delete window.__windowsAuditCleanup
  }
  window.__windowsAuditCleanup = cleanup
  host.addEventListener(
    'click',
    (e) => {
      const button = e.target.closest('button')
      if (button && !/^(Close|Minimize|关闭|最小化|×)$/.test(button.textContent.trim())) {
        e.preventDefault()
        e.stopImmediatePropagation()
      }
    },
    true
  )
  const vnode = vue.createVNode(Component, { onClose: cleanup, onMinimize: cleanup })
  vnode.appContext = window.__FRKB_APP_CONTEXT__
  vue.render(vnode, host)
  return { fixture: 'BPM display only', rows: 80 }
})()
