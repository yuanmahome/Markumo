export interface RenderVisibilityOptions {
  root?: Element | null
  rootMargin?: string
}

export interface RenderVisibilityState {
  readonly visible: boolean
  readonly nearViewport: boolean
  readonly documentHidden: boolean
}

interface Subscription {
  nearViewport: boolean
  callback: ((state: RenderVisibilityState) => void) | null
}
interface Group {
  observer: IntersectionObserver
  targets: Map<Element, Set<Subscription>>
}
interface DocumentPool {
  groups: Map<Element | null, Map<string, Group>>
  subscriptions: Set<Subscription>
  visibility: () => void
}
// Only active subscriptions retain targets. The final disposer removes the
// native observer, root key and document listener; there is no historical LRU.
const pools = new WeakMap<Document, DocumentPool>()
function notify(doc: Document, item: Subscription) {
  item.callback?.({visible:item.nearViewport && !doc.hidden,nearViewport:item.nearViewport,documentHidden:!!doc.hidden})
}

/** Share observers by actual pane root/margin, preserving per-target visibility. */
export function observeRenderVisibility(
  element: HTMLElement,
  options: RenderVisibilityOptions,
  onChange: (state: RenderVisibilityState) => void
): () => void {
  const doc=element.ownerDocument,root=options.root ?? null,margin=options.rootMargin ?? '400px 0px 400px 0px'
  let pool=pools.get(doc)
  if(!pool){
    const subscriptions=new Set<Subscription>()
    const visibility=()=>{for(const item of [...subscriptions])notify(doc,item)}
    pool={groups:new Map(),subscriptions,visibility}
    pools.set(doc,pool);doc.addEventListener('visibilitychange',visibility)
  }
  const owner=pool,item:Subscription={nearViewport:typeof IntersectionObserver!=='function',callback:onChange}
  owner.subscriptions.add(item)
  let group:Group|undefined
  if(typeof IntersectionObserver==='function'){
    let margins=owner.groups.get(root)
    if(!margins){margins=new Map();owner.groups.set(root,margins)}
    group=margins.get(margin)
    if(!group){
      const targets=new Map<Element,Set<Subscription>>()
      const observer=new IntersectionObserver(entries=>{
        for(const entry of entries)for(const subscription of [...(targets.get(entry.target) || [])]){
          subscription.nearViewport=entry.isIntersecting;notify(doc,subscription)
        }
      },{root,rootMargin:margin})
      group={observer,targets};margins.set(margin,group)
    }
    let subscribers=group.targets.get(element)
    if(!subscribers){subscribers=new Set();group.targets.set(element,subscribers);subscribers.add(item);group.observer.observe(element)}
    else {item.nearViewport=subscribers.values().next().value?.nearViewport ?? false;subscribers.add(item);notify(doc,item)}
  }else notify(doc,item)
  return ()=>{
    if(!item.callback)return
    item.callback=null;owner.subscriptions.delete(item)
    if(group){
      const subscribers=group.targets.get(element)
      subscribers?.delete(item)
      if(!subscribers?.size){group.targets.delete(element);group.observer.unobserve(element)}
      if(!group.targets.size){
        group.observer.disconnect()
        const margins=owner.groups.get(root);margins?.delete(margin)
        if(!margins?.size)owner.groups.delete(root)
      }
    }
    if(!owner.subscriptions.size){doc.removeEventListener('visibilitychange',owner.visibility);pools.delete(doc)}
  }
}
