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

/** @param {unknown} value @returns {Record<string, any>} */
const obj = (value) => (value && typeof value === 'object' && !Array.isArray(value) ? value : {})

/** @param {unknown} value @param {string} fallback @returns {string} */
const str = (value, fallback = '') => (typeof value === 'string' ? value : fallback)

/** @param {unknown} value @param {number} fallback @returns {number} */
const num = (value, fallback) => (Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : fallback)

/**
 * Project the row config into a usable settings object.
 * @param {unknown} raw config from `cordis.patch.yml`
 * @returns {{enabled: boolean, xiaomusic: {baseUrl: string, username: string, password: string}, defaultSpeaker: string, ncmCli: string, netease: {musicU: string, cookieFile: string, level: string}, timeouts: {ncmMs: number, xiaomusicMs: number}}}
 */
export function normalizeConfig(raw) {
  const r = obj(raw)
  const xm = obj(r.xiaomusic)
  const ne = obj(r.netease)
  const to = obj(r.timeouts)
  const vb = obj(r.voiceBridge)
  const q = obj(r.queue)

  return {
    enabled: r.enabled !== false,
    xiaomusic: {
      baseUrl: str(xm.baseUrl, 'http://127.0.0.1:8090').replace(/\/+$/, ''),
      username: str(xm.username),
      password: str(xm.password),
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
