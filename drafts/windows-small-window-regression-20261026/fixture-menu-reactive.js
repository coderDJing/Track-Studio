;(async () => {
  window.__windowsAuditCleanup?.()
  const vue = await import(
    performance.getEntriesByType('resource').find((e) => /\/deps\/vue\.js/.test(e.name)).name
  )
  const { default: Component } = await import('/src/components/rightClickMenu.vue')
  const index = (window.__windowsAuditMenuIndex || 0) % 4
  const corners = [
    [0, 43],
    [innerWidth - 1, 43],
    [0, innerHeight - 1],
    [innerWidth - 1, innerHeight - 1]
  ]
  const host = document.createElement('div')
  host.dataset.windowsAuditFixture = `Long context menu, corner ${index}, callbacks only unmount`
  document.body.appendChild(host)
  const cleanup = () => {
    vue.render(null, host)
    host.remove()
    delete window.__windowsAuditCleanup
  }
  window.__windowsAuditCleanup = cleanup
  const vnode = vue.createVNode(Component, {
    menuArr: vue.reactive([
      [
        {
          menuName: 'DISPLAY FIXTURE — submenu parent',
          children: Array.from({ length: 40 }, (_, i) => ({
            menuName: `DISPLAY child ${i + 1} — long English option`
          }))
        },
        ...Array.from({ length: 60 }, (_, i) => ({
          menuName: `DISPLAY main ${i + 1} — long English option`
        }))
      ]
    ]),
    clickEvent: new MouseEvent('contextmenu', {
      clientX: corners[index][0],
      clientY: corners[index][1]
    }),
    confirmCallback: cleanup,
    cancelCallback: cleanup
  })
  vnode.appContext = window.__FRKB_APP_CONTEXT__
  vue.render(vnode, host)
  window.__windowsAuditMenuIndex = index + 1
  return { fixture: 'Long context menu display only', corner: index }
})()
