type MouseDragState = {
  source: HTMLElement
  startX: number
  startY: number
  point: MouseEvent
  active: boolean
  dataTransfer: DataTransfer
  target: Element | null
}

/** Internal app gestures use the release coordinates, including a single fast movement. */
export const createInternalMouseDrag = () => {
  let state: MouseDragState | null = null
  let suppressClickUntil = 0
  let animationFrame: number | null = null
  const listenerOptions = { capture: true }

  const dispatch = (target: EventTarget, type: string, current: MouseDragState): DragEvent => {
    const event = new DragEvent(type, {
      bubbles: true,
      cancelable: true,
      composed: true,
      clientX: current.point.clientX,
      clientY: current.point.clientY,
      screenX: current.point.screenX,
      screenY: current.point.screenY,
      buttons: type === 'drop' || type === 'dragend' ? 0 : 1,
      dataTransfer: current.dataTransfer
    })
    target.dispatchEvent(event)
    return event
  }

  const finish = () => {
    const current = state
    state = null
    if (animationFrame !== null) cancelAnimationFrame(animationFrame)
    animationFrame = null
    window.removeEventListener('mousemove', move, listenerOptions)
    window.removeEventListener('mouseup', release, listenerOptions)
    window.removeEventListener('keydown', keyDown, listenerOptions)
    window.removeEventListener('blur', cancel)
    document.removeEventListener('visibilitychange', visibilityChanged)
    if (!current?.active) return
    document.documentElement.classList.remove('internal-song-mouse-drag')
    suppressClickUntil = Date.now() + 450
    if (current.target) dispatch(current.target, 'dragleave', current)
    dispatch(current.source, 'dragend', current)
  }

  const activate = (current: MouseDragState) => {
    if (current.active) return true
    if (
      !current.source.isConnected ||
      Math.hypot(current.point.clientX - current.startX, current.point.clientY - current.startY) < 5
    )
      return false
    current.active = true
    if (dispatch(current.source, 'dragstart', current).defaultPrevented) {
      finish()
      return false
    }
    document.documentElement.classList.add('internal-song-mouse-drag')
    animationFrame = requestAnimationFrame(hoverFrame)
    return true
  }

  function hoverFrame() {
    animationFrame = null
    const current = state
    if (!current?.active) return
    if (!current.source.isConnected) {
      finish()
      return
    }
    // Keep the existing list edge scrolling working while the mouse is held still.
    updateTarget(current)
    animationFrame = requestAnimationFrame(hoverFrame)
  }

  const updateTarget = (current: MouseDragState) => {
    const target = document.elementFromPoint(current.point.clientX, current.point.clientY)
    if (current.target !== target) {
      if (current.target) dispatch(current.target, 'dragleave', current)
      current.target = target
      if (target) dispatch(target, 'dragenter', current)
    }
    // Acceptance must be recomputed at release; a previous target cannot authorize this drop.
    current.dataTransfer.dropEffect = 'none'
    if (!target) return false
    const over = dispatch(target, 'dragover', current)
    return over.defaultPrevented && current.dataTransfer.dropEffect !== 'none'
  }

  function move(event: MouseEvent) {
    const current = state
    if (!current) return
    if (!(event.buttons & 1) || !current.source.isConnected) {
      finish()
      return
    }
    current.point = event
    if (!activate(current)) return
    event.preventDefault()
    event.stopPropagation()
    updateTarget(current)
  }

  function release(event: MouseEvent) {
    const current = state
    if (!current || event.button !== 0) return
    current.point = event
    if (activate(current)) {
      event.preventDefault()
      event.stopPropagation()
      if (current.source.isConnected && updateTarget(current) && current.target)
        dispatch(current.target, 'drop', current)
    }
    finish()
  }

  function cancel() {
    finish()
  }

  function keyDown(event: KeyboardEvent) {
    if (event.key !== 'Escape') return
    if (state?.active) {
      event.preventDefault()
      event.stopPropagation()
    }
    finish()
  }

  function visibilityChanged() {
    if (document.hidden) finish()
  }

  const suppressClick = (event: MouseEvent) => {
    if (Date.now() >= suppressClickUntil) return
    event.preventDefault()
    event.stopImmediatePropagation()
  }

  return {
    start: (event: MouseEvent, source: HTMLElement) => {
      if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey)
        return
      if (
        event.target instanceof Element &&
        event.target.closest('button,input,textarea,select,a,[contenteditable="true"]')
      )
        return
      finish()
      window.addEventListener('click', suppressClick, listenerOptions)
      state = {
        source,
        startX: event.clientX,
        startY: event.clientY,
        point: event,
        active: false,
        dataTransfer: new DataTransfer(),
        target: null
      }
      // These are the app's copy/move decisions. Chromium's detached DataTransfer
      // ignores native effect setters outside its OS drag session.
      Object.defineProperties(state.dataTransfer, {
        dropEffect: { value: 'none', writable: true, configurable: true },
        effectAllowed: { value: 'all', writable: true, configurable: true }
      })
      window.addEventListener('mousemove', move, listenerOptions)
      window.addEventListener('mouseup', release, listenerOptions)
      window.addEventListener('keydown', keyDown, listenerOptions)
      window.addEventListener('blur', cancel)
      document.addEventListener('visibilitychange', visibilityChanged)
    },
    dispose: () => {
      finish()
      window.removeEventListener('click', suppressClick, listenerOptions)
    }
  }
}
