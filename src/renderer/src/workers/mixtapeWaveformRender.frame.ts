import { RendererFilePathMap } from '@renderer/utils/filePathComparison'
import type {
  FrameBufferSlot,
  RenderFramePayload,
  RenderTilePayload,
  WaveformStemId
} from './mixtapeWaveformRender.types'
import {
  buildWaveformTileCacheKey,
  resolveFrameBufferMultiplier,
  resolveGridDownbeatWidth
} from './mixtapeWaveformRender.cache'
import { resolveCanvasScaleMetrics, resizeCanvasWithScaleMetrics } from '../utils/canvasScale'

type CreateFrameRendererOptions = {
  mixTapeWebglEnabled: boolean
  mixTapeBufferMultiplier: number
  debugTrackLines: boolean
  rawWaveformMinZoom: number
  waveformHeightScale: number
  gridDownbeatLineZoom: number
  gridBeatLineZoom: number
  gridDownbeatWidthMin: number
  gridDownbeatWidthMax: number
  gridDownbeatWidthMaxZoom: number
  waveformTileWidth: number
  renderTileBitmap: (payload: RenderTilePayload) => ImageBitmap | null
  drawTrackGridLines: (
    ctx: OffscreenCanvasRenderingContext2D,
    width: number,
    height: number,
    track: RenderFramePayload['tracks'][number],
    renderPxPerSec: number,
    range: { start: number; end: number },
    showDownbeat: boolean,
    showBeat: boolean,
    downbeatWidth: number
  ) => void
}

