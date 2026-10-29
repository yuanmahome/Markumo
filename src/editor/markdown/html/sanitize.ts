import type { Config, DOMPurify } from 'dompurify'

// DOMPurify.removed holds actual nodes/attributes from the last input. Markumo
// uses the sanitized string, never this diagnostic list or its detached DOM.
export function sanitizeMarkup(purifier: Pick<DOMPurify, 'sanitize' | 'removed'>, input: string, config: Config): string {
  try {
    return purifier.sanitize(input, config)
  } finally {
    purifier.removed.length = 0
  }
}
