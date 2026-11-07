interface EmptyWindowStatus { ready:boolean; documents:number; busy:boolean; dirty:boolean }
/** Armed only by removal of a document after a confirmed cross-window move. */
export class EmptyWindowLifecycle {
  private handoff:string|null=null
  private pending=false
  private disposed=false
  constructor(private status:()=>EmptyWindowStatus,private close:()=>Promise<void>){}
  committed(handoffId:string){if(!this.status().documents)this.handoff=handoffId;this.refresh()}
  candidate(){return !this.disposed&&this.handoff&&this.eligible()?this.handoff:null}
  private eligible(){const s=this.status();return s.ready&&!s.documents&&!s.busy&&!s.dirty}
  refresh(){
    if(this.status().documents){this.handoff=null;return}
    if(!this.candidate()||this.pending)return
    this.pending=true
    void Promise.resolve().then(async()=>{if(this.candidate())await this.close()}).finally(()=>{this.pending=false})
  }
  dispose(){this.disposed=true;this.handoff=null}
}
