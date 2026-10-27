import type { SyntaxNode } from '@lezer/common'
import type { Text } from '@codemirror/state'
import type { OutlineItem } from './outlineService'

type Kind = NonNullable<OutlineItem['kind']>
interface SymbolNode { name: SyntaxNode; kind: Kind; label?:string; detail?: string }
type Adapter = (node: SyntaxNode, text: Text) => SymbolNode | undefined
const child = (node: SyntaxNode, ...names: string[]) => names.map(name => node.getChild(name)).find(Boolean) ?? undefined
const source = (text: Text, node?: SyntaxNode | null) => node ? text.sliceString(node.from, Math.min(node.to, node.from + 140)).replace(/\s+/g, ' ').trim() : ''
function named(node: SyntaxNode, kind: Kind, names: string[], text: Text, parameters?: string): SymbolNode | undefined {
  const name = child(node, ...names)
  if (!name || name.from === name.to || name.type.isError) return
  const params = parameters && node.getChild(parameters)
  // Do not turn a recovered, unfinished signature into a convincing declaration.
  if (params && (!params.getChild(')') || params.getChild('⚠'))) return
  return { name, kind, detail: params ? source(text, params) : undefined }
}
const js: Adapter = (node, text) => {
  const kinds: Record<string, Kind> = {ClassDeclaration:'class',ClassExpression:'class',InterfaceDeclaration:'interface',EnumDeclaration:'enum',TypeAliasDeclaration:'type',FunctionDeclaration:'function',MethodDeclaration:'method',MethodType:'method',PropertyType:'field'}
  if (kinds[node.name]) {
    const result = named(node,kinds[node.name],['VariableDefinition','TypeDefinition','PropertyDefinition'],text,'ParamList')
    if (result?.kind === 'method' && source(text,result.name) === 'constructor') result.kind='constructor'
    return result
  }
  if (node.name === 'PropertyDeclaration' || node.name === 'Property') {
    const name = node.getChild('PropertyDefinition')
    if (!name) return
    const fn = child(node,'ArrowFunction','FunctionExpression')
    const params = node.getChild('ParamList') || fn?.getChild('ParamList')
    return {name,kind:params?'method':'field',detail:source(text,params || node.getChild('TypeAnnotation'))}
  }
  if (node.name === 'ArrowFunction' || node.name === 'FunctionExpression' || node.name === 'ObjectExpression') {
    if (node.parent?.name !== 'VariableDeclaration') return
    let previous = node.prevSibling
    while (previous && previous.name !== 'VariableDefinition' && previous.name !== ',') previous=previous.prevSibling
    if (previous?.name !== 'VariableDefinition') return
    return {name:previous,kind:node.name==='ObjectExpression'?'object':'function',detail:source(text,node.getChild('ParamList'))}
  }
  if (node.name === 'PropertyName' && node.parent?.name === 'EnumBody') return {name:node,kind:'member'}
}
const java: Adapter = (node,text) => {
  const kinds: Record<string,Kind> = {ClassDeclaration:'class',InterfaceDeclaration:'interface',EnumDeclaration:'enum',RecordDeclaration:'struct',RecordComponent:'field',MethodDeclaration:'method',ConstructorDeclaration:'constructor',EnumConstant:'member'}
  if (kinds[node.name]) return named(node,kinds[node.name],['Definition'],text,'FormalParameters')
  if (node.name==='VariableDeclarator' && node.parent?.name==='FieldDeclaration') {
    const result=named(node,'field',['Definition'],text)
    if(result)result.detail=source(text,child(node.parent,'TypeName','PrimitiveType','ArrayType'))
    return result
  }
}
const python: Adapter = (node,text) => {
  if(node.name==='ClassDefinition')return named(node,'class',['VariableName'],text)
  if(node.name==='FunctionDefinition'){
    let wrapper=node.parent
    if(wrapper?.name==='DecoratedStatement')wrapper=wrapper.parent
    const owner=wrapper?.parent
    const result=named(node,owner?.name==='ClassDefinition'?'method':'function',['VariableName'],text,'ParamList')
    if(result && owner?.name==='ClassDefinition' && source(text,result.name)==='__init__')result.kind='constructor'
    return result
  }
  if(node.name==='AssignStatement' && node.parent?.parent?.name==='ClassDefinition')return named(node,'field',['VariableName'],text)
}
const go: Adapter = (node,text) => {
  if(node.name==='TypeSpec'){
    return named(node,node.getChild('StructType')?'struct':node.getChild('InterfaceType')?'interface':'type',['DefName'],text)
  }
  if(node.name==='FunctionDecl')return named(node,'function',['DefName'],text,'Parameters')
  if(node.name==='MethodDecl'){
    const result=named(node,'method',['FieldName'],text)
    const params=node.getChildren('Parameters')
    if(result)result.detail=source(text,params[0])+' '+source(text,params[1])
    return result
  }
  if(node.name==='MethodElem')return named(node,'method',['FieldName'],text,'Parameters')
  if(node.name==='FieldName' && node.parent?.name==='FieldDecl')return {name:node,kind:'field'}
}
const rust: Adapter = (node,text) => {
  const kinds:Record<string,Kind>={StructItem:'struct',EnumItem:'enum',TraitItem:'trait',TypeItem:'type',EnumVariant:'member',FieldDeclaration:'field',ModItem:'namespace'}
  if(kinds[node.name])return named(node,kinds[node.name],node.name==='FieldDeclaration'?['FieldIdentifier']:['TypeIdentifier','Identifier'],text)
  if(node.name==='ImplItem'){
    const name=child(node,'TypeIdentifier','GenericType','ScopedTypeIdentifier')
    const body=node.getChild('DeclarationList')
    if(name && body)return {name,kind:'impl',label:text.sliceString(node.from,body.from).replace(/\s+/g,' ').trim()}
  }
  if(node.name==='FunctionItem'){
    const owner=node.parent?.parent
    return named(node,owner && ['ImplItem','TraitItem'].includes(owner.name)?'method':'function',['BoundIdentifier'],text,'ParamList')
  }
}
const cpp: Adapter = (node,text) => {
  const kinds:Record<string,Kind>={NamespaceDefinition:'namespace',ClassSpecifier:'class',StructSpecifier:'struct',EnumSpecifier:'enum',AliasDeclaration:'type',Enumerator:'member'}
  // Elaborated type uses share these node names with declarations. Require a
  // definition body rather than displaying every `class T*` / `enum T` use.
  if(['ClassSpecifier','StructSpecifier'].includes(node.name)&&!node.getChild('FieldDeclarationList'))return
  if(node.name==='EnumSpecifier'&&!node.getChild('EnumeratorList'))return
  if(kinds[node.name])return named(node,kinds[node.name],['TypeIdentifier','Identifier'],text)
  if(['FunctionDefinition','Declaration','FieldDeclaration'].includes(node.name)){
    let owner:SyntaxNode|undefined=node,declaration:SyntaxNode|undefined
    for(let depth=0;owner&&depth<8;depth++){
      declaration=owner.getChild('FunctionDeclarator')||undefined
      if(declaration)break
      owner=child(owner,'PointerDeclarator','ReferenceDeclarator','ParenthesizedDeclarator','AttributedDeclarator')
    }
    if(declaration){
      const result=named(declaration,declaration.getChild('ScopedIdentifier')?'method':'function',['ScopedIdentifier','FieldIdentifier','Identifier','DestructorName','OperatorName'],text,'ParameterList')
      if(!result)return
      const owner=node.parent?.parent
      if(owner && ['ClassSpecifier','StructSpecifier'].includes(owner.name)){
        result.kind=source(text,result.name)===source(text,owner.getChild('TypeIdentifier'))?'constructor':'method'
      }
      return result
    }
    if(node.name==='FieldDeclaration')return named(node,'field',['FieldIdentifier'],text)
  }
}
const php: Adapter = (node,text) => {
  const kinds:Record<string,Kind>={ClassDeclaration:'class',InterfaceDeclaration:'interface',TraitDeclaration:'trait',EnumDeclaration:'enum',EnumCase:'member',FunctionDefinition:'function',MethodDeclaration:'method'}
  if(kinds[node.name]){
    const result=named(node,kinds[node.name],['Name'],text,'ParamList')
    if(result?.kind==='method' && source(text,result.name).toLowerCase()==='__construct')result.kind='constructor'
    return result
  }
  if(node.name==='VariableDeclarator' && node.parent?.name==='PropertyDeclaration')return named(node,'field',['VariableName'],text)
}

