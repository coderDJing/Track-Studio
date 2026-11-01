import type { IPioneerPlaylistTreeNode } from '../../../../types/globals'
import { t } from '@renderer/utils/translate'

// “全部曲目”节点由主进程用固定名称生成，展示时按当前语言替换
export const getPlaylistNodeDisplayName = (
  node: Pick<IPioneerPlaylistTreeNode, 'name' | 'isAllTracks'> | null | undefined
): string => {
  if (!node) return ''
  if (node.isAllTracks) return t('pioneer.allTracks')
  return node.name || ''
}
