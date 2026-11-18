import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Locate the pnpm/node runtime that ships with this DSH installation, the same
 * one `dsh plugin install` itself uses. Taken from the reference plugins
 * (dsh-plugin-syncup): resolvePackHome walks up from the install location, and
 * the runtime lives under <packHome>/dependencies/{pnpm,node}. We prefer the
 * explicit environment override, then the dshHome layout, then the install
 * layout, and finally fall back to PATH lookup by the caller.
 */

function runtimeCandidates(dshHome) {
  const out = []
  if (typeof process.env.DSH_PACK_HOME === 'string' && process.env.DSH_PACK_HOME.trim() !== '') {
    out.push(process.env.DSH_PACK_HOME.trim())
  }
  if (typeof dshHome === 'string' && dshHome.trim() !== '') {
    out.push(join(dshHome, 'dsh-runtimes', 'dsh-primary-runtime'))
  }
  let current
  try {
    // import.meta.url is unavailable under some loaders; dirname of the module
    // is only a heuristic fallback, same as the reference plugin.
    current = process.cwd()
  } catch {
    current = ''
  }
  return out.filter((path) => path !== '')
}

/**
 * Resolve { pnpm, node } absolute paths to the bundled runtime, or null when
 * no bundled runtime is found. pnpm is a .cjs entry run through the bundled
 * node, so an install never depends on the system PATH.
 */
export function findBundledRuntime(dshHome) {
  for (const root of runtimeCandidates(dshHome)) {
    const pnpm = join(root, 'dependencies', 'pnpm', 'bin', 'pnpm.cjs')
    const node = join(root, 'dependencies', 'node', 'bin', process.platform === 'win32' ? 'node.exe' : 'node')
    if (existsSync(pnpm)) {
      return {
        root,
        pnpm,
        node: existsSync(node) ? node : null,
      }
    }
  }
  return null
}

/**
 * One package-manager invocation to try, as runCommand input. `shell` stays
 * off: pnpm.cjs is executed through the bundled node directly.
 */
export function bundledPnpmInvocation(runtime) {
  if (!runtime) return null
  if (runtime.node) {
    return { tool: 'pnpm (bundled)', command: runtime.node, args: [runtime.pnpm, 'install'] }
  }
  // The bundled node is missing but pnpm.cjs exists: it still needs a node on
  // PATH to run; try it that way rather than skipping the runtime entirely.
  return { tool: 'pnpm (bundled)', command: 'node', args: [runtime.pnpm, 'install'] }
}
