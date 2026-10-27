const pendingSummaries = new Map<string, Set<Promise<void>>>()

export const beginImportSummary = (playlistId: string) => {
  let resolve!: () => void
  const pending = new Promise<void>((done) => {
    resolve = done
  })
  const summaries = pendingSummaries.get(playlistId) ?? new Set<Promise<void>>()
  summaries.add(pending)
  pendingSummaries.set(playlistId, summaries)
  return () => {
    summaries.delete(pending)
    if (!summaries.size) pendingSummaries.delete(playlistId)
    resolve()
  }
}

export const waitForImportSummaries = async (playlistId: string) => {
  while (pendingSummaries.has(playlistId)) {
    await Promise.all(pendingSummaries.get(playlistId)!)
  }
}
