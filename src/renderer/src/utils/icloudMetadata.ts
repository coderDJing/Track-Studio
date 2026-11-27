import type { IcloudEntry, IcloudMetadataItem, IcloudSongMetadata } from '@shared/icloudLibrary'
export function createIcloudMetadataLoader(options: {
  read: (paths: string[], token: string, requestId: string) => Promise<IcloudMetadataItem[]>
  cancel: (requestId: string) => void
  apply: (relative: string, metadata: IcloudSongMetadata | undefined) => void
}) {
  let generation = 0,
    pending = ''
  function cancel() {
    generation++
    if (pending) options.cancel(pending)
    pending = ''
  }
  async function load(entries: IcloudEntry[], token: string) {
    cancel()
    const id = generation
    const local = entries.filter((entry) => !entry.directory && entry.residency === 'local')
    for (let start = 0; start < local.length; start += 16) {
      if (id !== generation) return
      const paths = local.slice(start, start + 16).map((entry) => entry.relativePath)
      pending = crypto.randomUUID()
      try {
        const result = await options.read(paths, token, pending)
        if (id !== generation) return
        for (const item of result)
          if (paths.includes(item.relativePath)) options.apply(item.relativePath, item.metadata)
      } catch {
        if (id !== generation) return
        for (const relative of paths) options.apply(relative, undefined)
      } finally {
        if (id === generation) pending = ''
      }
    }
  }
  return { load, cancel }
}
