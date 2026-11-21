import { describe, expect, it, vi, afterEach } from 'vitest'
import { FrameGate, QualityLadder, TargetSelector } from './control'
import { PosePipeline } from './index'

function pose(x, width = 0.2, visibility = 1) {
  const p = Array.from({length:33},()=>({x,y:0.4,z:0,visibility}))
  p[11].x = x-width/2
  p[12].x = x+width/2
  return p
}

describe('backpressure',()=>{
  it('drops all concurrent frames and keeps accepted timestamps monotonic',()=>{
    const gate = new FrameGate()
    expect(gate.acquire(100)).toBe(100)
    for(let i=0;i<10000;i++) expect(gate.acquire(i)).toBeNull()
    gate.release()
    expect(gate.acquire(99)).toBeGreaterThan(100)
    expect(gate.isBusy).toBe(true)
  })
})
describe('quality ladder',()=>{
  it('downgrades after each ten slow frames and recovers after thirty fast frames per step',()=>{
    const ladder = new QualityLadder()
    for(let i=0;i<9;i++) expect(ladder.update(46)).toBe(0)
    expect(ladder.update(46)).toBe(1)
    for(let i=0;i<10;i++) ladder.update(46)
    expect(ladder.tier).toBe(2)
    for(let i=0;i<29;i++) expect(ladder.update(20)).toBe(2)
    expect(ladder.update(20)).toBe(1)
    for(let i=0;i<30;i++) ladder.update(20)
    expect(ladder.tier).toBe(0)
  })
  it('ignores invalid samples and does not oscillate in the hysteresis band',()=>{
    const ladder = new QualityLadder()
    for(let i=0;i<10;i++) ladder.update(60)
    for(let i=0;i<100;i++) { ladder.update(NaN); ladder.update(-1); ladder.update(35) }
    expect(ladder.tier).toBe(1)
  })
})
describe('target selection',()=>{
  it('prefers a central large person and preserves the lock when array order changes',()=>{
    const selector = new TargetSelector()
    expect(selector.select([pose(0.1,0.12),pose(0.5)],0)).toBe(1)
    expect(selector.select([pose(0.51),pose(0.1,0.5)],33)).toBe(0)
  })
  it('reports no person on occlusion and reserves identity for 1500ms',()=>{
    const selector = new TargetSelector()
    selector.select([pose(0.5)],0)
    expect(selector.select([pose(0.5,0.2,0.49),pose(0.9)],33)).toBeNull()
    expect(selector.select([pose(0.9)],1500)).toBeNull()
    expect(selector.select([pose(0.51)],1510)).toBe(0)
    expect(selector.select([],1600)).toBeNull()
    expect(selector.select([pose(0.9)],3101)).toBe(0)
  })
  it('rejects malformed or tiny detections',()=>{
    const selector = new TargetSelector()
    expect(selector.select([[],pose(NaN),pose(0.5,0.01)],0)).toBeNull()
  })
  it('measures fake target-selection throughput',()=>{
    const selector = new TargetSelector()
    const people=[pose(0.1),pose(0.5),pose(0.9)]
    const start=performance.now()
    for(let i=0;i<10000;i++) selector.select(people,i*33)
    const mean=(performance.now()-start)/10000
    console.log('target selection mean ms',mean)
    expect(mean).toBeLessThan(1)
  })
})