/** Each adapter only recognizes node shapes observed in its registered parser. */
export const codeAdapters: Readonly<Record<string,Adapter>> = {
  Java:java,JavaScript:js,TypeScript:js,JSX:js,TSX:js,Vue:js,Python:python,Go:go,Rust:rust,'C++':cpp,PHP:php,
}

export function extractCodeSymbols(tree: import('@lezer/common').Tree,text:Text,language:string) {
  const adapter=codeAdapters[language],items:OutlineItem[]=[]
  if(!adapter)return {items,limited:false}
  const scopes:OutlineItem[]=[],counts=new Map<string,number>(),cursor=tree.cursor()
  let visited=0,limited=false
  const started=performance.now()
  do {
    if(++visited>50000 || (visited%256===0 && performance.now()-started>30)){limited=true;break}
    const node=cursor.node
    while(scopes.length && scopes[scopes.length-1].to!<=node.from)scopes.pop()
    if(node.type.isError)continue
    // Vue template/style syntax is never treated as script declarations.
    if(language==='Vue'){
      let ancestor:SyntaxNode|null=node
      while(ancestor && ancestor.name!=='Script')ancestor=ancestor.parent
      if(!ancestor)continue
    }
    const symbol=adapter(node,text)
    if(!symbol)continue
    if(items.length>=1000){limited=true;break}
    const name=symbol.label||source(text,symbol.name)
    if(!name)continue
    const parent=scopes[scopes.length-1]
    const key=`${parent?.id||'root'}/${symbol.kind}:${name}:${symbol.detail||''}`
    const ordinal=counts.get(key)||0;counts.set(key,ordinal+1)
    const item:OutlineItem={id:`${key}:${ordinal}`,name,kind:symbol.kind,detail:symbol.detail,
      level:(parent?.level||0)+1,parentId:parent?.id,from:symbol.name.from,to:node.to,scopeFrom:Math.min(node.from,symbol.name.from),
      lineNumber:text.lineAt(symbol.name.from).number}
    items.push(item)
    scopes.push(item)
  }while(cursor.next(!cursor.type.isError))
  return {items,limited}
}
