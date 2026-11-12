/**
 * 网格分析模式（Normal / Dynamic）。
 *
 * - Normal：现有 120 秒扫描与固定网格路径，默认值。
 * - Dynamic：全曲扫描后输出固定网格或分段网格，仍属实验能力。
 *
 * 该模块只放纯函数与常量，主进程、renderer 与测试共用。
 */

export type AnalysisGridMode = 'normal' | 'dynamic'

export const DEFAULT_ANALYSIS_GRID_MODE: AnalysisGridMode = 'normal'

export const ANALYSIS_GRID_MODES: readonly AnalysisGridMode[] = ['normal', 'dynamic']

export const isAnalysisGridMode = (value: unknown): value is AnalysisGridMode =>
  value === 'normal' || value === 'dynamic'

/**
 * 缺失/非法值回退到调用方给出的默认值。
 * 调用方必须传入“有效默认值”（例如当前全局设置），不能先用 normal 覆盖全局 dynamic。
 */
export const normalizeAnalysisGridMode = (
  value: unknown,
  defaultMode: AnalysisGridMode = DEFAULT_ANALYSIS_GRID_MODE
): AnalysisGridMode => (isAnalysisGridMode(value) ? value : defaultMode)

/** 依次取第一个合法模式；全部缺失时回退 normal。 */
export const resolveAnalysisGridMode = (...candidates: unknown[]): AnalysisGridMode => {
  for (const candidate of candidates) {
    if (isAnalysisGridMode(candidate)) return candidate
  }
  return DEFAULT_ANALYSIS_GRID_MODE
}

/**
 * Dynamic 的发布启用开关：这是“允许发布版本使用”，不是“参数已标定”的标记。
 * 打开后打包 release 与开发模式都可选，主进程同样放行；实验性文案保持不变。
 */
export const DYNAMIC_ANALYSIS_GRID_RELEASE_ENABLED = true

/** 保留 isDevelopment 入参以兼容现有调用；可用性统一由发布启用开关决定。 */
export const isDynamicAnalysisGridAvailable = (_options: { isDevelopment: boolean }): boolean =>
  DYNAMIC_ANALYSIS_GRID_RELEASE_ENABLED

/** 主进程与 renderer 共用的请求支持判断：Normal 始终可用，Dynamic 受发布启用开关限制。 */
export const isAnalysisGridModeSupported = (
  mode: AnalysisGridMode,
  options: { isDevelopment: boolean }
): boolean => mode !== 'dynamic' || isDynamicAnalysisGridAvailable(options)

export const ANALYSIS_GRID_MODE_LABEL_KEYS: Record<AnalysisGridMode, string> = {
  normal: 'settings.analysisGridMode.normal',
  dynamic: 'settings.analysisGridMode.dynamic'
}

/** 重新分析弹窗与缓存入口共用的勾选计划（与 TrackReanalysisPlan 结构一致）。 */
export type AnalysisGridReanalysisPlan = {
  key: boolean
  beatGrid: boolean
  waveform: boolean
  energy: boolean
  structure: boolean
}

/**
 * 只有“本次明确要求重算网格”且模式为 Dynamic 时，才走“先计算后替换”的重新分析语义。
 */
export const isDynamicGridReanalysis = (
  plan: AnalysisGridReanalysisPlan,
  mode: AnalysisGridMode
): boolean => mode === 'dynamic' && plan.beatGrid === true

/**
 * Dynamic 重新分析不得先清空旧网格：保留旧 BPM/网格直到新结果成功。
 * 段落本期未适配 Dynamic，保留旧段落结果；能量仍在范围内，但网格改变后由签名失效，
 * 不在这里删除旧缓存。
 */
export const resolveGridReanalysisClearPlan = (
  plan: AnalysisGridReanalysisPlan,
  mode: AnalysisGridMode
): AnalysisGridReanalysisPlan => {
  if (!isDynamicGridReanalysis(plan, mode)) return { ...plan }
  return {
    key: plan.key,
    beatGrid: false,
    waveform: plan.waveform,
    energy: false,
    structure: false
  }
}

export type AnalysisGridReanalysisTargets = {
  key: boolean
  bpm: boolean
  waveform: boolean
  energy: boolean
  structure: boolean
}

/**
 * Dynamic 重新分析必须显式要求 BPM 目标（配合 forceAnalysis 绕过 complete-grid / no-bpm 跳过）。
 * 能量仍属本期范围，按用户勾选原样透传给适配实现；只有尚未适配的段落被隔离。
 */
export const resolveGridReanalysisTargets = (
  plan: AnalysisGridReanalysisPlan,
  mode: AnalysisGridMode
): AnalysisGridReanalysisTargets => {
  if (!isDynamicGridReanalysis(plan, mode)) {
    return {
      key: plan.key,
      bpm: plan.beatGrid,
      waveform: plan.waveform,
      energy: plan.energy,
      structure: plan.structure
    }
  }
  return {
    key: plan.key,
    bpm: true,
    waveform: plan.waveform,
    energy: plan.energy,
    structure: false
  }
}

/** Dynamic 网格重新分析必须强制计算目标，不能被已有完整缓存或 no-bpm 跳过。 */
export const shouldForceGridReanalysis = (
  plan: AnalysisGridReanalysisPlan,
  mode: AnalysisGridMode
): boolean => isDynamicGridReanalysis(plan, mode)
