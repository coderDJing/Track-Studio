import type { IPioneerDeviceLibraryKind } from '../../../../../types/globals'
import type { PioneerDriveGroup, PioneerDriveIcon } from './useRekordboxSourceIcons'

const pioneerDriveTypeOrder: Record<IPioneerDeviceLibraryKind, number> = {
  deviceLibrary: 0,
  oneLibrary: 1
}

export const groupPioneerDriveIcons = (icons: PioneerDriveIcon[]): PioneerDriveGroup[] => {
  const groupMap = new Map<string, PioneerDriveGroup>()
  for (const icon of icons) {
    const groupKey = `pioneer-group:${icon.path || icon.key}`
    const existing = groupMap.get(groupKey)
    if (existing) {
      existing.icons.push(icon)
      continue
    }
    groupMap.set(groupKey, {
      key: groupKey,
      path: icon.path,
      icons: [icon]
    })
  }
  return Array.from(groupMap.values()).map((group) => ({
    ...group,
    icons: [...group.icons].sort(
      (left, right) =>
        pioneerDriveTypeOrder[left.libraryType] - pioneerDriveTypeOrder[right.libraryType]
    )
  }))
}
