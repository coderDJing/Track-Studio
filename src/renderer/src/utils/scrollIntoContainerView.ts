// 保持目标在指定容器内可见，不滚动容器外的祖先；兼容缩放后的嵌入界面。
export const scrollIntoContainerView = (target: HTMLElement, container: HTMLElement) => {
  const hostRect = container.getBoundingClientRect()
  if (!container.offsetHeight || !hostRect.height) return
  const scale = hostRect.height / container.offsetHeight
  const targetRect = target.getBoundingClientRect()
  const visibleTop = hostRect.top + container.clientTop * scale
  const visibleBottom = visibleTop + container.clientHeight * scale
  if (targetRect.top < visibleTop) {
    container.scrollTop += (targetRect.top - visibleTop) / scale
  } else if (targetRect.bottom > visibleBottom) {
    container.scrollTop += (targetRect.bottom - visibleBottom) / scale
  }
}
