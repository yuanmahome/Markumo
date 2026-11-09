/// <reference lib="es2022.intl" />
export const statisticKinds = ['words','characters','lines','english','reading'] as const
export type StatisticKind = typeof statisticKinds[number]
export interface Counts { characters:number; nonSpace:number; chinese:number; english:number; words:number; paragraphs:number; startsText:boolean; endsText:boolean }
export function countText(text:string): Counts {
  const graphemes = new Intl.Segmenter('zh',{granularity:'grapheme'})
  const words = new Intl.Segmenter('en',{granularity:'word'})
  let characters=0,nonSpace=0,chinese=0,english=0,other=0
  for(const {segment} of graphemes.segment(text)){ characters++;if(!/^\s+$/u.test(segment))nonSpace++;if(/\p{Script=Han}/u.test(segment))chinese++ }
  for(const part of words.segment(text)) if(part.isWordLike&&!/\p{Script=Han}/u.test(part.segment)){other++;if(/\p{Script=Latin}/u.test(part.segment))english++}
  const lines=text.split('\n');let paragraphs=0,inside=false
  for(const line of lines){if(line.trim()){if(!inside)paragraphs++;inside=true}else inside=false}
  return {characters,nonSpace,chinese,english,words:chinese+other,paragraphs,startsText:!!lines[0].trim(),endsText:!!lines.at(-1)?.trim()}
}
export function combine(parts: Counts[]): Counts {
  const result:Counts={characters:0,nonSpace:0,chinese:0,english:0,words:0,paragraphs:0,startsText:parts[0]?.startsText||false,endsText:parts.at(-1)?.endsText||false}
  for(let i=0;i<parts.length;i++){
    const part=parts[i]
    for(const key of ['characters','nonSpace','chinese','english','words','paragraphs'] as const)result[key]+=part[key]
    if(i){result.characters++;if(parts[i-1].endsText&&part.startsText)result.paragraphs--}
  }
  return result
}
