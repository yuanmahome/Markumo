const pending=new Set<Promise<unknown>>()
export function trackWindowRelease(task:Promise<unknown>){
  pending.add(task);void task.finally(()=>pending.delete(task)).catch(()=>{})
  return task
}
export async function flushWindowReleases(){while(pending.size)await Promise.all([...pending])}
