import { computed, ref, type Ref } from 'vue'
import type { ISongsAreaColumn } from '../../../../../../types/globals'

// 拖动表头时只换歌曲行的显示顺序，松手后的 update:columns 才提交并落盘。
export function useColumnDragPreview(visibleColumns: Ref<ISongsAreaColumn[]>) {
  const columnDragPreview = ref<ISongsAreaColumn[] | null>(null)
  const rowsVisibleColumns = computed(() => columnDragPreview.value ?? visibleColumns.value)
  const handleColumnDragPreview = (columns: ISongsAreaColumn[] | null) => {
    columnDragPreview.value = columns && columns.length > 0 ? columns : null
  }
  return {
    rowsVisibleColumns,
    handleColumnDragPreview
  }
}
