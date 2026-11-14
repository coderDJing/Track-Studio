import confirm from '@renderer/components/confirmDialog'
import { useAnalysisRuntimeDownload } from '@renderer/composables/useAnalysisRuntimeDownload'
import { useRuntimeStore } from '@renderer/stores/runtime'
import { t } from '@renderer/utils/translate'
import {
  requiresAnalysisRuntime,
  type TrackReanalysisUserSelection
} from '@shared/trackReanalysisSelection'

/**
 * 重新分析入口的运行时门禁。
 *
 * 只有本次勾选含节拍网格 / BPM 时才检查运行时：下载中给出下载中提示，
 * 未安装复用既有下载确认框，失败复用既有失败提示。
 * 返回 true 表示可以继续提交；false 表示已向用户给出反馈，本次提交必须中止。
 */
export const ensureAnalysisRuntimeForTrackReanalysis = async (
  selection: TrackReanalysisUserSelection
): Promise<boolean> => {
  if (!requiresAnalysisRuntime(selection)) return true
  const runtime = useRuntimeStore()
  if (runtime.analysisRuntime.available === true) return true
  const { promptAnalysisRuntimeDownload } = useAnalysisRuntimeDownload({
    runtime,
    t,
    confirmDialog: confirm
  })
  return (await promptAnalysisRuntimeDownload('analysis')) === 'ready'
}

/** 主进程兜底拦截时的提示：说清是哪个功能、要哪个组件，不新增“分析失败”措辞。 */
export const showTrackReanalysisRuntimeBlockedHint = async (reason: string) => {
  const downloading = reason === 'analysis-runtime-downloading'
  await confirm({
    title: downloading
      ? t('analysisRuntime.trackAnalysisDownloadingTitle')
      : t('analysisRuntime.unsupportedTitle'),
    content: downloading
      ? [t('analysisRuntime.trackAnalysisDownloadingHint')]
      : [t('analysisRuntime.trackAnalysisBlockedHint')],
    confirmShow: false,
    textAlign: 'left',
    innerWidth: 560,
    innerHeight: 0
  })
}
