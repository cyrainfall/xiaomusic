/**
 * Config projection.
 *
 * The plugin declares no `Config` export: an out-of-tree bundle installed from a
 * local directory cannot rely on resolving the host's schema package, so the raw
 * patch config is repaired here instead of being validated by the Loader.
 * @module netease-xiaomusic/config
 */
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Where a cookie drops without ever entering a checked-in patch. */
export const DEFAULT_COOKIE_FILE = join(homedir(), '.dsh', 'netease-music-u.txt')

/** Where the managed xiaomusic install lives when the operator sets no `home`. */
export const DEFAULT_XIAOMUSIC_HOME = join(homedir(), '.dsh', 'xiaomusic')

/** @param {unknown} value @returns {Record<string, any>} */
const obj = (value) => (value && typeof value === 'object' && !Array.isArray(value) ? value : {})

/** @param {unknown} value @param {string} fallback @returns {string} */
const str = (value, fallback = '') => (typeof value === 'string' ? value : fallback)

/** @param {unknown} value @param {number} fallback @returns {number} */
const num = (value, fallback) => (Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : fallback)

/**
 * Project the row config into a usable settings object.
 * @param {unknown} raw config from `cordis.patch.yml`
 * @returns {object} normalized settings
 */
export function normalizeConfig(raw) {
  const r = obj(raw)
  const xm = obj(r.xiaomusic)
  const ne = obj(r.netease)
  const to = obj(r.timeouts)
  const vb = obj(r.voiceBridge)
  const q = obj(r.queue)

  // A `baseUrl` with a host that is not this machine means the operator runs
  // xiaomusic elsewhere, so the plugin must not start or patch a local copy.
  const baseUrl = str(xm.baseUrl, '').replace(/\/+$/, '')
  const external = Boolean(baseUrl) && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/i.test(baseUrl)
  const port = num(xm.port, Number((baseUrl.match(/:(\d+)$/) || [])[1]) || 8090)

  return {
    enabled: r.enabled !== false,
    xiaomusic: {
      // managed=false keeps the old behaviour: talk to a service someone else started.
      managed: external ? false : xm.managed !== false,
      baseUrl: baseUrl || `http://127.0.0.1:${port}`,
      // Install directory for the managed runtime; its music and conf live here too.
      // An empty string in the patch means "use the default", not "no directory".
      home: str(xm.home) || DEFAULT_XIAOMUSIC_HOME,
      version: str(xm.version, '0.6.1'),
      pythonVersion: str(xm.pythonVersion, '3.12'),
      // Explicit interpreter wins over the generated environment.
      python: str(xm.python),
      port,
      // Speaker-facing host: the device downloads TTS audio from it, so it cannot
      // be loopback. Empty means "detect the LAN address".
      hostname: str(xm.hostname),
      // Xiaomi account used by the managed runtime.
      account: str(xm.account),
      password: str(xm.password),
      miDid: str(xm.miDid),
      startTimeoutMs: num(xm.startTimeoutMs, 120000),
      // HTTP basic auth when talking to the API.
      username: str(xm.username),
      httpauthPassword: str(xm.httpauthPassword),
    },
    defaultSpeaker: str(r.defaultSpeaker),
    ncmCli: str(r.ncmCli, 'ncm-cli'),
    netease: {
      // Env wins so the cookie can stay out of a checked-in patch.
      musicU: str(process.env.DSH_NETEASE_MUSIC_U, '') || str(ne.musicU),
      // Fallback: a file the operator can rewrite without restarting the Host.
      cookieFile: str(ne.cookieFile, DEFAULT_COOKIE_FILE),
      level: str(ne.level, 'exhigh'),
    },
    timeouts: {
      ncmMs: num(to.ncmMs, 15000),
      xiaomusicMs: num(to.xiaomusicMs, 8000),
    },
    voiceBridge: {
      enabled: vb.enabled !== false,
      host: str(vb.host, '127.0.0.1'),
      port: num(vb.port, 3071),
      token: str(vb.token),
      agentTimeoutMs: num(vb.agentTimeoutMs, 30000),
    },
    queue: {
      // random=队列总是随机取（默认）；follow=跟随 xiaomusic 的播放模式；
      // sequential=总是按顺序
      mode: ['random', 'follow', 'sequential'].includes(str(q.mode)) ? str(q.mode) : 'random',
      // Off by default: continuing past the pushed track is opt-in because a wrong
      // call would start music nobody asked for.
      autoAdvance: q.autoAdvance === true,
    },
  }
}
