;(() => {
  const luminance = (rgb) =>
    rgb
      .map((v) => v / 255)
      .map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
      .reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0)
  const contrast = (color) => {
    const rgb = color
      .match(/[\d.]+/g)
      ?.slice(0, 3)
      .map(Number)
    return rgb ? +(1.05 / (luminance(rgb) + 0.05)).toFixed(2) : null
  }
  return {
    fixture: document.querySelector('[data-windows-audit-fixture]')?.dataset.windowsAuditFixture,
    theme: document.documentElement.className,
    viewport: [innerWidth, innerHeight],
    focused: {
      tag: document.activeElement?.tagName,
      class: document.activeElement?.className,
      placeholder: document.activeElement?.getAttribute('placeholder')
    },
    text: [
      ...document.querySelectorAll(
        '.dialog-visible .section-title, .dialog-visible .num, .dialog-visible .error-msg'
      )
    ]
      .slice(0, 30)
      .map((e) => ({
        text: e.textContent.slice(0, 100),
        color: getComputedStyle(e).color,
        textShadow: getComputedStyle(e).textShadow,
        contrastAgainstWhite: contrast(getComputedStyle(e).color)
      })),
    scrollAreas: [...document.querySelectorAll('.dialog-visible *')]
      .filter(
        (e) =>
          e.scrollHeight > e.clientHeight + 2 && /(auto|scroll)/.test(getComputedStyle(e).overflowY)
      )
      .map((e) => ({
        class: e.className,
        clientHeight: e.clientHeight,
        scrollHeight: e.scrollHeight,
        scrollTop: e.scrollTop,
        rect: e.getBoundingClientRect().toJSON()
      }))
  }
})()
