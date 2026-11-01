/**
 * xiaomusic HTTP client.
 *
 * xiaomusic owns the speaker: it pushes a URL to the device over MIoT and serves
 * TTS. Every playback action therefore lands here, not in the CLI.
 * @module netease-xiaomusic/xiaomusic
 */

/**
 * @param {{xiaomusic: {baseUrl: string, username: string, password: string}, timeouts: {xiaomusicMs: number}}} cfg
 * @param {{info?: Function, warn?: Function, debug?: Function}} [logger]
 */
export function createXiaomusic(cfg, logger) {
  const base = cfg.xiaomusic.baseUrl
  const auth =
    cfg.xiaomusic.username || cfg.xiaomusic.password
      ? `Basic ${Buffer.from(`${cfg.xiaomusic.username}:${cfg.xiaomusic.password}`).toString('base64')}`
      : undefined

  /** @param {string} path @param {{method?: string, body?: unknown, timeoutMs?: number}} [opts] */
  async function request(path, opts = {}) {
    const headers = { Accept: 'application/json' }
    if (auth) headers.Authorization = auth
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json'

    try {
      const res = await fetch(base + path, {
        method: opts.method || 'GET',
        headers,
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        signal: AbortSignal.timeout(opts.timeoutMs ?? cfg.timeouts.xiaomusicMs),
      })
      const text = await res.text()
      let json
      try {
        json = JSON.parse(text)
      } catch {
        json = undefined
      }
      if (!res.ok) {
        return { ok: false, error: res.status === 401 ? 'XIAOMUSIC_UNAUTHORIZED' : 'XIAOMUSIC_HTTP_ERROR', detail: `HTTP ${res.status}`, status: res.status }
      }
      return { ok: true, status: res.status, json, text }
    } catch (err) {
      const code = err?.name === 'TimeoutError' ? 'XIAOMUSIC_TIMEOUT' : 'XIAOMUSIC_UNREACHABLE'
      return { ok: false, error: code, detail: String(err?.message ?? err).slice(0, 160) }
    }
  }

  /** @returns {Promise<{ok: boolean, items?: Array<{did: string, name: string, hardware: string, online: boolean}>, error?: string, detail?: string}>} */
  async function listSpeakers() {
    const r = await request('/device_list')
    if (!r.ok) return r
    const devices = Array.isArray(r.json?.devices) ? r.json.devices : []
    const items = devices.map((d) => ({
      did: String(d.miotDID || d.did || ''),
      name: String(d.alias || d.name || ''),
      hardware: String(d.hardware || ''),
      online: d.presence === 'online' || Boolean(d.current),
    }))
    return { ok: true, items }
  }

  /**
   * Resolve a user-facing speaker reference to one device.
   * @param {string} wanted did, alias, or device name; empty means "the only one"
   * @param {string} [fallback] configured default speaker
   */
  async function resolveSpeaker(wanted, fallback) {
    const all = await listSpeakers()
    if (!all.ok) return all
    const items = all.items || []
    if (items.length === 0) return { ok: false, error: 'SPEAKER_NONE' }

    for (const ref of [wanted, fallback].map((v) => String(v || '').trim()).filter(Boolean)) {
      const hit = items.find((d) => d.did === ref) || items.find((d) => d.name === ref)
      if (hit) return { ok: true, device: hit, all: items }
    }
    if (items.length === 1) return { ok: true, device: items[0], all: items }
    return { ok: false, error: 'SPEAKER_NOT_FOUND', detail: `candidates: ${items.map((d) => d.name).join(', ')}`, all: items }
  }

  /** @param {string} did @param {string} url */
  /**
   * Push one stream URL to the speaker.
   *
   * `durationSec` is what xiaomusic needs to schedule the following track: the
   * pushed URL is not in its own playlist, so without a length it has no idea
   * when the song ended and nothing follows it.
   * @param {string} did @param {string} url
   * @param {{durationSec?: number}} [opts]
   */
  async function playUrl(did, url, opts = {}) {
    const duration = Math.max(0, Math.round(Number(opts.durationSec) || 0))
    const extra = duration > 0 ? `&duration=${duration}` : ''
    const r = await request(`/playurl?did=${encodeURIComponent(did)}&url=${encodeURIComponent(url)}${extra}`)
    if (!r.ok) return r
    const text = String(r.text || '')
    if (/"ret"\s*:\s*"Did not exist"/.test(text)) return { ok: false, error: 'SPEAKER_NOT_FOUND', detail: text.slice(0, 120) }
    if (text.includes('"code":0') || text.includes('"ret":"OK"')) return { ok: true }
    return { ok: false, error: 'SPEAKER_PLAY_REJECTED', detail: text.slice(0, 160) }
  }

  /** @param {string} did @param {string} text */
  async function speak(did, text) {
    const r = await request(`/playtts?did=${encodeURIComponent(did)}&text=${encodeURIComponent(text)}`)
    return r.ok ? { ok: true } : r
  }

  /** @param {string} did @param {string} cmd xiaomusic voice command, e.g. 下一首 */
  async function command(did, cmd) {
    const r = await request('/cmd', { method: 'POST', body: { did, cmd } })
    if (!r.ok) return r
    return { ok: r.json?.ret === 'OK', detail: r.json?.ret }
  }

  /** @param {string} did */
  async function stop(did) {
    const r = await request('/device/stop', { method: 'POST', body: { did } })
    return r.ok ? { ok: true } : r
  }

  /** @param {string} did @param {number} volume */
  async function setVolume(did, volume) {
    const r = await request('/setvolume', { method: 'POST', body: { did, volume } })
    return r.ok ? { ok: true } : r
  }

  /** @param {string} did */
  async function nowPlaying(did) {
    const r = await request(`/playingmusic?did=${encodeURIComponent(did)}`)
    if (!r.ok) return r
    const j = r.json || {}
    return {
      ok: j.ret === 'OK',
      playing: Boolean(j.is_playing),
      music: String(j.cur_music || ''),
      playlist: String(j.cur_playlist || ''),
      offsetSec: Math.round(Number(j.offset || 0)),
      durationSec: Math.round(Number(j.duration || 0)),
    }
  }

  /** @param {string} did */
  async function playerStatus(did) {
    const r = await request(`/getplayerstatus?did=${encodeURIComponent(did)}`)
    if (!r.ok) return r
    const j = r.json || {}
    return { ok: true, status: Number(j.status ?? 0), volume: Number(j.volume ?? 0) }
  }

  return { listSpeakers, resolveSpeaker, playUrl, speak, command, stop, setVolume, nowPlaying, playerStatus }
}
