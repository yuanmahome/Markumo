import type {Attrs,NodeType} from 'prosemirror-model'
import type {Command} from 'prosemirror-state'

/** Keep each block's source identity when formatting a multi-block selection. */
export function setSourceBlockType(type:NodeType,attrs:Attrs={}):Command {
  return(state,dispatch)=>{
    const tr=state.tr
    for(const {$from,$to}of state.selection.ranges)tr.setBlockType($from.pos,$to.pos,type,node=>({...node.attrs,...attrs}))
    if(!tr.docChanged)return false
    dispatch?.(tr.scrollIntoView())
    return true
  }
}
