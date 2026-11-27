import { shallowRef } from 'vue'
import type { ISongInfo } from 'src/types/globals'
export const icloudListPresentation = shallowRef<{
  songs: ISongInfo[]
  selected: string[]
  total: number
  page: boolean
} | null>(null)
