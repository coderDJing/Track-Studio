;(() => {
  const button = document.getElementById('language')
  function setLanguage(language) {
    const english = language === 'en'
    document.documentElement.lang = english ? 'en' : 'zh-Hans'
    document.title = english ? 'Track Studio — Support' : 'Track Studio — 使用帮助'
    document.querySelectorAll('[data-zh][data-en]').forEach((node) => {
      node.textContent = node.getAttribute(english ? 'data-en' : 'data-zh')
    })
    button.textContent = english ? '中文' : 'EN'
    button.setAttribute('aria-label', english ? '切换为中文' : 'Switch to English')
  }
  const preferred = navigator.language.toLowerCase().startsWith('zh') ? 'zh' : 'en'
  setLanguage(preferred)
  button.addEventListener('click', () =>
    setLanguage(document.documentElement.lang === 'en' ? 'zh' : 'en')
  )
})()
