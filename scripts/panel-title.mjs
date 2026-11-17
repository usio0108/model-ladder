const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/
const segments = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

export function displayWidth(text) {
  return [...segments.segment(String(text).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, ''))].reduce((width, { segment }) => {
    if (/\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(segment)) return width + 2
    const code = segment.codePointAt(0)
    if (/^[\p{Mark}]+$/u.test(segment)) return width
    return width + (code >= 0x1100 && (code <= 0x115f || code === 0x2329 || code === 0x232a ||
      code >= 0x2e80 && code <= 0xa4cf || code >= 0xac00 && code <= 0xd7a3 ||
      code >= 0xf900 && code <= 0xfaff || code >= 0xfe10 && code <= 0xfe6f ||
      code >= 0xff01 && code <= 0xff60 || code >= 0xffe0 && code <= 0xffe6 ||
      code >= 0x20000 && code <= 0x3fffd) ? 2 : 1)
  }, 0)
}

export function panelTitle(manifest) {
  try {
    const version = JSON.parse(manifest).version
    return typeof version === 'string' && VERSION.test(version) ? `model-ladder (v${version})` : 'model-ladder'
  } catch { return 'model-ladder' }
}
