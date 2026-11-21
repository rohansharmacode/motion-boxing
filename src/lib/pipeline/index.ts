import { FrameGate, QualityLadder, TargetSelector, isVisible } from './control'
import { createPoseWorker } from './pose.worker'
import { DebugOverlay } from './overlay'
import { defaultAssets } from './types'
import type { Assets, BodyFrame, PipelineStatus, WorkerResponse } from './types'
export type { BodyFrame, PipelineStatus, Assets, Delegate, Tier } from './types'

type Listener<T> = (value: T) => void
export class PosePipeline {
  private static instance?: PosePipeline
  static getInstance(options: Partial<Assets> = {}) {
    return this.instance ??= new PosePipeline(options)
  }
  private frames = new Set<Listener<BodyFrame>>()
  private statuses = new Set<Listener<PipelineStatus>>()
  private gate = new FrameGate()
  private quality = new QualityLadder()
  private selector = new TargetSelector()
  private worker?: Worker
  private stream?: MediaStream
  private video?: HTMLVideoElement
  private canvas?: OffscreenCanvas
  private overlay?: DebugOverlay
  private initialization?: Promise<void>
  private rejectReady?: (reason: Error) => void
  private readyTimer?: ReturnType<typeof setTimeout>
  private frameTimer?: ReturnType<typeof setTimeout>
  private raf = 0
  private generation = 0
  private desired = false
  private disposed = false
  private lastVideoTime = -1
  private lastCapture = -Infinity
  private lastResult = 0
  private status: PipelineStatus = {
    state:'idle',fps:0,inferenceMs:0,delegate:null,tier:0,person:'no-person',
    renderer:{pixelRatioCap:Infinity,bloom:true,shadows:true},
  }
  private options: Partial<Assets>
  private constructor(options: Partial<Assets>) { this.options = options }
  onFrame(listener: Listener<BodyFrame>) {
    this.frames.add(listener)
    return () => { this.frames.delete(listener) }
  }
  onStatus(listener: Listener<PipelineStatus>) {
    this.statuses.add(listener)
    listener({...this.status,renderer:{...this.status.renderer}})
    return () => { this.statuses.delete(listener) }
  }
  private emit<T>(listeners: Set<Listener<T>>, value: T) {
    for (const listener of listeners) {
      try { listener(value) } catch (error) { console.error('Pose pipeline listener failed',error) }
    }
  }
  private publish() { this.emit(this.statuses,{...this.status,renderer:{...this.status.renderer}}) }
  async start(): Promise<void> {
    if (this.disposed) throw new Error('Pipeline is disposed')
    if (this.status.state === 'error') throw new Error('Dispose the failed pipeline before creating a new instance')
    this.desired = true
    this.initialization ??= this.initialize().catch(error => {
      this.fail(String(error))
      throw error
    })
    await this.initialization
    if (!this.desired || this.disposed || this.status.state === 'running') return
    this.status.state = 'running'
    this.publish()
    if (this.desired && !this.disposed) this.raf = requestAnimationFrame(this.tick)
  }
  private async initialize() {
    this.status.state = 'starting'
    this.publish()
    const stream = await navigator.mediaDevices.getUserMedia({
      audio:false,video:{width:{ideal:640},height:{ideal:480},frameRate:{ideal:30,max:30}},
    })
    if (this.disposed) {
      stream.getTracks().forEach(track => track.stop())
      throw new Error('Pipeline disposed during camera request')
    }
    this.stream = stream
    const video = document.createElement('video')
    this.video = video
    video.muted = true
    video.playsInline = true
    video.srcObject = stream
    await video.play()
    if (this.disposed) throw new Error('Pipeline disposed during camera startup')
    this.canvas = new OffscreenCanvas(640,480)
    this.worker = createPoseWorker()
    this.overlay = new DebugOverlay()
    const ready = new Promise<void>((resolve,reject) => {
      this.rejectReady = reject
      this.readyTimer = setTimeout(() => this.fail('MediaPipe initialization timed out'),60000)
      this.worker!.onerror = event => this.fail(event.message || 'Pose worker failed')
      this.worker!.onmessageerror = () => this.fail('Invalid worker message')
      this.worker!.onmessage = (event: MessageEvent<WorkerResponse>) => {
        const message = event.data
        if (message.type === 'ready') {
          clearTimeout(this.readyTimer)
          this.rejectReady = undefined
          this.status.delegate = message.delegate
          resolve()
        } else if (message.type === 'result') this.result(message)
        else if (message.type === 'error') this.fail(message.message)
      }
    })
    const assets = {...defaultAssets,...this.options}
    for (const key of Object.keys(assets) as (keyof Assets)[]) assets[key] = new URL(assets[key],location.href).href
    this.worker.postMessage({type:'init',assets})
    await ready
  }
  private tick = (now: number) => {
    if (!this.desired || this.disposed) return
    this.raf = requestAnimationFrame(this.tick)
    const video = this.video
    if (!video || video.readyState < 2 || video.currentTime === this.lastVideoTime || now-this.lastCapture < 1000/30) return
    const timeMs = this.gate.acquire(now)
    if (timeMs === null) return
    this.lastVideoTime = video.currentTime
    this.lastCapture = now
    const canvas = this.canvas!
    const width = this.quality.tier === 0 ? 640 : 320
    if (canvas.width !== width) { canvas.width = width; canvas.height = width*0.75 }
    let bitmap: ImageBitmap | undefined
    try {
      const context = canvas.getContext('2d')
      if (!context) throw new Error('OffscreenCanvas 2D unavailable')
      context.drawImage(video,0,0,canvas.width,canvas.height)
      bitmap = canvas.transferToImageBitmap()
      this.worker!.postMessage({type:'frame',bitmap,timeMs},[bitmap])
      bitmap = undefined
      const generation = this.generation
      this.frameTimer = setTimeout(() => {
        if (generation === this.generation) this.fail('Pose inference timed out')
      },10000)
    } catch (error) {
      bitmap?.close()
      this.fail(String(error))
    }
  }
  private result(message: Extract<WorkerResponse,{type:'result'}>) {
    clearTimeout(this.frameTimer)
    this.gate.release()
    if (!this.desired || this.disposed || message.timeMs < this.resumeAfter) return
    const now = performance.now()
    const tier = this.quality.update(message.inferenceMs)
    const index = this.selector.select(message.image,message.timeMs)
    const clean = (pose: typeof message.image[number]) => pose.map(p => isVisible(p) ? p : null)
    const person = index === null || !message.world[index] ? 'no-person' : 'tracked'
    const frame: BodyFrame = {
      timeMs:message.timeMs,person,
      image:person === 'tracked' ? clean(message.image[index!]) : [],
      world:person === 'tracked' ? clean(message.world[index!]) : [],
    }
    this.status = {...this.status,person,delegate:message.delegate,tier,inferenceMs:message.inferenceMs,
      fps:this.lastResult ? 1000/(now-this.lastResult) : 0,
      renderer:{pixelRatioCap:tier === 2 ? 1 : Infinity,bloom:tier !== 2,shadows:tier !== 2}}
    this.lastResult = now
    this.overlay?.draw(frame,this.status)
    this.emit(this.frames,frame)
    this.publish()
  }
  private resumeAfter = 0
  stop() {
    if (this.disposed) return
    this.desired = false
    cancelAnimationFrame(this.raf)
    this.resumeAfter = performance.now()
    this.lastResult = 0
    this.selector.reset()
    this.status = {...this.status,state:'stopped',person:'no-person',fps:0}
    this.publish()
  }
  private fail(message: string) {
    if (this.disposed) return
    this.stop()
    this.status = {...this.status,state:'error',error:message}
    this.release()
    this.publish()
  }
  private release() {
    cancelAnimationFrame(this.raf)
    this.generation++
    clearTimeout(this.readyTimer)
    clearTimeout(this.frameTimer)
    this.rejectReady?.(new Error('Pipeline initialization cancelled'))
    this.rejectReady = undefined
    this.worker?.terminate()
    this.worker = undefined
    this.stream?.getTracks().forEach(track => track.stop())
    this.stream = undefined
    if (this.video) { this.video.pause(); this.video.srcObject = null }
    this.video = undefined
    this.canvas = undefined
    this.overlay?.dispose()
    this.overlay = undefined
    this.gate.release()
  }
  dispose() {
    if (this.disposed) return
    this.disposed = true
    this.desired = false
    this.release()
    this.status = {...this.status,state:'disposed',person:'no-person',fps:0}
    this.publish()
    this.frames.clear()
    this.statuses.clear()
    if (PosePipeline.instance === this) PosePipeline.instance = undefined
  }
}
