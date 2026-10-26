;(() => {
  window.__windowsAuditCleanup?.()
  delete window.__windowsAuditResultIndex
  delete window.__windowsAuditMenuIndex
  delete window.__windowsAuditConfigIndex
  return { fixtureCleaned: !document.querySelector('[data-windows-audit-fixture]') }
})()
