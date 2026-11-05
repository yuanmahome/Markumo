import { GFM } from '@lezer/markdown'
import { cjkEmphasisSyntax } from './cjkEmphasis'
/** One policy for the source parser and read-only renderer. */
export const markdownSyntaxExtensions = [GFM, cjkEmphasisSyntax]
export const markdownSemantics = { html:true, breaks:true, linkify:true, typographer:false } as const