describe('singleton lifecycle using browser fakes',()=>{
  let pipeline
  afterEach(()=>{ pipeline?.dispose(); vi.unstubAllGlobals(); vi.restoreAllMocks() })
  function setup() {
    const stop=vi.fn()
    const media=vi.fn().mockResolvedValue({getTracks:()=>[{stop}]})
    const worker={postMessage:vi.fn(),terminate:vi.fn(),onmessage:null}
    const video={muted:false,playsInline:false,srcObject:null,play:vi.fn().mockResolvedValue(),pause:vi.fn(),readyState:2,currentTime:1}
    const element={style:{},remove:vi.fn(),getContext:()=>({})}
    vi.stubGlobal('navigator',{mediaDevices:{getUserMedia:media}})
    vi.stubGlobal('document',{createElement:tag=>tag==='video'?video:{...element},body:{append:vi.fn()}})
    vi.stubGlobal('window',{addEventListener:vi.fn(),removeEventListener:vi.fn()})
    vi.stubGlobal('location',{href:'https://example.org/'})
    vi.stubGlobal('Worker',class { constructor(){ return worker } })
    vi.stubGlobal('OffscreenCanvas',class {})
    vi.stubGlobal('requestAnimationFrame',vi.fn(()=>1))
    vi.stubGlobal('cancelAnimationFrame',vi.fn())
    pipeline=PosePipeline.getInstance()
    return {media,worker,stop,video}
  }
  it('shares startup, reuses camera/model across stop/start, and releases resources on dispose',async()=>{
    const {media,worker,stop,video}=setup()
    const a=pipeline.start(), b=pipeline.start()
    await vi.waitFor(()=>expect(worker.onmessage).toBeTypeOf('function'))
    worker.onmessage({data:{type:'ready',delegate:'CPU'}})
    await Promise.all([a,b])
    pipeline.stop()
    await pipeline.start()
    expect(media).toHaveBeenCalledTimes(1)
    expect(worker.postMessage).toHaveBeenCalledTimes(1)
    pipeline.dispose()
    expect(stop).toHaveBeenCalledTimes(1)
    expect(worker.terminate).toHaveBeenCalledTimes(1)
    expect(video.srcObject).toBeNull()
  })
  it('does not schedule animation after a running-status listener disposes it',async()=>{
    const {worker,stop}=setup()
    pipeline.onStatus(status=>{if(status.state==='running') pipeline.dispose()})
    const start=pipeline.start()
    await vi.waitFor(()=>expect(worker.onmessage).toBeTypeOf('function'))
    worker.onmessage({data:{type:'ready',delegate:'CPU'}})
    await start
    expect(requestAnimationFrame).not.toHaveBeenCalled()
    expect(stop).toHaveBeenCalledTimes(1)
    expect(worker.terminate).toHaveBeenCalledTimes(1)
  })
  it('allows disposal from a status callback without recursive disposal',()=>{
    setup()
    pipeline.onStatus(status=>{if(status.state==='stopped') pipeline.dispose()})
    expect(()=>pipeline.stop()).not.toThrow()
  })
  it('stops a camera that arrives after disposal',async()=>{
    const {media,stop}=setup()
    let resolve
    media.mockReturnValue(new Promise(r=>{resolve=r}))
    const start=pipeline.start()
    const rejection=expect(start).rejects.toThrow('disposed')
    pipeline.dispose()
    resolve({getTracks:()=>[{stop}]})
    await rejection
    expect(stop).toHaveBeenCalledTimes(1)
  })
})

describe('worker execution with fake MediaPipe',()=>{
  afterEach(()=>{vi.unstubAllGlobals();vi.restoreAllMocks()})
  it('falls back to local WASM and CPU, closes every bitmap, and closes its model',async()=>{
    const {createPoseWorker}=await import('./pose.worker')
    const {runInNewContext}=await import('node:vm')
    let blob
    vi.spyOn(URL,'createObjectURL').mockImplementation(value=>{blob=value;return 'blob:fake'})
    vi.spyOn(URL,'revokeObjectURL').mockImplementation(()=>{})
    vi.stubGlobal('Worker',class {})
    createPoseWorker()
    const send=vi.fn(), close=vi.fn(), detectorClose=vi.fn()
    const detector={detectForVideo:vi.fn(()=>({landmarks:[],worldLandmarks:[]})),close:detectorClose}
    const create=vi.fn(async(_files,options)=>{
      if(options.baseOptions.delegate==='GPU') throw new Error('No WebGL')
      return detector
    })
    const context={
      performance,Uint8Array,
      fetch:vi.fn(async()=>({ok:true,arrayBuffer:async()=>new ArrayBuffer(1)})),
      postMessage:send,close,
      importScripts:()=>{context.exports={
        FilesetResolver:{forVisionTasks:async url=>{if(url==='cdn') throw new Error('offline'); return {}}},
        PoseLandmarker:{createFromOptions:create},
      }},
    }
    runInNewContext(await blob.text(),context)
    context.onmessage({data:{type:'init',assets:{scriptUrl:'bundle',wasmUrl:'cdn',localWasmUrl:'local',modelUrl:'model'}}})
    await vi.waitFor(()=>expect(send).toHaveBeenCalledWith({type:'ready',delegate:'CPU'}))
    const bitmap={close:vi.fn()}
    context.onmessage({data:{type:'frame',bitmap,timeMs:100}})
    await vi.waitFor(()=>expect(bitmap.close).toHaveBeenCalledTimes(1))
    detector.detectForVideo.mockImplementation(()=>{throw new Error('bad frame')})
    const broken={close:vi.fn()}
    context.onmessage({data:{type:'frame',bitmap:broken,timeMs:200}})
    await vi.waitFor(()=>expect(send).toHaveBeenCalledWith({type:'error',message:'Error: bad frame'}))
    expect(broken.close).toHaveBeenCalledTimes(1)
    context.onmessage({data:{type:'dispose'}})
    expect(detectorClose).toHaveBeenCalledTimes(1)
    expect(close).toHaveBeenCalledTimes(1)
    expect(create).toHaveBeenCalledTimes(2)
  })
})
