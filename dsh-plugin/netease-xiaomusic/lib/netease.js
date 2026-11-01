/**
 * NetEase stream resolution.
 *
 * ncm-cli cannot hand out a playable URL (its `play` path needs a local player
 * daemon and no command prints the stream address), so the final hop uses the
 * same official endpoint the web player uses, authenticated by the account
 * cookie. Search / picking / playability judgement stay in ncm-cli.
 * @module netease-xiaomusic/netease
 */
import { readFileSync } from 'node:fs'

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

/** Accepted `level` values, matching the web player's quality ladder. */
export const LEVELS = ['standard', 'higher', 'exhigh', 'lossless', 'hires']

/**
 * @param {{netease: {musicU: string, level: string}}} cfg
 * @param {{info?: Function, warn?: Function, debug?: Function}} [logger]
 */
export function createNetease(cfg, logger) {
  /**
   * Read the account cookie on every call so replacing the file takes effect
   * without restarting the Host. `MUSIC_U=` prefixes from a pasted header are
   * tolerated.
   * @returns {string}
   */
  function cookieValue() {
    const direct = String(cfg.netease.musicU || '').trim()
    if (direct) return direct.replace(/^MUSIC_U=/i, '')
    const file = String(cfg.netease.cookieFile || '')
    if (!file) return ''
    try {
      const raw = readFileSync(file, 'utf8').trim().split(/\r?\n/)[0] || ''
      return raw.replace(/^MUSIC_U=/i, '').trim()
    } catch {
      return ''
    }
  }

  /**
   * @param {{originalId: string, level?: string}} input
   * @returns {Promise<{ok: true, url: string, br: number, size: number, type: string, level: string} | {ok: false, error: string, detail?: string}>}
   */
  async function resolveStream({ originalId, level }) {
    const id = String(originalId || '').trim()
    if (!/^\d+$/.test(id)) return { ok: false, error: 'NCM_BAD_ID' }

    const musicU = cookieValue()
    if (!musicU) return { ok: false, error: 'NCM_COOKIE_MISSING', detail: cfg.netease.cookieFile }

    const want = LEVELS.includes(level) ? level : cfg.netease.level
    const endpoint =
      `https://music.163.com/api/song/enhance/player/url/v1` +
      `?ids=[${id}]&level=${encodeURIComponent(want)}&encodeType=mp3`

    const headers = { 'User-Agent': USER_AGENT, Referer: 'https://music.163.com/', Cookie: `MUSIC_U=${musicU}` }

    let body
    try {
      const res = await fetch(endpoint, { headers, signal: AbortSignal.timeout(8000) })
      if (!res.ok) return { ok: false, error: 'NCM_HTTP_ERROR', detail: `HTTP ${res.status}` }
      body = await res.json()
    } catch (err) {
      return { ok: false, error: 'NCM_NETWORK_ERROR', detail: String(err?.message ?? err).slice(0, 160) }
    }

    const d = body?.data?.[0] || {}
    const url = String(d.url || '')

    if (d.code === 200 && url && !d.freeTrialInfo) {
      logger?.debug?.(`netease-xiaomusic: resolved ${id} at ${want} (${d.br}bps, ${d.size} bytes)`)
      return { ok: true, url, br: Number(d.br || 0), size: Number(d.size || 0), type: String(d.type || ''), level: want }
    }
    if (d.code === -110) return { ok: false, error: 'NCM_COOKIE_INVALID' }
    if (d.code === 404 || (!url && d.code === 200)) return { ok: false, error: 'NCM_NO_SOURCE' }
    if (d.freeTrialInfo) return { ok: false, error: 'NCM_VIP_REQUIRED' }
    return { ok: false, error: 'NCM_UNKNOWN', detail: `code=${d.code ?? '?'}` }
  }

  /**
   * One web-API song record in the shape the CLI search returns.
   *
   * The search endpoint names fields `artists`/`album`/`duration` while the
   * artist catalog uses `ar`/`al`/`dt`; accept both so callers see one shape.
   * @param {any} s
   */
  function mapWebSong(s) {
    const artists = s?.artists || s?.ar || []
    const album = s?.album || s?.al || {}
    const duration = Number(s?.duration ?? s?.dt ?? 0)
    return {
      name: String(s?.name || ''),
      artists: Array.isArray(artists) ? artists.map((a) => a?.name).filter(Boolean) : [],
      album: String(album?.name || ''),
      durationSec: Math.round(duration / 1000),
      encryptedId: '',
      originalId: String(s?.id ?? ''),
      visible: true,
      playable: true,
      vip: Number(s?.fee ?? 0) > 0,
      fee: Number(s?.fee ?? 0),
      coverUrl: '',
    }
  }

  /** @param {string} url */
  async function webJson(url, withCookie = false) {
    const headers = { 'User-Agent': USER_AGENT, Referer: 'https://music.163.com/' }
    const musicU = cookieValue()
    if (withCookie && musicU) headers.Cookie = `MUSIC_U=${musicU}`
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(8000) })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return res.json()
  }

  /**
   * Web search, used to refill a queue when the CLI's top results are only
   * same-title covers. Returns the same item shape as the CLI search.
   * @param {string} keyword
   * @param {{limit?: number}} [opts]
   * @returns {Promise<{ok: true, items: object[]} | {ok: false, error: string}>}
   */
  async function searchWeb(keyword, opts = {}) {
    const url =
      'https://music.163.com/api/search/get/web?csrf_token=' +
      `&s=${encodeURIComponent(keyword)}&type=1&offset=0&total=true&limit=${Math.min(50, opts.limit || 30)}`
    try {
      const body = await webJson(url, true)
      const songs = body?.result?.songs || []
      return { ok: true, items: songs.map(mapWebSong) }
    } catch (err) {
      return { ok: false, error: 'NCM_NETWORK_ERROR', detail: String(err?.message ?? err).slice(0, 120) }
    }
  }

  /**
   * Artist lookup by name.
   *
   * A request like 「播放许嵩的歌」 is a request for a performer, not for a title:
   * searching songs for that sentence returns tracks literally named 许嵩的歌 by
   * other people, which is how the speaker ended up playing the wrong artist.
   * @param {string} name
   * @param {{limit?: number}} [opts]
   * @returns {Promise<{ok: true, items: {id: string, name: string, alias: string[]}[]} | {ok: false, error: string}>}
   */
  async function searchArtist(name, opts = {}) {
    const url =
      'https://music.163.com/api/search/get/web?csrf_token=' +
      `&s=${encodeURIComponent(name)}&type=100&offset=0&total=true&limit=${Math.min(20, opts.limit || 6)}`
    try {
      const body = await webJson(url, true)
      const artists = body?.result?.artists || []
      return {
        ok: true,
        items: artists.map((a) => ({
          id: String(a?.id ?? ''),
          name: String(a?.name || ''),
          alias: Array.isArray(a?.alias) ? a.alias.map((x) => String(x)) : [],
        })),
      }
    } catch (err) {
      return { ok: false, error: 'NCM_NETWORK_ERROR', detail: String(err?.message ?? err).slice(0, 120) }
    }
  }

  /**
   * An artist's hot songs, in the item shape the rest of the plugin uses.
   * @param {string} artistId
   * @param {{limit?: number}} [opts]
   * @returns {Promise<{ok: true, items: object[]} | {ok: false, error: string}>}
   */
  async function artistTopSongs(artistId, opts = {}) {
    const id = String(artistId || '').trim()
    if (!/^\d+$/.test(id)) return { ok: false, error: 'NCM_BAD_ID' }
    try {
      const body = await webJson(`https://music.163.com/api/artist/top/song?id=${id}`, true)
      const songs = body?.songs || body?.hotSongs || []
      if (!Array.isArray(songs) || songs.length === 0) return { ok: false, error: 'NCM_NO_SOURCE' }
      const limit = Math.max(1, Math.min(50, opts.limit || 30))
      return { ok: true, items: songs.slice(0, limit).map(mapWebSong) }
    } catch (err) {
      return { ok: false, error: 'NCM_NETWORK_ERROR', detail: String(err?.message ?? err).slice(0, 120) }
    }
  }

  return { resolveStream, searchWeb, searchArtist, artistTopSongs }
}
