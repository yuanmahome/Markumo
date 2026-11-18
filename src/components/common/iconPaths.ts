export const commonIconPaths = {
  search: 'M21 21l-6-6 M17 10a7 7 0 1 1-14 0 7 7 0 1 1 14 0',
  copy: 'M9 9h11v12H9z M5 15H3V3h12v2',
  check: 'm5 12 4 4L19 6',
  chevronRight: 'm9 6 6 6-6 6',
  chevronDown: 'm6 9 6 6 6-6',
  arrowUp: 'm6 10 6-6 6 6 M12 4v16',
  arrowDown: 'm6 14 6 6 6-6 M12 4v16',
  close: 'm6 6 12 12 M6 18 18 6',
  matchCase: 'm2 18 5-12 5 12 M4 14h6 M21 11v7 M21 13c-4-4-8 4-3 5 2 0 3-1 3-2',
  wholeWord: 'M4 20h16 M4 17v3 M20 17v3 M5 8c4-2 5 0 5 2v5 M10 11c-6-2-7 5-2 4l2-1 M15 4v11 M15 10c6-5 7 7 2 5l-2-1',
  regex: 'M5 17h.01 M14 5v10 M10 7l8 6 M10 13l8-6',
  replace: 'M4 5h9 M10 2l3 3-3 3 M4 5v6 M7 14h13v7H7z M10 17h7',
  replaceAll: 'M3 5h10 M10 2l3 3-3 3 M3 5v5 M7 13h14v8H7z M11 9h10 M3 17v4 M11 17h6',
  selectMatches: 'M4 4h16v16H4z M8 9h8 M8 15h8',
} as const
export function copyStatusIcon(done = false) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true')
  svg.setAttribute('fill', 'none'); svg.setAttribute('stroke', 'currentColor'); svg.setAttribute('stroke-width', '1.7')
  const path = document.createElementNS(svg.namespaceURI, 'path')
  path.setAttribute('d', done ? commonIconPaths.check : commonIconPaths.copy)
  svg.append(path); return svg
}
