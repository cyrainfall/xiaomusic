/**
 * ncm-cli adapter: command resolution, search, and error normalization.
 *
 * ncm-cli ships as a `bin` shim, so the Windows `.cmd` wrapper is parsed back to
 * the real `dist/index.js` and run with the current Node binary. That avoids
 * shell quoting entirely (Chinese keywords, spaces) and works for npm, pnpm and
 * user-local installs alike.
 * @module netease-xiaomusic/ncm
 */
import { execFile } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { delimiter, dirname, isAbsolute, join } from 'node:path'

/** @param {string} cliPath @returns {string | undefined} absolute path to dist/index.js */
export function resolveNcmEntry(cliPath) {
  if (cliPath.endsWith('.js') && existsSync(cliPath)) return cliPath

  const exts = (process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';').filter(Boolean)
  const dirs = (process.env.PATH || '').split(delimiter).filter(Boolean)

  for (const dir of dirs) {
    for (const ext of ['', ...exts]) {
      const full = join(dir, cliPath + ext)
      if (!existsSync(full)) continue
      const lower = full.toLowerCase()
      if (lower.endsWith('.js')) return full
      if (lower.endsWith('.cmd') || lower.endsWith('.bat')) {
        const entry = entryFromShim(full)
        if (entry) return entry
        continue
      }
      if (lower.endsWith('.exe')) return full
    }
  }
  return undefined
}

/** @param {string} shim @returns {string | undefined} */
function entryFromShim(shim) {
  let text
  try {
    text = readFileSync(shim, 'utf8')
  } catch {
    return undefined
  }
  const hits = text.match(/"([^"]*?\.js)"/g) || []
  for (const hit of hits) {
    const cleaned = hit
      .slice(1, -1)
      .replace(/%~dp0\\?/i, '')
      .replace(/%dp0%\\?/i, '')
    const full = isAbsolute(cleaned) ? cleaned : join(dirname(shim), cleaned)
    if (existsSync(full)) return full
  }
  return undefined
}

/** @param {{stdout: string, stderr: string, code?: number | string}} r @returns {string} */
function classify(r) {
  const blob = `${r.stderr || ''}${r.stdout || ''}`
  if (/未登录|请先登录|未授权/.test(blob)) return 'NCM_NOT_LOGGED_IN'
  if (/timeout|ETIMEDOUT|killed/i.test(blob) || r.code === 'ETIMEDOUT') return 'NCM_TIMEOUT'
  if (/请求总量超限|超限/.test(blob)) return 'NCM_RATE_LIMITED'
  return 'NCM_CLI_FAILED'
}

/** @param {any} song @returns {object} compact song */
function mapSong(song) {
  const artists = Array.isArray(song?.artists) ? song.artists.map((a) => a?.name).filter(Boolean) : []
  return {
    name: String(song?.name || ''),
    artists,
    album: String(song?.album?.name || ''),
    durationSec: Math.round(Number(song?.duration || 0) / 1000),
    encryptedId: String(song?.id || ''),
    originalId: String(song?.originalId ?? ''),
    visible: song?.visible !== false,
    playable: song?.visible !== false && song?.playFlag === true,
    vip: song?.vipFlag === true,
    fee: Number(song?.songFee ?? 0),
    coverUrl: String(song?.coverImgUrl || ''),
  }
}

/**
 * @param {{ncmCli: string, timeouts: {ncmMs: number}}} cfg
 * @param {{info?: Function, warn?: Function, debug?: Function}} [logger]
 */
export function createNcm(cfg, logger) {
  const entry = resolveNcmEntry(cfg.ncmCli)
  if (!entry) logger?.warn?.('netease-xiaomusic: ncm-cli not found on PATH; search will fail until it is installed')

  /** @param {string[]} args @param {number} timeoutMs @returns {Promise<{ok: boolean, code?: any, stdout: string, stderr: string, error?: string}>} */
  const run = (args, timeoutMs) =>
    new Promise((resolve) => {
      if (!entry) {
        resolve({ ok: false, stdout: '', stderr: '', error: 'NCM_CLI_NOT_FOUND' })
        return
      }
      execFile(
        process.execPath,
        [entry, ...args],
        { timeout: timeoutMs, windowsHide: true, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 },
        (err, stdout, stderr) => {
          const out = String(stdout || '')
          const errOut = String(stderr || '')
          if (err) resolve({ ok: false, code: err.code, stdout: out, stderr: errOut, error: classify({ stdout: out, stderr: errOut, code: err.code }) })
          else resolve({ ok: true, stdout: out, stderr: errOut })
        },
      )
    })

  /**
   * Search songs. Returns compact candidates with both ids so the caller can
   * pass either a keyword (re-pick) or the exact ids it chose.
   * @param {string} keyword @param {number} [limit]
   */
  async function searchSongs(keyword, limit = 8) {
    const r = await run(['search', 'song', '--keyword', keyword, '--output', 'json'], cfg.timeouts.ncmMs)
    if (!r.ok) return { ok: false, error: r.error || 'NCM_CLI_FAILED', detail: (r.stderr || '').slice(0, 200) }

    let data
    try {
      data = JSON.parse(r.stdout)
    } catch {
      return { ok: false, error: 'NCM_BAD_JSON', detail: r.stdout.slice(0, 160) }
    }
    if (data?.code !== 200) return { ok: false, error: 'NCM_API_ERROR', detail: String(data?.message || data?.code) }

    const records = data?.data?.records || []
    return { ok: true, items: records.slice(0, Math.max(1, Math.min(20, limit))).map(mapSong) }
  }

  /** @returns {Promise<{ok: boolean, loggedIn: boolean, error?: string}>} */
  async function loginState() {
    const r = await run(['login', '--check'], Math.min(cfg.timeouts.ncmMs, 8000))
    if (!r.ok) return { ok: false, loggedIn: false, error: r.error || 'NCM_CLI_FAILED' }
    try {
      const j = JSON.parse(r.stdout)
      return { ok: true, loggedIn: j?.success === true }
    } catch {
      return { ok: true, loggedIn: /"success":\s*true/.test(r.stdout) }
    }
  }

  return { entry, run, searchSongs, loginState }
}
