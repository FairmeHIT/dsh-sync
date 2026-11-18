/**
 * Connection settings live in the same `cordis.patch.yml` this plugin syncs.
 * Pull writes the remote copy of that file wholesale, so a row edited through
 * the settings card would be replaced by whatever another machine committed —
 * the new machine then loses its Git remote and every operation fails with
 * E_CONFIG.
 *
 * This module finds that one row so it can be held back from the synced copy
 * (it never reaches the repository, so it can never come back from it) and
 * re-applied after a Pull. Everything else in the file is a byte-exact slice:
 * indices are plain character offsets, so callers may pass a latin1 view of a
 * Buffer and splice the original bytes without any re-encoding.
 */

/** The synced file that carries per-machine connection settings. */
export const CONNECTION_FILE = 'cordis.patch.yml'

const ROW_ID = /^- +id:[ \t]*(?:"([^"]*)"|'([^']*)'|([^\s#]+))[ \t]*(?:#.*)?$/
const TOP_LEVEL_ITEM = /^- /

function rowIdOf(line) {
  const match = ROW_ID.exec(line)
  if (!match) return null
  return match[1] ?? match[2] ?? match[3] ?? null
}

/** Offset of every line start, so row boundaries survive CRLF and blank lines. */
function lineStarts(text) {
  const starts = [0]
  for (let index = text.indexOf('\n'); index !== -1; index = text.indexOf('\n', index + 1)) {
    starts.push(index + 1)
  }
  return starts
}

function lineAt(text, starts, index) {
  const start = starts[index]
  const next = index + 1 < starts.length ? starts[index + 1] : text.length
  const end = next > start && text[next - 1] === '\n' ? next - 1 : next
  return { start, end, content: text.slice(start, end).replace(/\r$/, '') }
}

/**
 * Span of the top-level patch item whose `id` is `id`. A nested `- id:` deeper
 * in the YAML is not a patch row and must never match.
 */
export function findRowSpan(text, id) {
  const source = String(text ?? '')
  if (!source) return null
  const starts = lineStarts(source)
  let start = null
  for (let index = 0; index < starts.length; index += 1) {
    const line = lineAt(source, starts, index)
    if (start === null) {
      if (TOP_LEVEL_ITEM.test(line.content) && rowIdOf(line.content) === id) start = line.start
      continue
    }
    // The next top-level item starts the following row; its offset is this
    // row's exclusive end. Trailing blank lines stay with the removed row.
    if (TOP_LEVEL_ITEM.test(line.content)) return { start, end: line.start }
  }
  return start === null ? null : { start, end: source.length }
}

/**
 * Line ending the given text already uses inside `block`, so re-applying a row
 * never mixes CRLF and LF in a file that was consistent before.
 */
function eolOf(text, fallback = '\n') {
  const crlf = text.indexOf('\r\n') !== -1
  const lfOnly = /(^|[^\r])\n/.test(text)
  if (crlf) return '\r\n'
  return lfOnly ? '\n' : fallback
}

/** Exact text of the row, ending in one newline; null when absent. */
export function rowText(text, id) {
  const span = findRowSpan(text, id)
  if (!span) return null
  const source = String(text)
  const block = source.slice(span.start, span.end).replace(/\s+$/, '')
  if (!block) return null
  return `${block}${eolOf(block)}`
}

/** Remove the row; every other byte is preserved. */
export function stripConnectionRow(text, id) {
  const source = String(text ?? '')
  const span = findRowSpan(source, id)
  if (!span) return source
  return source.slice(0, span.start) + source.slice(span.end)
}

/**
 * Build the file to write locally: the remote copy without any connection row,
 * plus this machine's own row. A machine without one keeps the remote's row.
 */
export function mergeConnectionRow(remoteText, localText, id) {
  const remote = String(remoteText ?? '')
  const localRow = rowText(localText, id)
  if (!localRow) return remote
  const base = stripConnectionRow(remote, id)
  if (!base) return localRow
  // Match the file's own line endings, so the result stays byte-consistent
  // with the remote copy wherever the row is not involved.
  const eol = eolOf(remote)
  const normalizedRow = eol === '\n' ? localRow : localRow.replace(/\r?\n/g, eol)
  const separator = base.endsWith('\n') ? '' : eol
  return `${base}${separator}${normalizedRow}`
}
