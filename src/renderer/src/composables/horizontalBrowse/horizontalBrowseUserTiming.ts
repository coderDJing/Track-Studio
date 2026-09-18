let horizontalBrowseTimingCounter = 0

export const startHorizontalBrowseUserTiming = (name: string) => {
  if (typeof performance === 'undefined') {
    return () => {}
  }
  if (typeof performance.mark !== 'function' || typeof performance.measure !== 'function') {
    return () => {}
  }

  horizontalBrowseTimingCounter += 1
  const token = `${name}#${horizontalBrowseTimingCounter}`
  const startMark = `${token}:start`
  const endMark = `${token}:end`
  performance.mark(startMark)

  return () => {
    performance.mark(endMark)
    performance.measure(name, startMark, endMark)
    performance.clearMarks(startMark)
    performance.clearMarks(endMark)
    performance.clearMeasures(name)
  }
}
