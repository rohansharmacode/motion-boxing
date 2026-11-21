import type { Assets, Delegate, WorkerRequest, WorkerResponse, Landmark } from './types'

// A classic worker allows MediaPipe's generated WASM loader to use importScripts.
// Keep the worker function self-contained so its compiled source can run in a Blob.
function runWorker() {
  interface Detector {
    detectForVideo(bitmap: ImageBitmap, timeMs: number): { landmarks: Landmark[][]; worldLandmarks: Landmark[][] }
    close(): void
  }
  interface Vision {
    FilesetResolver: { forVisionTasks(url: string): Promise<unknown> }
    PoseLandmarker: { createFromOptions(files: unknown, options: unknown): Promise<Detector> }
  }
  const scope = globalThis as unknown as {
    exports: Vision
    importScripts(url: string): void
    postMessage(message: WorkerResponse): void
    onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null
    close(): void
  }
  scope.exports = {} as Vision
  let detector: Detector | undefined
  let delegate: Delegate = 'GPU'
  let files: unknown
  let model: Uint8Array
  let last = -Infinity
  const send = (message: WorkerResponse) => scope.postMessage(message)
  async function create(selected: Delegate) {
    return scope.exports.PoseLandmarker.createFromOptions(files, {
      baseOptions: { modelAssetBuffer: model, delegate: selected },
      runningMode: 'VIDEO', numPoses: 4,
      minPoseDetectionConfidence: 0.5, minPosePresenceConfidence: 0.5,
      minTrackingConfidence: 0.5, outputSegmentationMasks: false,
    })
  }
  async function initialize(assets: Assets) {
    try { scope.importScripts(assets.scriptUrl) }
    catch { scope.importScripts(assets.localScriptUrl) }
    let response: Response
    try {
      response = await fetch(assets.modelUrl)
      if (!response.ok) throw new Error('Model download failed')
    } catch {
      response = await fetch(assets.localModelUrl)
      if (!response.ok) throw new Error('Local model unavailable')
    }
    model = new Uint8Array(await response.arrayBuffer())
    for (const base of [assets.wasmUrl, assets.localWasmUrl]) {
      try {
        files = await scope.exports.FilesetResolver.forVisionTasks(base)
        try { detector = await create('GPU'); delegate = 'GPU' }
        catch { detector = await create('CPU'); delegate = 'CPU' }
        send({type:'ready',delegate})
        return
      } catch { /* Try the local WASM files after CDN initialization fails. */ }
    }
    throw new Error('Unable to initialize CDN or local MediaPipe WASM')
  }
  async function handle(message: WorkerRequest) {
    if (message.type === 'dispose') {
      detector?.close()
      send({type:'disposed'})
      scope.close()
      return
    }
    if (message.type === 'init') { await initialize(message.assets); return }
    const { bitmap, timeMs } = message
    try {
      if (!detector || timeMs <= last) throw new Error('Invalid frame or worker not initialized')
      last = timeMs
      const start = performance.now()
      let result: ReturnType<Detector['detectForVideo']>
      try { result = detector.detectForVideo(bitmap,timeMs) }
      catch (error) {
        if (delegate === 'CPU') throw error
        detector.close()
        detector = await create('CPU')
        delegate = 'CPU'
        result = detector.detectForVideo(bitmap,timeMs)
      }
      send({type:'result',timeMs,inferenceMs:performance.now()-start,delegate,
        image:result.landmarks,world:result.worldLandmarks})
    } finally { bitmap.close() }
  }
  scope.onmessage = event => {
    void handle(event.data).catch(error => send({type:'error',message:String(error)}))
  }
}
export function createPoseWorker(): Worker {
  const url = URL.createObjectURL(new Blob(['('+runWorker.toString()+')()'],{type:'text/javascript'}))
  try { return new Worker(url,{name:'pose-landmarker'}) }
  finally { URL.revokeObjectURL(url) }
}
