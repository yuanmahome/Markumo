interface EmptyWindowStatus { detached:boolean;ready:boolean;documents:number;busy:boolean }
/** A committed handoff may settle through a timeout/status reply instead of its
 * event. Observe actual ownership, and never close a newly booting empty window. */
export class EmptyDetachedWindow {
  private populated=false
  private pending=false
  private disposed=false
  constructor(private status:()=>EmptyWindowStatus,private close:()=>Promise<void>){}
  refresh(){
    const state=this.status()
    if(this.disposed||!state.detached||!state.ready)return
    if(state.documents){this.populated=true;return}
    if(!this.populated||state.busy||this.pending)return
    this.pending=true
    void Promise.resolve().then(async()=>{
      const next=this.status()
      if(!this.disposed&&next.detached&&next.ready&&!next.documents&&!next.busy)await this.close()
    }).finally(()=>{this.pending=false})
  }
  dispose(){this.disposed=true}
}
