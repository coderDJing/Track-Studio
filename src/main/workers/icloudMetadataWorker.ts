import { readIcloudMetadata } from '../services/icloudLibrary/readMetadata'
import { readMacResidency } from '../services/icloudLibrary/files'
import type { IcloudMetadataItem } from '../../shared/icloudLibrary'

async function main() {
  const [root, input, rootIdentity] = process.argv.slice(2)
  const parsed: unknown = JSON.parse(input)
  const cover =
    !!parsed &&
    !Array.isArray(parsed) &&
    typeof parsed === 'object' &&
    'cover' in parsed &&
    parsed.cover === true
  const paths: unknown =
    cover && parsed && typeof parsed === 'object' && 'paths' in parsed ? parsed.paths : parsed
  if (
    typeof root !== 'string' ||
    typeof rootIdentity !== 'string' ||
    !rootIdentity ||
    !Array.isArray(paths) ||
    paths.length > (cover ? 1 : 16) ||
    paths.some((value) => typeof value !== 'string' || value.length > 8192)
  )
    throw new Error('invalid')
  const results: IcloudMetadataItem[] = []
  // Sequential within a bounded batch. Main process permits at most two workers.
  for (const relativePath of paths as string[]) {
    try {
      results.push({
        relativePath,
        metadata: await readIcloudMetadata(
          root,
          relativePath,
          readMacResidency,
          rootIdentity,
          cover
        )
      })
    } catch {
      results.push({ relativePath })
    }
  }
  process.stdout.write(JSON.stringify(results))
}
void main().catch(() => {
  process.exitCode = 1
})
