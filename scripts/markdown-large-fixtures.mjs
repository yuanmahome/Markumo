import fs from 'node:fs'
import path from 'node:path'
import {createHash} from 'node:crypto'
const dir=path.resolve('test-results/markdown-large/fixtures');fs.mkdirSync(dir,{recursive:true})
const block='# 标题 Heading\n\n中文正文与 English words，emoji 👩‍💻 和 é。\n\n- 项目\n  - 子项\n\n| 列 A | 列 B |\n| --- | --- |\n| 内容 | value |\n\n```js\nconst value = 42\n```\n\n'
const fixtures=[], ending='\n\n# DOCUMENT_END\n'
function save(name,text){const file=path.join(dir,`${name}.md`),buffer=Buffer.from(text);fs.writeFileSync(file,buffer);fixtures.push({name,file,bytes:buffer.length,chars:text.length,lines:text.split('\n').length,sha256:createHash('sha256').update(buffer).digest('hex')})}
for(const kb of [100,500,1024,2048,5120,10240]){const bytes=kb*1024,body=block.repeat(Math.floor((bytes-Buffer.byteLength(ending))/Buffer.byteLength(block)));save(`${kb}kb`,body+'x'.repeat(bytes-Buffer.byteLength(body)-Buffer.byteLength(ending))+ending)}
const body=block.repeat(Math.floor((950000-ending.length)/block.length));save('950k',body+'x'.repeat(950000-body.length-ending.length)+ending)
save('tables',('| A | B |\n| --- | --- |\n| 长表 | value |\n\n').repeat(12000))
save('mermaid',('```mermaid\ngraph TD\n A-->B\n```\n\n').repeat(4000))
save('paragraph','# Long paragraph\n\n'+'中文word👩‍💻 '.repeat(100000)+'\n\n# DOCUMENT_END\n')
save('fence','# Long fence\n\n```text\n'+'x'.repeat(2000000)+'\n```\n\n# DOCUMENT_END\n')
fs.writeFileSync(path.dirname(dir)+'/fixtures.json',JSON.stringify(fixtures,null,2));console.log(fixtures.map(({name,chars,bytes})=>({name,chars,bytes})))