export const createFrameRenderer = (options: CreateFrameRendererOptions) => {
  const {
    mixTapeWebglEnabled,
    mixTapeBufferMultiplier,
    debugTrackLines,
    rawWaveformMinZoom,
    waveformHeightScale,
    gridDownbeatLineZoom,
    gridBeatLineZoom,
    gridDownbeatWidthMin,
    gridDownbeatWidthMax,
    gridDownbeatWidthMaxZoom,
    waveformTileWidth,
    renderTileBitmap,
    drawTrackGridLines
  } = options

  let outputCanvas: OffscreenCanvas | null = null
  let outputCtx: OffscreenCanvasRenderingContext2D | null = null

  const frameBufferSlots = new Map<string, FrameBufferSlot>()
  const tileCache = new Map<string, { texture: WebGLTexture; used: number }>()
  const tileCacheIndex = new RendererFilePathMap<Set<string>>()
  let tileCacheTick = 0
  let tileCacheLimit = 260

  let gl: WebGLRenderingContext | WebGL2RenderingContext | null = null
  let glReady = false
  let glProgramTex: WebGLProgram | null = null
  let glProgramColor: WebGLProgram | null = null
  let glQuadBuffer: WebGLBuffer | null = null
  let glTexLocations: {
    aPos: number
    uResolution: WebGLUniformLocation | null
    uRect: WebGLUniformLocation | null
    uTex: WebGLUniformLocation | null
    uTexRect: WebGLUniformLocation | null
  } | null = null
  let glColorLocations: {
    aPos: number
    uResolution: WebGLUniformLocation | null
    uRect: WebGLUniformLocation | null
    uColor: WebGLUniformLocation | null
  } | null = null
  let glActiveProgram: WebGLProgram | null = null

  const touchTileCache = (key: string) => {
    const entry = tileCache.get(key)
    if (!entry) return
    tileCacheTick += 1
    entry.used = tileCacheTick
  }

  const registerTileCacheKey = (filePath: string, key: string) => {
    const set = tileCacheIndex.get(filePath) || new Set<string>()
    set.add(key)
    tileCacheIndex.set(filePath, set)
  }

  const disposeTileCacheEntry = (entry?: { texture: WebGLTexture; used: number } | null) => {
    if (!entry) return
    if (gl && entry.texture) {
      try {
        gl.deleteTexture(entry.texture)
      } catch {}
    }
  }

  const pruneTileCache = () => {
    if (tileCache.size <= tileCacheLimit) return
    const entries = Array.from(tileCache.entries())
    entries.sort((a, b) => a[1].used - b[1].used)
    const removeCount = Math.max(0, tileCache.size - tileCacheLimit)
    for (let i = 0; i < removeCount; i += 1) {
      const [key, entry] = entries[i]
      disposeTileCacheEntry(entry)
      tileCache.delete(key)
      const filePath = key.split('::')[0] || ''
      if (!filePath) continue
      const set = tileCacheIndex.get(filePath)
      if (!set) continue
      set.delete(key)
      if (set.size === 0) {
        tileCacheIndex.delete(filePath)
      }
    }
  }

  const clearTileCacheForFile = (filePath: string) => {
    const keys = tileCacheIndex.get(filePath)
    if (keys) {
      for (const key of keys) {
        const entry = tileCache.get(key)
        disposeTileCacheEntry(entry || null)
        tileCache.delete(key)
      }
      tileCacheIndex.delete(filePath)
    }
  }

  const resolveFrameBufferId = (payload: RenderFramePayload) =>
    payload.bufferId || `z:${Math.round(payload.zoom * 1000)}`

  const createFrameBufferSlot = (): FrameBufferSlot => ({
    key: '',
    startX: 0,
    width: 0,
    height: 0,
    canvas: null,
    ctx: null,
    texture: null,
    texWidth: 0,
    texHeight: 0,
    fbo: null
  })

  const getFrameBufferSlot = (bufferId: string) => {
    const safeId = bufferId || 'default'
    let slot = frameBufferSlots.get(safeId)
    if (!slot) {
      slot = createFrameBufferSlot()
      frameBufferSlots.set(safeId, slot)
    }
    return slot
  }

  const resetFrameBufferSlot = (slot: FrameBufferSlot) => {
    slot.key = ''
    slot.startX = 0
    slot.width = 0
    slot.height = 0
    slot.texWidth = 0
    slot.texHeight = 0
  }

  const disposeFrameBufferSlot = (slot: FrameBufferSlot) => {
    if (gl && slot.texture) {
      try {
        gl.deleteTexture(slot.texture)
      } catch {}
    }
    if (gl && slot.fbo) {
      try {
        gl.deleteFramebuffer(slot.fbo)
      } catch {}
    }
    slot.texture = null
    slot.fbo = null
    slot.canvas = null
    slot.ctx = null
    resetFrameBufferSlot(slot)
  }

  const clearFrameBufferSlots = () => {
    for (const slot of frameBufferSlots.values()) {
      disposeFrameBufferSlot(slot)
    }
    frameBufferSlots.clear()
  }

  const clearAllCaches = () => {
    for (const entry of tileCache.values()) {
      disposeTileCacheEntry(entry)
    }
    tileCache.clear()
    tileCacheIndex.clear()
    tileCacheTick = 0
    clearFrameBufferSlots()
  }

  const ensureOutputCanvas = (width: number, height: number, pixelRatio: number) => {
    if (!outputCanvas) return { canvas: null, ctx: null }
    const metrics = resolveCanvasScaleMetrics(width, height, pixelRatio)
    if (outputCanvas.width !== metrics.scaledWidth) outputCanvas.width = metrics.scaledWidth
    if (outputCanvas.height !== metrics.scaledHeight) outputCanvas.height = metrics.scaledHeight
    if (!outputCtx) {
      outputCtx = outputCanvas.getContext('2d')
    }
    if (outputCtx) {
      resizeCanvasWithScaleMetrics(outputCanvas, outputCtx, width, height, pixelRatio)
    }
    return { canvas: outputCanvas, ctx: outputCtx }
  }

  const ensureBufferCanvas = (
    slot: FrameBufferSlot,
    width: number,
    height: number,
    pixelRatio: number
  ) => {
    const metrics = resolveCanvasScaleMetrics(width, height, pixelRatio)
    if (!slot.canvas) {
      slot.canvas = new OffscreenCanvas(metrics.scaledWidth, metrics.scaledHeight)
      slot.ctx = slot.canvas.getContext('2d')
    } else {
      if (slot.canvas.width !== metrics.scaledWidth) slot.canvas.width = metrics.scaledWidth
      if (slot.canvas.height !== metrics.scaledHeight) slot.canvas.height = metrics.scaledHeight
    }
    if (slot.ctx) {
      resizeCanvasWithScaleMetrics(slot.canvas, slot.ctx, width, height, pixelRatio)
    }
    return { canvas: slot.canvas, ctx: slot.ctx }
  }

  const buildFrameKey = (payload: RenderFramePayload) => {
    const trackSig = payload.tracks
      .map(
        (track) =>
          `${track.id}:${track.waveformFilePath || track.filePath}:${Math.round(track.trackWidth)}:${Math.round(
            Number(track.startX) || 0
          )}:${Math.round((Number(track.startSec) || 0) * 1000)}:${track.laneIndex}:${Math.round(
            Number(track.laneOffsetY) || 0
          )}:${Math.round(Number(track.laneHeight) || payload.laneHeight)}:${track.tempoSnapshot.signature}:${track.visibleGridSignature || ''}`
      )
      .join('|')
    return [
      payload.width,
      payload.height,
      Math.round(payload.zoom * 1000),
      Math.round(payload.laneHeight * 10),
      Math.round(payload.laneGap * 10),
      Math.round(payload.trackContentTop * 10),
      Math.round(payload.lanePaddingTop * 10),
      Math.round(payload.renderPxPerSec * 100),
      Math.round(payload.pixelRatio * 100),
      Math.round(waveformHeightScale * 1000),
      payload.showGridLines ? 1 : 0,
      payload.renderVersion,
      Math.round(payload.startY),
      trackSig
    ].join('::')
  }

  const renderTracksToContextCpu = (
    ctx: OffscreenCanvasRenderingContext2D,
    payload: RenderFramePayload,
    viewStartX: number,
    viewStartY: number,
    viewWidth: number,
    viewHeight: number
  ) => {
    const showGridLines = payload.showGridLines !== false
    const allowTileBuild = payload.allowTileBuild !== false
    const showDownbeatGrid = payload.zoom >= gridDownbeatLineZoom
    const showBeatGrid = payload.zoom >= gridBeatLineZoom
    const downbeatWidth = resolveGridDownbeatWidth({
      zoom: payload.zoom,
      rawWaveformMinZoom,
      gridDownbeatWidthMin,
      gridDownbeatWidthMax,
      gridDownbeatWidthMaxZoom
    })
    const laneStride = payload.laneHeight + payload.laneGap
    const endX = viewStartX + viewWidth

    for (const track of payload.tracks) {
      const filePath = track.waveformFilePath || track.filePath
      if (!filePath) continue
      const trackLaneHeight = Math.max(1, Number(track.laneHeight) || payload.laneHeight)
      const trackLaneOffset = Math.max(0, Number(track.laneOffsetY) || 0)
      const trackWidth = track.trackWidth
      if (!trackWidth || !Number.isFinite(trackWidth)) continue
      const trackStartX = Number(track.startX) || 0
      const trackEndX = trackStartX + trackWidth
      const trackY =
        payload.trackContentTop +
        payload.lanePaddingTop +
        track.laneIndex * laneStride +
        trackLaneOffset -
        viewStartY
      if (trackY > viewHeight || trackY + trackLaneHeight < 0) continue
      const visibleStart = Math.max(trackStartX, viewStartX)
      const visibleEnd = Math.min(trackEndX, endX)
      if (visibleEnd <= visibleStart) continue
      const localStart = visibleStart - trackStartX
      const localEnd = visibleEnd - trackStartX

      const tileStartIndex = Math.max(0, Math.floor(localStart / waveformTileWidth))
      const tileEndIndex = Math.max(
        tileStartIndex,
        Math.floor(Math.max(0, localEnd - 1) / waveformTileWidth)
      )
      for (let tileIndex = tileStartIndex; tileIndex <= tileEndIndex; tileIndex += 1) {
        const tileStart = tileIndex * waveformTileWidth
        const tileWidth = Math.max(0, Math.min(waveformTileWidth, trackWidth - tileStart))
        if (!tileWidth) continue
        const bitmap = allowTileBuild
          ? renderTileBitmap({
              cacheKey: '',
              filePath,
              stemId: track.waveformStemId,
              zoom: payload.zoom,
              tileIndex,
              tileStart,
              tileWidth,
              trackWidth,
              durationSeconds: track.durationSeconds,
              tempoSnapshot: track.tempoSnapshot,
              laneHeight: trackLaneHeight,
              pixelRatio: payload.pixelRatio
            })
          : null
        if (bitmap) {
          ctx.drawImage(
            bitmap,
            trackStartX + tileStart - viewStartX,
            trackY,
            tileWidth,
            trackLaneHeight
          )
          try {
            bitmap.close()
          } catch {}
        }
      }

      const visibleWidth = Math.max(0, localEnd - localStart)
      if (showGridLines && visibleWidth > 0) {
        ctx.save()
        ctx.translate(trackStartX + localStart - viewStartX, trackY)
        drawTrackGridLines(
          ctx,
          visibleWidth,
          trackLaneHeight,
          track,
          payload.renderPxPerSec,
          { start: localStart, end: localEnd },
          showDownbeatGrid,
          showBeatGrid,
          downbeatWidth
        )
        ctx.restore()
      }

      if (debugTrackLines) {
        ctx.save()
        ctx.globalAlpha = 0.9
        ctx.fillStyle = 'rgba(255, 64, 64, 0.9)'
        ctx.fillRect(0, Math.round(trackY), viewWidth, 1)
        ctx.fillStyle = 'rgba(64, 200, 255, 0.9)'
        ctx.fillRect(0, Math.round(trackY + trackLaneHeight - 1), viewWidth, 1)
        ctx.restore()
      }
    }
  }

  const renderFrameCpu = (
    payload: RenderFramePayload,
    slot: FrameBufferSlot,
    drawOutput: boolean
  ) => {
    const { width, height, pixelRatio, startX, startY } = payload
    const key = buildFrameKey(payload)
    const bufferMultiplier = resolveFrameBufferMultiplier(payload.zoom, mixTapeBufferMultiplier)
    const bufferTargetWidth = Math.max(1, Math.floor(width * bufferMultiplier))
    const bufferMargin = Math.floor(((bufferMultiplier - 1) * width) / 2)
    const desiredBufferStart = Math.max(0, Math.floor(startX - bufferMargin))
    const canReuseBuffer =
      slot.canvas &&
      slot.key === key &&
      slot.width === bufferTargetWidth &&
      slot.height === height &&
      startX >= slot.startX &&
      startX + width <= slot.startX + slot.width

    if (!canReuseBuffer) {
      slot.key = key
      slot.startX = desiredBufferStart
      slot.width = bufferTargetWidth
      slot.height = height
      const ensured = ensureBufferCanvas(slot, slot.width, slot.height, pixelRatio)
      if (!ensured.ctx) return
      renderTracksToContextCpu(ensured.ctx, payload, slot.startX, startY, slot.width, slot.height)
    }

    if (!drawOutput) return
    const output = ensureOutputCanvas(width, height, pixelRatio)
    const ctx = output.ctx
    if (!ctx || !slot.canvas) return
    const bufferMetrics = resolveCanvasScaleMetrics(slot.width, slot.height, pixelRatio)
    const srcX = Math.max(0, Math.round((startX - slot.startX) * bufferMetrics.scaleX))
    const srcY = 0
    const srcW = Math.max(1, Math.round(width * bufferMetrics.scaleX))
    const srcH = Math.max(1, Math.round(height * bufferMetrics.scaleY))
    ctx.drawImage(slot.canvas, srcX, srcY, srcW, srcH, 0, 0, width, height)
  }

  const createShader = (type: number, source: string) => {
    if (!gl) return null
    const shader = gl.createShader(type)
    if (!shader) return null
    gl.shaderSource(shader, source)
    gl.compileShader(shader)
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      gl.deleteShader(shader)
      return null
    }
    return shader
  }

  const createProgram = (vsSource: string, fsSource: string) => {
    if (!gl) return null
    const vs = createShader(gl.VERTEX_SHADER, vsSource)
    const fs = createShader(gl.FRAGMENT_SHADER, fsSource)
    if (!vs || !fs) return null
    const program = gl.createProgram()
    if (!program) return null
    gl.attachShader(program, vs)
    gl.attachShader(program, fs)
    gl.linkProgram(program)
    gl.deleteShader(vs)
    gl.deleteShader(fs)
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      gl.deleteProgram(program)
      return null
    }
    return program
  }

  const initWebGL = () => {
    if (glReady) return true
    if (!outputCanvas) return false
    const context =
      (outputCanvas.getContext('webgl2', {
        alpha: true,
        premultipliedAlpha: false
      }) as WebGL2RenderingContext | null) ||
      (outputCanvas.getContext('webgl', {
        alpha: true,
        premultipliedAlpha: false
      }) as WebGLRenderingContext | null)
    if (!context) return false
    gl = context
    glReady = true
    gl.disable(gl.DEPTH_TEST)
    gl.enable(gl.BLEND)
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true)
    glQuadBuffer = gl.createBuffer()
    if (!glQuadBuffer) return false
    gl.bindBuffer(gl.ARRAY_BUFFER, glQuadBuffer)
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([0, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1, 1]),
      gl.STATIC_DRAW
    )
    const vsSource = `
      attribute vec2 a_pos;
      uniform vec2 u_resolution;
      uniform vec4 u_rect;
      uniform vec4 u_texRect;
      varying vec2 v_tex;
      void main() {
        vec2 pos = u_rect.xy + a_pos * u_rect.zw;
        vec2 zeroToOne = pos / u_resolution;
        vec2 clip = zeroToOne * 2.0 - 1.0;
        gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
        v_tex = mix(u_texRect.xy, u_texRect.zw, a_pos);
      }
    `
    const fsTexSource = `
      precision mediump float;
      varying vec2 v_tex;
      uniform sampler2D u_tex;
      void main() {
        gl_FragColor = texture2D(u_tex, v_tex);
      }
    `
    const fsColorSource = `
      precision mediump float;
      uniform vec4 u_color;
      void main() {
        gl_FragColor = u_color;
      }
    `
    glProgramTex = createProgram(vsSource, fsTexSource)
    glProgramColor = createProgram(vsSource, fsColorSource)
    if (!glProgramTex || !glProgramColor) {
      glReady = false
      return false
    }
    glTexLocations = {
      aPos: gl.getAttribLocation(glProgramTex, 'a_pos'),
      uResolution: gl.getUniformLocation(glProgramTex, 'u_resolution'),
      uRect: gl.getUniformLocation(glProgramTex, 'u_rect'),
      uTex: gl.getUniformLocation(glProgramTex, 'u_tex'),
      uTexRect: gl.getUniformLocation(glProgramTex, 'u_texRect')
    }
    glColorLocations = {
      aPos: gl.getAttribLocation(glProgramColor, 'a_pos'),
      uResolution: gl.getUniformLocation(glProgramColor, 'u_resolution'),
      uRect: gl.getUniformLocation(glProgramColor, 'u_rect'),
      uColor: gl.getUniformLocation(glProgramColor, 'u_color')
    }
    gl.useProgram(glProgramTex)
    if (glTexLocations.uTex) gl.uniform1i(glTexLocations.uTex, 0)
    if (glTexLocations.uTexRect) gl.uniform4f(glTexLocations.uTexRect, 0, 0, 1, 1)
    glActiveProgram = null
    return true
  }

  const useTextureProgram = (width: number, height: number) => {
    if (!gl || !glProgramTex || !glTexLocations || !glQuadBuffer) return false
    if (glActiveProgram !== glProgramTex) {
      gl.useProgram(glProgramTex)
      glActiveProgram = glProgramTex
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, glQuadBuffer)
    if (glTexLocations.aPos >= 0) {
      gl.enableVertexAttribArray(glTexLocations.aPos)
      gl.vertexAttribPointer(glTexLocations.aPos, 2, gl.FLOAT, false, 0, 0)
    }
    if (glTexLocations.uResolution) gl.uniform2f(glTexLocations.uResolution, width, height)
    return true
  }

  const useColorProgram = (width: number, height: number) => {
    if (!gl || !glProgramColor || !glColorLocations || !glQuadBuffer) return false
    if (glActiveProgram !== glProgramColor) {
      gl.useProgram(glProgramColor)
      glActiveProgram = glProgramColor
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, glQuadBuffer)
    if (glColorLocations.aPos >= 0) {
      gl.enableVertexAttribArray(glColorLocations.aPos)
      gl.vertexAttribPointer(glColorLocations.aPos, 2, gl.FLOAT, false, 0, 0)
    }
    if (glColorLocations.uResolution) gl.uniform2f(glColorLocations.uResolution, width, height)
    return true
  }

  const setTextureRect = (u0: number, v0: number, u1: number, v1: number) => {
    if (!gl || !glTexLocations?.uTexRect) return
    gl.uniform4f(glTexLocations.uTexRect, u0, v0, u1, v1)
  }

  const drawTextureRect = (texture: WebGLTexture, x: number, y: number, w: number, h: number) => {
    if (!gl || !glTexLocations) return
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, texture)
    if (glTexLocations.uRect) gl.uniform4f(glTexLocations.uRect, x, y, w, h)
    gl.drawArrays(gl.TRIANGLES, 0, 6)
  }

  const drawColorRect = (
    x: number,
    y: number,
    w: number,
    h: number,
    color: { r: number; g: number; b: number; a: number }
  ) => {
    if (!gl || !glColorLocations) return
    if (glColorLocations.uRect) gl.uniform4f(glColorLocations.uRect, x, y, w, h)
    if (glColorLocations.uColor)
      gl.uniform4f(glColorLocations.uColor, color.r, color.g, color.b, color.a)
    gl.drawArrays(gl.TRIANGLES, 0, 6)
  }

  const createTextureFromBitmap = (bitmap: ImageBitmap) => {
    if (!gl) return null
    const texture = gl.createTexture()
    if (!texture) return null
    gl.bindTexture(gl.TEXTURE_2D, texture)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bitmap)
    return texture
  }

  const createTextureFromCanvas = (canvas: OffscreenCanvas) => {
    if (!gl) return null
    const texture = gl.createTexture()
    if (!texture) return null
    gl.bindTexture(gl.TEXTURE_2D, texture)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, canvas)
    return texture
  }

  const ensureBufferTexture = (
    slot: FrameBufferSlot,
    width: number,
    height: number,
    pixelRatio: number
  ) => {
    if (!gl) return null
    const { scaledWidth, scaledHeight } = resolveCanvasScaleMetrics(width, height, pixelRatio)
    if (!slot.texture) {
      slot.texture = gl.createTexture()
      if (!slot.texture) return null
      gl.bindTexture(gl.TEXTURE_2D, slot.texture)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    } else {
      gl.bindTexture(gl.TEXTURE_2D, slot.texture)
    }
    if (scaledWidth !== slot.texWidth || scaledHeight !== slot.texHeight) {
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA,
        scaledWidth,
        scaledHeight,
        0,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        null
      )
      slot.texWidth = scaledWidth
      slot.texHeight = scaledHeight
    }
    if (!slot.fbo) {
      slot.fbo = gl.createFramebuffer()
    }
    if (!slot.fbo) return null
    gl.bindFramebuffer(gl.FRAMEBUFFER, slot.fbo)
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, slot.texture, 0)
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    if (status !== gl.FRAMEBUFFER_COMPLETE) return null
    return { texture: slot.texture, width: scaledWidth, height: scaledHeight }
  }

  const getTileTexture = (
    filePath: string,
    stemId: WaveformStemId,
    zoom: number,
    tileIndex: number,
    tileStart: number,
    tileWidth: number,
    trackWidth: number,
    durationSeconds: number,
    tempoSnapshot: RenderTilePayload['tempoSnapshot'],
    laneHeight: number,
    pixelRatio: number,
    signature?: string,
    allowBuild: boolean = true
  ) => {
    const cacheKey = buildWaveformTileCacheKey({
      filePath,
      stemId,
      tileIndex,
      zoomValue: zoom,
      width: Math.max(1, Math.floor(tileWidth)),
      height: Math.max(1, Math.floor(laneHeight)),
      pixelRatio,
      signature,
      waveformHeightScale
    })
    let cached = tileCache.get(cacheKey)
    if (!cached) {
      if (!allowBuild) return null
      const bitmap = renderTileBitmap({
        cacheKey,
        filePath,
        stemId,
        zoom,
        tileIndex,
        tileStart,
        tileWidth,
        trackWidth,
        durationSeconds,
        tempoSnapshot,
        laneHeight,
        pixelRatio
      })
      if (!bitmap) return null
      const texture = createTextureFromBitmap(bitmap)
      try {
        bitmap.close()
      } catch {}
      if (!texture) return null
      tileCacheTick += 1
      tileCache.set(cacheKey, { texture, used: tileCacheTick })
      registerTileCacheKey(filePath, cacheKey)
      pruneTileCache()
      cached = tileCache.get(cacheKey)
    }
    if (cached) {
      touchTileCache(cacheKey)
      return cached.texture
    }
    return null
  }

  const renderFrameWebgl = (
    payload: RenderFramePayload,
    slot: FrameBufferSlot,
    drawOutput: boolean
  ) => {
    if (!gl && !initWebGL()) return
    if (!gl) return
    const { width, height, pixelRatio, startX, startY } = payload
    const showGridLines = payload.showGridLines !== false
    const allowTileBuild = payload.allowTileBuild !== false
    const { scaledWidth, scaledHeight } = resolveCanvasScaleMetrics(width, height, pixelRatio)
    const key = buildFrameKey(payload)
    const bufferMultiplier = resolveFrameBufferMultiplier(payload.zoom, mixTapeBufferMultiplier)
    const bufferTargetWidth = Math.max(1, Math.floor(width * bufferMultiplier))
    const bufferMargin = Math.floor(((bufferMultiplier - 1) * width) / 2)
    const desiredBufferStart = Math.max(0, Math.floor(startX - bufferMargin))
    const canReuseBuffer =
      slot.texture &&
      slot.key === key &&
      slot.width === bufferTargetWidth &&
      slot.height === height &&
      startX >= slot.startX &&
      startX + width <= slot.startX + slot.width

    if (!canReuseBuffer) {
      slot.key = key
      slot.startX = desiredBufferStart
      slot.width = bufferTargetWidth
      slot.height = height
      const bufferTarget = ensureBufferTexture(slot, slot.width, slot.height, pixelRatio)
      if (!bufferTarget) {
        renderFrameCpu(payload, slot, drawOutput)
        return
      }
      if (!slot.fbo) return
      gl.bindFramebuffer(gl.FRAMEBUFFER, slot.fbo)
      gl.viewport(0, 0, bufferTarget.width, bufferTarget.height)
      gl.clearColor(0, 0, 0, 0)
      gl.clear(gl.COLOR_BUFFER_BIT)
      if (!useTextureProgram(slot.width, slot.height)) return
      setTextureRect(0, 0, 1, 1)
      const laneStride = payload.laneHeight + payload.laneGap
      const endX = slot.startX + slot.width
      for (const track of payload.tracks) {
        const filePath = track.waveformFilePath || track.filePath
        if (!filePath) continue
        const trackLaneHeight = Math.max(1, Number(track.laneHeight) || payload.laneHeight)
        const trackLaneOffset = Math.max(0, Number(track.laneOffsetY) || 0)
        const trackWidth = track.trackWidth
        if (!trackWidth || !Number.isFinite(trackWidth)) continue
        const trackStartX = Number(track.startX) || 0
        const trackEndX = trackStartX + trackWidth
        const trackY =
          payload.trackContentTop +
          payload.lanePaddingTop +
          track.laneIndex * laneStride +
          trackLaneOffset -
          startY
        if (trackY > slot.height || trackY + trackLaneHeight < 0) continue
        const visibleStart = Math.max(trackStartX, slot.startX)
        const visibleEnd = Math.min(trackEndX, endX)
        if (visibleEnd <= visibleStart) continue
        const localStart = visibleStart - trackStartX
        const localEnd = visibleEnd - trackStartX

        const tileStartIndex = Math.max(0, Math.floor(localStart / waveformTileWidth))
        const tileEndIndex = Math.max(
          tileStartIndex,
          Math.floor(Math.max(0, localEnd - 1) / waveformTileWidth)
        )
        for (let tileIndex = tileStartIndex; tileIndex <= tileEndIndex; tileIndex += 1) {
          const tileStart = tileIndex * waveformTileWidth
          const tileWidth = Math.max(0, Math.min(waveformTileWidth, trackWidth - tileStart))
          if (!tileWidth) continue
          const texture = getTileTexture(
            filePath,
            track.waveformStemId,
            payload.zoom,
            tileIndex,
            tileStart,
            tileWidth,
            trackWidth,
            track.durationSeconds,
            track.tempoSnapshot,
            trackLaneHeight,
            payload.pixelRatio,
            track.tempoSnapshot.signature,
            allowTileBuild
          )
          if (texture) {
            drawTextureRect(
              texture,
              trackStartX + tileStart - slot.startX,
              trackY,
              tileWidth,
              trackLaneHeight
            )
          }
        }
      }

      if (showGridLines) {
        if (!useColorProgram(slot.width, slot.height)) return
        const showDownbeatGrid = payload.zoom >= gridDownbeatLineZoom
        const showBeatGrid = payload.zoom >= gridBeatLineZoom
        const downbeatWidth = resolveGridDownbeatWidth({
          zoom: payload.zoom,
          rawWaveformMinZoom,
          gridDownbeatWidthMin,
          gridDownbeatWidthMax,
          gridDownbeatWidthMaxZoom
        })
        for (const track of payload.tracks) {
          const trackWidth = track.trackWidth
          if (!trackWidth || !Number.isFinite(trackWidth)) continue
          const trackStartX = Number(track.startX) || 0
          const trackEndX = trackStartX + trackWidth
          const trackLaneHeight = Math.max(1, Number(track.laneHeight) || payload.laneHeight)
          const trackLaneOffset = Math.max(0, Number(track.laneOffsetY) || 0)
          const trackY =
            payload.trackContentTop +
            payload.lanePaddingTop +
            track.laneIndex * laneStride +
            trackLaneOffset -
            startY
          if (trackY > slot.height || trackY + trackLaneHeight < 0) continue
          const visibleStart = Math.max(trackStartX, slot.startX)
          const visibleEnd = Math.min(trackEndX, endX)
          if (visibleEnd <= visibleStart) continue
          const localStart = visibleStart - trackStartX
          const localEnd = visibleEnd - trackStartX
          const gridCanvas = new OffscreenCanvas(
            Math.max(1, Math.ceil(visibleEnd - visibleStart + downbeatWidth + 4)),
            Math.max(1, Math.ceil(trackLaneHeight))
          )
          const gridCtx = gridCanvas.getContext('2d')
          if (!gridCtx) continue
          drawTrackGridLines(
            gridCtx,
            Math.max(0, localEnd - localStart),
            trackLaneHeight,
            track,
            payload.renderPxPerSec,
            { start: localStart, end: localEnd },
            showDownbeatGrid,
            showBeatGrid,
            downbeatWidth
          )
          const gridTexture = createTextureFromCanvas(gridCanvas)
          if (!gridTexture) continue
          drawTextureRect(
            gridTexture,
            trackStartX + localStart - slot.startX,
            trackY,
            Math.max(1, Math.ceil(visibleEnd - visibleStart + downbeatWidth + 4)),
            trackLaneHeight
          )
          if (gl) {
            try {
              gl.deleteTexture(gridTexture)
            } catch {}
          }
        }
      }

      if (debugTrackLines) {
        for (const track of payload.tracks) {
          const trackWidth = track.trackWidth
          if (!trackWidth || !Number.isFinite(trackWidth)) continue
          const trackLaneHeight = Math.max(1, Number(track.laneHeight) || payload.laneHeight)
          const trackLaneOffset = Math.max(0, Number(track.laneOffsetY) || 0)
          const trackY =
            payload.trackContentTop +
            payload.lanePaddingTop +
            track.laneIndex * laneStride +
            trackLaneOffset -
            startY
          if (trackY > slot.height || trackY + trackLaneHeight < 0) continue
          drawColorRect(0, Math.round(trackY), slot.width, 1, { r: 1, g: 0.25, b: 0.25, a: 0.9 })
          drawColorRect(0, Math.round(trackY + trackLaneHeight - 1), slot.width, 1, {
            r: 0.25,
            g: 0.78,
            b: 1,
            a: 0.9
          })
        }
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    }

    if (!drawOutput) return
    if (outputCanvas) {
      if (outputCanvas.width !== scaledWidth) outputCanvas.width = scaledWidth
      if (outputCanvas.height !== scaledHeight) outputCanvas.height = scaledHeight
    }
    gl.viewport(0, 0, scaledWidth, scaledHeight)
    gl.clearColor(0, 0, 0, 0)
    gl.clear(gl.COLOR_BUFFER_BIT)
    if (!slot.texture) return
    if (!useTextureProgram(width, height)) return
    const u0 = slot.width > 0 ? (startX - slot.startX) / slot.width : 0
    const u1 = slot.width > 0 ? (startX - slot.startX + width) / slot.width : 1
    const vSpan = slot.height > 0 ? height / slot.height : 1
    setTextureRect(u0, 1, u1, 1 - vSpan)
    drawTextureRect(slot.texture, 0, 0, width, height)
  }

  const renderFrame = (payload: RenderFramePayload, options: { cacheOnly?: boolean } = {}) => {
    const bufferId = resolveFrameBufferId(payload)
    const slot = getFrameBufferSlot(bufferId)
    const drawOutput = !options.cacheOnly
    if (mixTapeWebglEnabled && initWebGL()) {
      renderFrameWebgl(payload, slot, drawOutput)
    } else {
      renderFrameCpu(payload, slot, drawOutput)
    }
  }

  const initCanvas = (canvas: OffscreenCanvas) => {
    outputCanvas = canvas
    outputCtx = null
    gl = null
    glReady = false
    glProgramTex = null
    glProgramColor = null
    glQuadBuffer = null
    glActiveProgram = null
    clearFrameBufferSlots()
    initWebGL()
    if (!glReady && outputCanvas) {
      outputCtx = outputCanvas.getContext('2d')
    }
  }

  const warmTileTexture = (task: RenderTilePayload) => {
    getTileTexture(
      task.filePath,
      task.stemId,
      task.zoom,
      task.tileIndex,
      task.tileStart,
      task.tileWidth,
      task.trackWidth,
      task.durationSeconds,
      task.tempoSnapshot,
      task.laneHeight,
      task.pixelRatio,
      task.tempoSnapshot.signature
    )
  }

  const ensureTileCacheLimit = (targetLimit: number) => {
    if (targetLimit > tileCacheLimit) {
      tileCacheLimit = targetLimit
    }
  }

  const getTileCacheSize = () => tileCache.size

  return {
    initCanvas,
    renderFrame,
    warmTileTexture,
    clearTileCacheForFile,
    clearAllCaches,
    ensureTileCacheLimit,
    getTileCacheSize
  }
}
