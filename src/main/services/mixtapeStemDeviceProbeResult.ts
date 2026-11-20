export const STEM_DEVICE_PROBE_CACHE_TTL_MS = 5 * 60 * 1000
export const STEM_DEVICE_PROBE_NEGATIVE_CACHE_TTL_MS = 15_000

export const DEMUCS_DEVICE_PROBE_PYTHON_SCRIPT = [
  'import json',
  'import sys',
  '',
  'def emit(payload):',
  '    print(json.dumps(payload), flush=True)',
  '',
  'payload = {',
  '  "stage": "final",',
  '  "import_ok": False,',
  '  "cuda": False,',
  '  "mps": False,',
  '  "xpu": False,',
  '  "xpu_backend_installed": False,',
  '  "directml": False,',
  '  "directml_backend_installed": False,',
  '  "directml_device": "",',
  '  "torch_version": ""',
  '}',
  'try:',
  '  import torch',
  '  torch_version = str(getattr(torch, "__version__", ""))',
  '  payload["torch_version"] = torch_version',
  '  payload["import_ok"] = True',
  '  emit({"stage": "import", "import_ok": True, "torch_version": torch_version})',
  'except Exception as exc:',
  '  payload["import_ok"] = False',
  '  payload["import_error"] = str(exc)',
  '  emit({"stage": "import", "import_ok": False, "import_error": str(exc)})',
  '  emit(payload)',
  '  raise SystemExit(0)',
  'try:',
  '  cuda_api = getattr(torch, "cuda", None)',
  '  payload["cuda"] = bool(cuda_api and cuda_api.is_available())',
  'except Exception as exc:',
  '  payload["cuda_error"] = str(exc)',
  'try:',
  '  mps_backend = getattr(getattr(torch, "backends", None), "mps", None)',
  '  payload["mps"] = bool(mps_backend and mps_backend.is_available())',
  'except Exception as exc:',
  '  payload["mps_error"] = str(exc)',
  'try:',
  '  xpu_api = getattr(torch, "xpu", None)',
  '  xpu_backend_installed = bool(xpu_api) and ("+cpu" not in str(payload.get("torch_version") or "").lower())',
  '  payload["xpu_backend_installed"] = xpu_backend_installed',
  '  payload["xpu"] = bool(xpu_backend_installed and xpu_api and xpu_api.is_available())',
  'except Exception as exc:',
  '  payload["xpu_error"] = str(exc)',
  'try:',
  '  import torch_directml',
  '  payload["directml_backend_installed"] = True',
  '  try:',
  '    dml_device = torch_directml.device()',
  '    payload["directml"] = bool(dml_device)',
  '    payload["directml_device"] = str(dml_device)',
  '  except Exception as exc:',
  '    payload["directml_error"] = str(exc)',
  'except Exception as exc:',
  '  payload["directml_import_error"] = str(exc)',
  'emit(payload)'
].join('\n')

export type DemucsDeviceProbeProcessResult = {
  status: number | null
  stdout: string
  stderr: string
  timedOut: boolean
  error?: string
}

export type ParsedDemucsDeviceProbeOutput = {
  runtimeUsable: boolean
  probeInconclusive: boolean
  importOk: boolean
  torchVersion: string
  cudaAvailable: boolean
  mpsAvailable: boolean
  xpuAvailable: boolean
  xpuBackendInstalled: boolean
  directmlAvailable: boolean
  directmlBackendInstalled: boolean
  directmlDevice: string
  importError: string
  deviceError: string
  probeError: string
}

type ProbeJsonRecord = Record<string, unknown>

const asText = (value: unknown, max = 400) => {
  const text = typeof value === 'string' ? value : value == null ? '' : String(value)
  const trimmed = text.trim()
  if (trimmed.length <= max) return trimmed
  return trimmed.slice(0, max)
}

const parseJsonLines = (stdout: string): ProbeJsonRecord[] => {
  const records: ProbeJsonRecord[] = []
  for (const line of String(stdout || '').split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('{')) continue
    try {
      const parsed = JSON.parse(trimmed) as unknown
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        records.push(parsed as ProbeJsonRecord)
      }
    } catch {
      // Ignore non-JSON probe noise; a later line may still be valid.
    }
  }
  return records
}

const firstErrorText = (record: ProbeJsonRecord | undefined, keys: string[]) => {
  if (!record) return ''
  for (const key of keys) {
    const text = asText(record[key], 400)
    if (text) return text
  }
  return ''
}

export const parseDemucsDeviceProbeOutput = (
  result: DemucsDeviceProbeProcessResult,
  timeoutMs: number
): ParsedDemucsDeviceProbeOutput => {
  const records = parseJsonLines(result.stdout)
  const importStage = [...records].reverse().find((record) => record.stage === 'import')
  const finalRecord =
    [...records].reverse().find((record) => record.stage === 'final') ||
    [...records].reverse().find((record) => record.stage !== 'import') ||
    importStage
  const merged: ProbeJsonRecord = { ...(finalRecord || {}), ...(importStage || {}) }
  const hasImportOkField = records.some((record) => typeof record.import_ok === 'boolean')
  const legacyImportError = hasImportOkField
    ? ''
    : firstErrorText(merged, ['error', 'import_error'])
  const importOk = hasImportOkField
    ? records.some((record) => record.import_ok === true)
    : !legacyImportError && !result.timedOut && result.status === 0 && records.length > 0
  const importError = asText(merged.import_error, 400) || legacyImportError
  const deviceError = [
    firstErrorText(merged, ['cuda_error']),
    firstErrorText(merged, ['mps_error']),
    firstErrorText(merged, ['xpu_error']),
    firstErrorText(merged, ['directml_error']),
    firstErrorText(merged, ['directml_import_error']),
    firstErrorText(merged, ['device_error'])
  ]
    .filter(Boolean)
    .join('; ')
  const timeoutError = result.timedOut ? `probe timed out after ${timeoutMs}ms` : ''
  const processError =
    result.error ||
    (!importOk && !result.timedOut
      ? asText(result.stderr, 400) || (result.status == null ? '' : `probe exit ${result.status}`)
      : '')
  const probeInconclusive = !importOk && !importError && (result.timedOut || records.length === 0)
  const probeError = importError || timeoutError || deviceError || processError
  return {
    runtimeUsable: importOk,
    probeInconclusive,
    importOk,
    torchVersion: asText(merged.torch_version, 80),
    cudaAvailable: !!merged.cuda,
    mpsAvailable: !!merged.mps,
    xpuAvailable: !!merged.xpu,
    xpuBackendInstalled: !!merged.xpu_backend_installed,
    directmlAvailable: !!merged.directml,
    directmlBackendInstalled: !!merged.directml_backend_installed,
    directmlDevice: asText(merged.directml_device, 80),
    importError,
    deviceError,
    probeError: asText(probeError, 400)
  }
}

export const resolveStemDeviceProbeCacheTtlMs = (snapshot: {
  runtimeUsable: boolean
  probeInconclusive?: boolean
}) => {
  if (snapshot.runtimeUsable) return STEM_DEVICE_PROBE_CACHE_TTL_MS
  if (snapshot.probeInconclusive) return 0
  return STEM_DEVICE_PROBE_NEGATIVE_CACHE_TTL_MS
}

export const resolveLoggedRuntimePath = (filePath: string) => {
  const normalized = String(filePath || '').replace(/\\/g, '/')
  const parts = normalized.split('/').filter(Boolean)
  return parts.slice(-3).join('/') || normalized
}

export const truncateProbeLogText = (value: unknown, max = 400) => asText(value, max)
