;(async () => {
  if (window.__windowsAuditCleanup) window.__windowsAuditCleanup()
  const vue = await import(
    performance.getEntriesByType('resource').find((e) => /\/deps\/vue\.js/.test(e.name)).name
  )
  const { default: Component } = await import('/src/components/filterDialog.vue')
  const host = document.createElement('div')
  host.dataset.windowsAuditFixture = 'Date filter display only; callbacks only unmount'
  document.body.appendChild(host)
  const cleanup = () => {
    vue.render(null, host)
    host.remove()
    delete window.__windowsAuditCleanup
  }
  window.__windowsAuditCleanup = cleanup
  const vnode = vue.createVNode(Component, {
    type: 'date',
    initOp: 'between',
    onCancel: cleanup,
    onConfirm: cleanup,
    onClear: cleanup
  })
  vnode.appContext = window.__FRKB_APP_CONTEXT__
  vue.render(vnode, host)
  return { fixture: 'Date range display only' }
})()
