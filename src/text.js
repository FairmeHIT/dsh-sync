const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g

/**
 * Remote manifests are untrusted input. Render their strings on one line, strip
 * control and ANSI/OSC introducers, and bound the length so a repository cannot
 * forge extra result lines or drive terminal escapes.
 */
export function sanitizeText(value, max = 240) {
  const text = String(value ?? '')
    .replace(CONTROL, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!Number.isFinite(max) || max <= 0) return text
  return text.length > max ? `${text.slice(0, max - 1)}\u2026` : text
}

/** Clip a list of names for one-line summaries. */
export function summarizeList(values, max = 6) {
  const items = [...values].map((value) => sanitizeText(value, 120))
  if (items.length <= max) return items.join(', ')
  return `${items.slice(0, max).join(', ')} and ${items.length - max} more`
}
