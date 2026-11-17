const PRIVATE_KEY = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/

const TOKEN_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{20,}\b/,
  /\bghp_[A-Za-z0-9]{20,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bAIza[0-9A-Za-z_-]{35}\b/,
]

const SECRET_KEY =
  /^(?:api[_-]?key|apiKey|secret|token|password|passwd|passphrase|access[_-]?key|accessKey|accessToken|refreshToken|idToken|private[_-]?key|privateKey|client[_-]?secret|clientSecret|authorization)$/i
const SAFE_KEY_SUFFIX = /(env|file|path|url|name|ref|helper|command|bin|ttl|expires|header|prefix)$/i
const KEY_LINE = /^(\s*)["']?([A-Za-z0-9_.-]+)["']?\s*:\s*(.*)$/
const EMPTY_VALUE = /^(?:|['"]{2}|~|null|undefined|false|true|\$\{[^}]*\}|\$[A-Za-z_][A-Za-z0-9_]*)$/

function mask(value) {
  const text = String(value ?? '')
  if (text.length <= 8) return '<redacted>'
  return `${text.slice(0, 4)}...<redacted>`
}

/**
 * Heuristic only: flag obvious inline credentials in files that are about to be
 * pushed. Environment-variable references, comments and empty values are
 * ignored so the common `apiKeyEnv: MY_KEY` form does not warn.
 */
export function scanForSecrets(files) {
  const findings = []
  const seen = new Set()
  for (const [path, data] of files) {
    const lines = data.toString('utf8').split(/\r?\n/)
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]
      if (!line || line.trimStart().startsWith('#')) continue
      const lineNumber = index + 1
      if (PRIVATE_KEY.test(line)) addFinding(findings, seen, path, lineNumber, 'private key block')
      for (const pattern of TOKEN_PATTERNS) {
        if (pattern.test(line)) addFinding(findings, seen, path, lineNumber, 'token-like value')
      }
      const match = KEY_LINE.exec(line)
      if (!match) continue
      const key = match[2]
      if (!SECRET_KEY.test(key) || SAFE_KEY_SUFFIX.test(key)) continue
      const value = match[3].trim()
      if (EMPTY_VALUE.test(value)) continue
      const reason = `${key} has an inline value (${mask(value.replace(/^['"]|['"]$/g, ''))})`
      addFinding(findings, seen, path, lineNumber, reason)
    }
  }
  return findings
}

function addFinding(findings, seen, path, line, reason) {
  const key = `${path}:${line ?? ''}:${reason}`
  if (seen.has(key)) return
  seen.add(key)
  findings.push({ path, line, reason })
}

export function summarizeSecrets(findings) {
  if (!findings || findings.length === 0) return ''
  const lines = ['Possible inline credentials found in managed files:']
  for (const finding of findings.slice(0, 8)) {
    lines.push(`  ${finding.path}${finding.line ? `:${finding.line}` : ''}: ${finding.reason}`)
  }
  if (findings.length > 8) lines.push(`  ... and ${findings.length - 8} more`)
  lines.push(
    'The push is allowed, but keep the repository private and prefer environment-variable references.',
  )
  return lines.join('\n')
}
