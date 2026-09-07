import type {
  RawWaveformData,
  RawWaveformLevel,
  RenderTilePayload,
  SerializedWorkerVisibleGridLine,
  SerializedWorkerTrackTempoSnapshot,
  StemWaveformData,
  WaveformStemId
} from './mixtapeWaveformRender.types'
import { GRID_BEAT_LINE_WIDTH } from '../composables/mixtape/constants'
import { resolveMixtapeTrackLoopTileSections } from '../composables/mixtape/mixtapeTrackLoop'
import { createTrackTimeMapFromSnapshotPayload } from '../composables/mixtape/trackTimeMapFactory'
import { resolveRoundedTrackLocalPx } from '../composables/mixtape/timelinePixelMath'
import { resizeCanvasWithScaleMetrics } from '../utils/canvasScale'

type CreateTileRendererOptions = {
  stemWaveformCache: Map<string, StemWaveformData>
  rawCache: Map<string, RawWaveformData>
  rawPyramidCache: Map<string, RawWaveformLevel[]>
  rawWaveformMinZoom: number
  waveformHeightScale: number
  summaryZoom: number
  postToMain: (message: unknown, transfer?: Transferable[]) => void
}

export const createTileRenderer = (options: CreateTileRendererOptions) => {
  const {
    stemWaveformCache,
    rawCache,
    rawPyramidCache,
    rawWaveformMinZoom,
    waveformHeightScale,
    summaryZoom,
    postToMain
  } = options

  let tileCanvas: OffscreenCanvas | null = null
  let tileCtx: OffscreenCanvasRenderingContext2D | null = null
  let scratchCanvas: OffscreenCanvas | null = null
  let scratchCtx: OffscreenCanvasRenderingContext2D | null = null
  const normalizedWaveformHeightScale = Math.max(0.2, Math.min(1, waveformHeightScale))

  const STEM_WAVEFORM_COLORS: Record<WaveformStemId, { r: number; g: number; b: number }> = {
    vocal: { r: 59, g: 130, b: 246 },
    inst: { r: 20, g: 184, b: 166 },
    bass: { r: 168, g: 85, b: 247 },
    drums: { r: 249, g: 115, b: 22 }
  }
  const STEM_WAVEFORM_MAIN_ALPHA = 0.96
  const STEM_WAVEFORM_RAW_ALPHA = 1
  const resolveStemWaveformColor = (stemId?: WaveformStemId) =>
    STEM_WAVEFORM_COLORS[stemId || 'inst'] || STEM_WAVEFORM_COLORS.inst

  const ensureCanvas = (
    target: OffscreenCanvas | null,
    ctx: OffscreenCanvasRenderingContext2D | null,
    width: number,
    height: number,
    pixelRatio: number
  ) => {
    const safeWidth = Math.max(1, Math.floor(width))
    const safeHeight = Math.max(1, Math.floor(height))
    if (!target) {
      target = new OffscreenCanvas(safeWidth, safeHeight)
      ctx = target.getContext('2d')
    }
    if (ctx) {
      resizeCanvasWithScaleMetrics(target, ctx, safeWidth, safeHeight, pixelRatio)
    }
    return { canvas: target, ctx }
  }

  const ensureScratch = (width: number, height: number) => {
    if (!scratchCanvas) {
      scratchCanvas = new OffscreenCanvas(
        Math.max(1, Math.floor(width)),
        Math.max(1, Math.floor(height))
      )
      scratchCtx = scratchCanvas.getContext('2d')
    } else if (
      scratchCanvas.width !== Math.max(1, Math.floor(width)) ||
      scratchCanvas.height !== Math.max(1, Math.floor(height))
    ) {
      scratchCanvas.width = Math.max(1, Math.floor(width))
      scratchCanvas.height = Math.max(1, Math.floor(height))
    }
    if (scratchCtx) {
      scratchCtx.setTransform(1, 0, 0, 1, 0, 0)
      scratchCtx.clearRect(0, 0, scratchCanvas.width, scratchCanvas.height)
    }
    return { canvas: scratchCanvas, ctx: scratchCtx }
  }

  const buildRawWaveformPyramid = (raw: RawWaveformData): RawWaveformLevel[] => {
    const levels: RawWaveformLevel[] = []
    const base: RawWaveformLevel = { ...raw, factor: 1 }
    levels.push(base)
    let current = base
    while (current.frames > 256 && levels.length < 8) {
      const nextFrames = Math.floor(current.frames / 2)
      if (nextFrames <= 1) break
      const minLeft = new Float32Array(nextFrames)
      const maxLeft = new Float32Array(nextFrames)
      const minRight = new Float32Array(nextFrames)
      const maxRight = new Float32Array(nextFrames)
      const meanLeft = current.meanLeft ? new Float32Array(nextFrames) : undefined
      const meanRight = current.meanRight ? new Float32Array(nextFrames) : undefined
      const rmsLeft = current.rmsLeft ? new Float32Array(nextFrames) : undefined
      const rmsRight = current.rmsRight ? new Float32Array(nextFrames) : undefined
      for (let i = 0; i < nextFrames; i += 1) {
        const i0 = i * 2
        const i1 = Math.min(current.frames - 1, i0 + 1)
        minLeft[i] = Math.min(current.minLeft[i0] ?? 0, current.minLeft[i1] ?? 0)
        maxLeft[i] = Math.max(current.maxLeft[i0] ?? 0, current.maxLeft[i1] ?? 0)
        minRight[i] = Math.min(current.minRight[i0] ?? 0, current.minRight[i1] ?? 0)
        maxRight[i] = Math.max(current.maxRight[i0] ?? 0, current.maxRight[i1] ?? 0)
        if (meanLeft && current.meanLeft) {
          meanLeft[i] = ((current.meanLeft[i0] ?? 0) + (current.meanLeft[i1] ?? 0)) / 2
        }
        if (meanRight && current.meanRight) {
          meanRight[i] = ((current.meanRight[i0] ?? 0) + (current.meanRight[i1] ?? 0)) / 2
        }
        if (rmsLeft && current.rmsLeft) {
          const left0 = current.rmsLeft[i0] ?? 0
          const left1 = current.rmsLeft[i1] ?? 0
          rmsLeft[i] = Math.sqrt((left0 * left0 + left1 * left1) / 2)
        }
        if (rmsRight && current.rmsRight) {
          const right0 = current.rmsRight[i0] ?? 0
          const right1 = current.rmsRight[i1] ?? 0
          rmsRight[i] = Math.sqrt((right0 * right0 + right1 * right1) / 2)
        }
      }
      const next: RawWaveformLevel = {
        duration: current.duration,
        sampleRate: current.sampleRate,
        rate: current.rate / 2,
        frames: nextFrames,
        minLeft,
        maxLeft,
        minRight,
        maxRight,
        meanLeft,
        meanRight,
        rmsLeft,
        rmsRight,
        factor: current.factor * 2
      }
      levels.push(next)
      current = next
    }
    return levels
  }

  const resolveRawWaveformLevel = (
    filePath: string,
    raw: RawWaveformData,
    samplesPerPixel: number
  ) => {
    let levels = rawPyramidCache.get(filePath)
    if (!levels) {
      levels = buildRawWaveformPyramid(raw)
      rawPyramidCache.set(filePath, levels)
    }
    if (!levels.length) return raw
    if (!Number.isFinite(samplesPerPixel) || samplesPerPixel <= 1) return levels[0]
    let target = 1
    while (target * 2 <= samplesPerPixel && target < 128) {
      target *= 2
    }
    let best = levels[0]
    let bestDiff = Math.abs(best.factor - target)
    for (const level of levels) {
      const diff = Math.abs(level.factor - target)
      if (diff < bestDiff) {
        best = level
        bestDiff = diff
      }
    }
    return best
  }

  const drawStemWaveform = (
    ctx: OffscreenCanvasRenderingContext2D,
    width: number,
    height: number,
    waveformData: StemWaveformData | null,
    pixelRatio: number,
    stemId: WaveformStemId,
    range: {
      startFrame: number
      endFrame: number
      startTime: number
      endTime: number
      raw?: RawWaveformData | null
    }
  ) => {
    if (width <= 0 || height <= 0) return

    const rawData = range.raw || null
    const rawMinLeft = rawData?.minLeft || null
    const rawMaxLeft = rawData?.maxLeft || null
    const rawMinRight = rawData?.minRight || null
    const rawMaxRight = rawData?.maxRight || null
    const rawRate = Number(rawData?.rate || 0)
    const rawStartTime = Number(range.startTime || 0)
    const rawEndTime = Number(range.endTime || 0)
    const rawSpan = rawEndTime - rawStartTime
    const hasRaw =
      rawData &&
      rawMinLeft &&
      rawMaxLeft &&
      rawMinRight &&
      rawMaxRight &&
      rawRate > 0 &&
      Number.isFinite(rawSpan) &&
      rawSpan > 0

    const all = waveformData?.all || null
    const peakLeft = all ? all.peakLeft || all.left : null
    const peakRight = all ? all.peakRight || all.right : null
    const frameCount = all
      ? Math.min(all.left.length, all.right.length, peakLeft?.length || 0, peakRight?.length || 0)
      : 1
    if (!hasRaw && (!all || !peakLeft || !peakRight || frameCount <= 0)) return

    const rawStart = Number.isFinite(range.startFrame) ? range.startFrame : 0
    const rawEnd = Number.isFinite(range.endFrame) ? range.endFrame : frameCount
    const startFrame = Math.max(0, Math.min(frameCount - 1, Math.floor(rawStart)))
    const endFrame = Math.max(startFrame + 1, Math.min(frameCount, Math.ceil(rawEnd)))
    const visibleFrames = endFrame - startFrame
    if (visibleFrames <= 0) return

    const length = Math.max(1, Math.floor(width * pixelRatio))
    const halfBreadth = height / 2
    const heightFactor = (halfBreadth * normalizedWaveformHeightScale) / 255
    const rawHeightFactor = halfBreadth * normalizedWaveformHeightScale
    const pixelWidth = 1 / pixelRatio
    const stemColor = resolveStemWaveformColor(stemId)
    ctx.globalCompositeOperation = 'source-over'
    ctx.imageSmoothingEnabled = false

    const amplitudes = new Float32Array(length)
    const gain = (visibleFrames * 2) / length
    const offset = startFrame * 2
    const useInterpolatedSamples = gain <= 2
    const rawFrames = hasRaw
      ? Math.min(rawMinLeft.length, rawMaxLeft.length, rawMinRight.length, rawMaxRight.length)
      : 0
    const rawStartPos = hasRaw ? rawStartTime * rawRate : 0
    const rawEndPos = hasRaw ? rawEndTime * rawRate : 0
    const rawVisible = hasRaw ? Math.max(1, rawEndPos - rawStartPos) : 0
    const lerp = (a: number, b: number, t: number) => a + (b - a) * t

    if (hasRaw && rawMinLeft && rawMaxLeft && rawMinRight && rawMaxRight && rawFrames > 1) {
      for (let x = 0; x < length; x += 1) {
        const rawPos = rawStartPos + (x / Math.max(1, length - 1)) * rawVisible
        const rawIndex = Math.max(0, Math.min(rawFrames - 1, rawPos))
        const i0 = Math.floor(rawIndex)
        const i1 = Math.min(rawFrames - 1, i0 + 1)
        const t = rawIndex - i0
        const rawMinLeftValue = lerp(rawMinLeft[i0] || 0, rawMinLeft[i1] || 0, t)
        const rawMaxLeftValue = lerp(rawMaxLeft[i0] || 0, rawMaxLeft[i1] || 0, t)
        const rawMinRightValue = lerp(rawMinRight[i0] || 0, rawMinRight[i1] || 0, t)
        const rawMaxRightValue = lerp(rawMaxRight[i0] || 0, rawMaxRight[i1] || 0, t)
        const monoPeak = Math.max(
          Math.abs(rawMinLeftValue),
          Math.abs(rawMaxLeftValue),
          Math.abs(rawMinRightValue),
          Math.abs(rawMaxRightValue)
        )
        amplitudes[x] = monoPeak * rawHeightFactor
      }
    } else {
      if (!peakLeft || !peakRight) return
      for (let x = 0; x < length; x += 1) {
        const xSampleWidth = gain * x
        const xVisualSampleIndex = xSampleWidth + offset
        const maxSamplingRange = gain / 2
        let monoAmp = 0
        if (useInterpolatedSamples) {
          const framePos = Math.max(startFrame, Math.min(endFrame - 1, xVisualSampleIndex / 2))
          const i0 = Math.floor(framePos)
          const i1 = Math.min(endFrame - 1, i0 + 1)
          const t = framePos - i0
          const mono0 = Math.max(peakLeft[i0] || 0, peakRight[i0] || 0)
          const mono1 = Math.max(peakLeft[i1] || mono0, peakRight[i1] || mono0)
          monoAmp = lerp(mono0, mono1, t)
        } else {
          let visualFrameStart = Math.floor(xVisualSampleIndex / 2 - maxSamplingRange + 0.5)
          let visualFrameStop = Math.floor(xVisualSampleIndex / 2 + maxSamplingRange + 0.5)
          visualFrameStart = Math.max(startFrame, Math.min(endFrame - 1, visualFrameStart))
          visualFrameStop = Math.max(startFrame, Math.min(endFrame - 1, visualFrameStop))
          if (visualFrameStop < visualFrameStart) {
            const tmp = visualFrameStop
            visualFrameStop = visualFrameStart
            visualFrameStart = tmp
          }
          for (let i = visualFrameStart; i <= visualFrameStop; i += 1) {
            const peak = Math.max(peakLeft[i] || 0, peakRight[i] || 0)
            if (peak > monoAmp) monoAmp = peak
          }
        }
        amplitudes[x] = monoAmp * heightFactor
      }
    }

    const drawMonoBand = (alpha: number) => {
      ctx.fillStyle = `rgba(${stemColor.r}, ${stemColor.g}, ${stemColor.b}, ${alpha})`
      for (let x = 0; x < length - 1; x += 1) {
        const curAmp = amplitudes[x] || 0
        const nextAmp = amplitudes[x + 1] || curAmp
        const x0 = x * pixelWidth
        const x1 = (x + 1) * pixelWidth

        ctx.beginPath()
        ctx.moveTo(x0, halfBreadth - curAmp)
        ctx.lineTo(x1, halfBreadth - nextAmp)
        ctx.lineTo(x1, halfBreadth + nextAmp)
        ctx.lineTo(x0, halfBreadth + curAmp)
        ctx.closePath()
        ctx.fill()
      }
    }

    if (hasRaw) {
      drawMonoBand(STEM_WAVEFORM_RAW_ALPHA)
    } else {
      drawMonoBand(STEM_WAVEFORM_MAIN_ALPHA)
    }
    ctx.globalAlpha = 1
  }

  const renderEmptyPlaceholder = (
    ctx: OffscreenCanvasRenderingContext2D,
    width: number,
    height: number
  ) => {
    ctx.strokeStyle = 'rgba(128, 128, 128, 0.3)'
    ctx.setLineDash([4, 4])
    const midY = height / 2
    ctx.beginPath()
    ctx.moveTo(0, midY)
    ctx.lineTo(width, midY)
    ctx.stroke()
    ctx.setLineDash([])
  }

  const renderSummaryBar = (
    ctx: OffscreenCanvasRenderingContext2D,
    width: number,
    height: number
  ) => {
    const barHeight = Math.max(4, Math.round(height * 0.55 * normalizedWaveformHeightScale))
    const y = Math.round((height - barHeight) / 2)
    ctx.fillStyle = 'rgba(120, 205, 255, 0.52)'
    ctx.fillRect(0, y, width, barHeight)
  }

  const createTimeMapFromTempoSnapshot = (tempoSnapshot: SerializedWorkerTrackTempoSnapshot) =>
    createTrackTimeMapFromSnapshotPayload({
      signature: String(tempoSnapshot.signature || ''),
      durationSec: Number(tempoSnapshot.durationSec) || 0,
      baseDurationSec:
        Number(tempoSnapshot.baseDurationSec) || Number(tempoSnapshot.durationSec) || 0,
      sourceDurationSec: Number(tempoSnapshot.sourceDurationSec) || 0,
      baseBpm: Number(tempoSnapshot.baseBpm) || 128,
      gridSourceBpm: Number(tempoSnapshot.gridSourceBpm) || 0,
      originalBpm: Number(tempoSnapshot.originalBpm) || 0,
      firstBeatSourceSec: Number(tempoSnapshot.firstBeatSourceSec) || 0,
      beatSourceSec: Number(tempoSnapshot.beatSourceSec) || 0,
      downbeatBeatOffset: Number(tempoSnapshot.downbeatBeatOffset) || 0,
      sourceBeatGridMap: tempoSnapshot.sourceBeatGridMap,
      mappingMode: tempoSnapshot.mappingMode,
      trackStartSec: Number(tempoSnapshot.trackStartSec) || 0,
      masterGridFallbackBpm: Number(tempoSnapshot.masterGridFallbackBpm) || 128,
      masterGridPhaseOffsetSec: Number(tempoSnapshot.masterGridPhaseOffsetSec) || 0,
      masterGridPoints: Array.isArray(tempoSnapshot.masterGridPoints)
        ? tempoSnapshot.masterGridPoints.map((point) => ({
            sec: Number(point.sec),
            bpm: Number(point.bpm)
          }))
        : undefined,
      loopSegments: Array.isArray(tempoSnapshot.loopSegments)
        ? tempoSnapshot.loopSegments.map((segment) => ({
            startSec: Number(segment.startSec),
            endSec: Number(segment.endSec),
            repeatCount: Number(segment.repeatCount)
          }))
        : undefined,
      loopSegment: tempoSnapshot.loopSegment
        ? {
            startSec: Number(tempoSnapshot.loopSegment.startSec),
            endSec: Number(tempoSnapshot.loopSegment.endSec),
            repeatCount: Number(tempoSnapshot.loopSegment.repeatCount)
          }
        : Array.isArray(tempoSnapshot.loopSegments) && tempoSnapshot.loopSegments[0]
          ? {
              startSec: Number(tempoSnapshot.loopSegments[0].startSec),
              endSec: Number(tempoSnapshot.loopSegments[0].endSec),
              repeatCount: Number(tempoSnapshot.loopSegments[0].repeatCount)
            }
          : undefined,
      controlPoints: tempoSnapshot.controlPoints.map((point) => ({
        sec: Number(point.sec),
        bpm: Number(point.bpm),
        sourceSec:
          Number.isFinite(Number(point.sourceSec)) && Number(point.sourceSec) >= 0
            ? Number(point.sourceSec)
            : undefined,
        allowOffGrid: point.allowOffGrid === true ? true : undefined
      }))
    })

  const renderTileBitmap = (payload: RenderTilePayload): ImageBitmap | null => {
    const {
      filePath,
      stemId,
      zoom,
      tileStart,
      tileWidth,
      trackWidth,
      durationSeconds,
      tempoSnapshot,
      laneHeight,
      pixelRatio
    } = payload
    const waveform = stemWaveformCache.get(filePath)
    const rawData = zoom >= rawWaveformMinZoom ? rawCache.get(filePath) || null : null

    const ensured = ensureCanvas(tileCanvas, tileCtx, tileWidth, laneHeight, pixelRatio)
    tileCanvas = ensured.canvas
    tileCtx = ensured.ctx
    if (!tileCanvas || !tileCtx) return null

    const loopValue =
      Array.isArray(tempoSnapshot.loopSegments) && tempoSnapshot.loopSegments.length
        ? tempoSnapshot.loopSegments
        : tempoSnapshot.loopSegment
    const hasLoopSegment = !!loopValue
    if (!hasLoopSegment && zoom <= summaryZoom + 0.0001) {
      renderSummaryBar(tileCtx, tileWidth, laneHeight)
      return tileCanvas.transferToImageBitmap()
    }

    if (!waveform && !rawData) {
      renderEmptyPlaceholder(tileCtx, tileWidth, laneHeight)
      return tileCanvas.transferToImageBitmap()
    }

    const all = waveform?.all || null
    const frameCount = all ? Math.min(all.left.length, all.right.length) : 1
    if (!trackWidth || frameCount <= 0) {
      renderEmptyPlaceholder(tileCtx, tileWidth, laneHeight)
      return tileCanvas.transferToImageBitmap()
    }

    const rawDurationSeconds =
      rawData && Number.isFinite(rawData.duration) && rawData.duration > 0 ? rawData.duration : 0
    const waveformDurationSeconds = rawDurationSeconds > 0 ? rawDurationSeconds : durationSeconds
    const safeTimelineDurationSeconds = Math.max(0, Number(tempoSnapshot.durationSec) || 0)
    const baseDurationSeconds = Math.max(
      0,
      Number(tempoSnapshot.baseDurationSec || safeTimelineDurationSeconds) || 0
    )
    const timeMap = createTimeMapFromTempoSnapshot(tempoSnapshot)
    const localStartSec = safeTimelineDurationSeconds
      ? (tileStart / Math.max(1, trackWidth)) * safeTimelineDurationSeconds
      : 0
    const localEndSec = safeTimelineDurationSeconds
      ? ((tileStart + tileWidth) / Math.max(1, trackWidth)) * safeTimelineDurationSeconds
      : 0
    const localSpanSec = Math.max(0.0001, localEndSec - localStartSec)
    const loopSections = resolveMixtapeTrackLoopTileSections({
      localStartSec,
      localEndSec,
      baseDurationSec: baseDurationSeconds,
      loopSegments: Array.isArray(tempoSnapshot.loopSegments)
        ? tempoSnapshot.loopSegments
        : undefined,
      loopSegment: tempoSnapshot.loopSegment
    })

    const drawSectionWaveform = (
      targetCtx: OffscreenCanvasRenderingContext2D,
      targetWidth: number,
      section: {
        kind?: string
        displayStartSec: number
        displayEndSec: number
        baseStartSec: number
        baseEndSec: number
      }
    ) => {
      const startTime = waveformDurationSeconds ? timeMap.mapLocalToSource(section.baseStartSec) : 0
      const endTime = waveformDurationSeconds ? timeMap.mapLocalToSource(section.baseEndSec) : 0
      const rawSpan = Math.max(0, endTime - startTime)
      const rawSamplesPerPixel =
        rawData && rawSpan > 0
          ? (rawData.rate * rawSpan) / Math.max(1, targetWidth * pixelRatio)
          : 0
      const resolvedRaw =
        rawData && rawSamplesPerPixel > 0
          ? resolveRawWaveformLevel(filePath, rawData, rawSamplesPerPixel)
          : rawData
      const startFrame =
        baseDurationSeconds > 0
          ? Math.floor((section.baseStartSec / Math.max(0.0001, baseDurationSeconds)) * frameCount)
          : 0
      const endFrame =
        baseDurationSeconds > 0
          ? Math.ceil((section.baseEndSec / Math.max(0.0001, baseDurationSeconds)) * frameCount)
          : frameCount
      drawStemWaveform(targetCtx, targetWidth, laneHeight, waveform || null, pixelRatio, stemId, {
        startFrame,
        endFrame,
        startTime,
        endTime,
        raw: resolvedRaw
      })
    }

    const drawLoopAwareWaveform = (
      targetCtx: OffscreenCanvasRenderingContext2D,
      targetWidth: number
    ) => {
      const sectionCanvasCache = new Map<string, OffscreenCanvas>()
      const buildSectionCacheKey = (
        section: {
          baseStartSec: number
          baseEndSec: number
        },
        sectionWidth: number
      ) =>
        [
          filePath,
          stemId,
          Math.round(section.baseStartSec * 1000),
          Math.round(section.baseEndSec * 1000),
          Math.max(1, Math.round(sectionWidth))
        ].join(':')

      const getOrCreateSectionCanvas = (
        section: {
          kind?: string
          displayStartSec: number
          displayEndSec: number
          baseStartSec: number
          baseEndSec: number
        },
        sectionWidth: number
      ) => {
        const cacheKey = buildSectionCacheKey(section, sectionWidth)
        const cachedCanvas = sectionCanvasCache.get(cacheKey)
        if (cachedCanvas) return cachedCanvas
        const cacheCanvas = new OffscreenCanvas(sectionWidth, laneHeight)
        const cacheCtx = cacheCanvas.getContext('2d')
        if (!cacheCtx) return null
        drawSectionWaveform(cacheCtx, sectionWidth, {
          ...section,
          displayStartSec: section.baseStartSec,
          displayEndSec: section.baseEndSec
        })
        sectionCanvasCache.set(cacheKey, cacheCanvas)
        return cacheCanvas
      }

      for (const section of loopSections) {
        const sectionStartRatio = (section.displayStartSec - localStartSec) / localSpanSec
        const sectionEndRatio = (section.displayEndSec - localStartSec) / localSpanSec
        const sectionStartX = Math.max(0, Math.floor(sectionStartRatio * targetWidth))
        const sectionEndX = Math.min(targetWidth, Math.ceil(sectionEndRatio * targetWidth))
        const sectionWidth = Math.max(1, sectionEndX - sectionStartX)
        targetCtx.save()
        targetCtx.translate(sectionStartX, 0)
        if (section.kind === 'loop-source' || section.kind === 'loop-repeat') {
          const cachedCanvas = getOrCreateSectionCanvas(section, sectionWidth)
          if (cachedCanvas) {
            targetCtx.drawImage(cachedCanvas, 0, 0, sectionWidth, laneHeight)
          } else {
            drawSectionWaveform(targetCtx, sectionWidth, section)
          }
        } else {
          drawSectionWaveform(targetCtx, sectionWidth, section)
        }
        targetCtx.restore()
      }
    }

    const renderScale = 1
    if (renderScale > 1) {
      const scratch = ensureScratch(tileWidth * renderScale, laneHeight)
      if (scratch && scratch.ctx) {
        drawLoopAwareWaveform(scratch.ctx, tileWidth * renderScale)
        tileCtx.save()
        tileCtx.imageSmoothingEnabled = false
        tileCtx.clearRect(0, 0, tileWidth, laneHeight)
        tileCtx.drawImage(
          scratch.canvas,
          0,
          0,
          scratch.canvas.width,
          scratch.canvas.height,
          0,
          0,
          tileWidth,
          laneHeight
        )
        tileCtx.restore()
        return tileCanvas.transferToImageBitmap()
      }
    }

    drawLoopAwareWaveform(tileCtx, tileWidth)
    return tileCanvas.transferToImageBitmap()
  }

  const renderTileMessage = (payload: RenderTilePayload) => {
    const bitmap = renderTileBitmap(payload)
    if (!bitmap) return
    postToMain({ type: 'rendered', cacheKey: payload.cacheKey, bitmap }, [bitmap])
  }

  const drawTrackGridLines = (
    ctx: OffscreenCanvasRenderingContext2D,
    width: number,
    height: number,
    track: {
      tempoSnapshot: SerializedWorkerTrackTempoSnapshot
      trackWidth: number
      durationSeconds: number
      startSec: number
      visibleGridLines?: SerializedWorkerVisibleGridLine[]
    },
    renderPxPerSec: number,
    range: { start: number; end: number },
    showDownbeat: boolean,
    showBeat: boolean,
    downbeatWidth: number
  ) => {
    const trackWidth = Math.max(0, Number(track.trackWidth) || 0)
    const timelineDurationSeconds = Math.max(0, Number(track.tempoSnapshot.durationSec) || 0)
    const sourceDurationSeconds = Math.max(0, Number(track.durationSeconds) || 0)
    const startX = range.start
    const endX = range.end
    if (endX <= startX || width <= 0 || height <= 0 || trackWidth <= 0) return
    if (timelineDurationSeconds <= 0 || sourceDurationSeconds <= 0) return
    const visibleGridLines = Array.isArray(track.visibleGridLines)
      ? track.visibleGridLines
      : createTimeMapFromTempoSnapshot(track.tempoSnapshot).buildVisibleGridLines(
          Number.POSITIVE_INFINITY
        )
    ctx.save()
    if (visibleGridLines.length) {
      for (const line of visibleGridLines) {
        const level = line.level
        if (!showDownbeat && level === 'downbeat') continue
        if (!showBeat && level === 'beat') continue
        const rawX = resolveRoundedTrackLocalPx({
          trackStartSec: Number(track.startSec) || 0,
          localSec: line.sec,
          pxPerSec: renderPxPerSec
        })
        if (rawX < startX - 64 || rawX > endX + 64) continue
        const lineWidth = level === 'downbeat' ? downbeatWidth : GRID_BEAT_LINE_WIDTH
        const x = rawX - startX - lineWidth / 2
        if (level === 'downbeat') {
          ctx.globalAlpha = 0.85
          ctx.fillStyle = 'rgba(120, 200, 255, 0.98)'
          ctx.fillRect(x, 0, lineWidth, height)
        } else {
          ctx.globalAlpha = 0.8
          ctx.fillStyle = 'rgba(180, 225, 255, 0.95)'
          ctx.fillRect(x, 0, lineWidth, height)
        }
      }
    }
    const sourceBeatGridMap = track.tempoSnapshot.sourceBeatGridMap
    if (sourceBeatGridMap?.clips.length && sourceBeatGridMap.clips.length > 1) {
      const timeMap = createTimeMapFromTempoSnapshot(track.tempoSnapshot)
      ctx.globalAlpha = 0.9
      ctx.fillStyle = 'rgba(255, 214, 92, 0.96)'
      const boundaryWidth = Math.max(1.5, downbeatWidth + 0.5)
      for (const clip of sourceBeatGridMap.clips.slice(1)) {
        const localSec = timeMap.mapSourceToLocal(clip.startSec)
        const rawX = resolveRoundedTrackLocalPx({
          trackStartSec: Number(track.startSec) || 0,
          localSec,
          pxPerSec: renderPxPerSec
        })
        if (rawX < startX - 64 || rawX > endX + 64) continue
        ctx.fillRect(rawX - startX - boundaryWidth / 2, 0, boundaryWidth, height)
      }
    }
    ctx.restore()
  }

  return {
    buildRawWaveformPyramid,
    renderTileBitmap,
    renderTileMessage,
    drawTrackGridLines
  }
}
