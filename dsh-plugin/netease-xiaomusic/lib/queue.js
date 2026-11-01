/**
 * Per-speaker NetEase queue.
 *
 * A pushed URL leaves xiaomusic's own playlist untouched, so its "next track"
 * would walk a stale local list. The plugin keeps the candidates it just
 * searched for each device and serves next/previous from that, which keeps
 * continuous listening on the NetEase side.
 * @module netease-xiaomusic/queue
 */

/** @param {unknown} err */
const messageOf = (err) => String(err?.message ?? err).slice(0, 200)

/**
 * @param {{xm: object, netease: object, logger?: any, cfg: object, refill?: (query: string) => Promise<object[]>}} deps
 */
export function createQueue({ xm, netease, logger, cfg, refill }) {
  /** @type {Map<string, {items: object[], index: number, keyword: string, did: string}>} */
  const queues = new Map()
  /** @type {Map<string, {timer: any, at: number, durationSec: number}>} */
  const timers = new Map()

  /** @param {string} did */
  function cancelTimer(did) {
    const t = timers.get(did)
    if (t?.timer) clearTimeout(t.timer)
    timers.delete(did)
  }

  /**
   * Title fingerprint: drop bracketed suffixes (live/翻唱/伴奏), separators, and
   * casing, so "许嵩-素颜（少爷Bootleg）" and "素颜" land on the same key.
   * @param {object} song
   */
  function titleKey(song) {
    return String(song?.name || '')
      .replace(/[（(【\[].*?[)）】\]]/g, '')
      .replace(/[^\p{L}\p{N}]+/gu, '')
      .toLowerCase()
  }

  /**
   * Two candidates are "the same song" when one title contains the other —
   * covers usually prepend the artist or add a subtitle.
   * @param {string} a @param {string} b
   */
  function sameTitle(a, b) {
    if (!a || !b) return false
    if (a === b) return true
    const shorter = a.length <= b.length ? a : b
    const longer = shorter === a ? b : a
    return shorter.length >= 2 && longer.includes(shorter)
  }

  /** @param {object[]} items @param {string[]} [taken] keys already claimed */
  function distinctTitles(items, taken = []) {
    const keys = [...taken]
    const out = []
    for (const song of items) {
      const key = titleKey(song)
      if (!key) continue
      if (keys.some((existing) => sameTitle(existing, key))) continue
      keys.push(key)
      out.push(song)
    }
    return out
  }

  /**
   * Remember the candidate list a play came from, so next/prev have somewhere to go.
   * @param {string} did
   * @param {{items?: object[], song?: object, keyword?: string, durationSec?: number}} input
   */
  function record(did, input) {
    cancelTimer(did)
    const raw = Array.isArray(input.items) && input.items.length > 0 ? input.items.slice(0, 20) : input.song ? [input.song] : []
    const items = distinctTitles(raw)
    if (items.length === 0) return

    const song = input.song || items[0]
    let index = items.findIndex((s) => s.originalId === song.originalId || sameTitle(titleKey(s), titleKey(song)))
    if (index < 0) {
      // The chosen track was a same-title variant that dedupe dropped: keep it as
      // the current entry so "next" still moves forward.
      items.unshift({ ...song })
      index = 0
    }
    queues.set(did, {
      items,
      index,
      keyword: String(input.keyword || ''),
      did,
      keys: items.map(titleKey),
      artists: song.artists || [],
      refilled: false,
    })
    logger?.debug?.(`netease-xiaomusic: queue ${did} <- ${items.length} item(s) at ${index}`)

    if (cfg.queue.autoAdvance && (input.durationSec || 0) > 0) {
      schedule(did, input.durationSec)
    }
  }

  /**
   * Ask for more candidates when the current batch is all one title — the case a
   * user hears as "下一首还是这首歌". Tries the original keyword first, then the
   * current artist.
   * @param {any} entry
   */
  async function ensureRoom(entry) {
    if (!refill || entry.items.length >= 2 || entry.refilled) return
    entry.refilled = true

    const queries = [entry.keyword, (entry.artists || []).join(' ')].filter(Boolean)
    for (const query of queries) {
      let more = []
      try {
        more = (await refill(query)) || []
      } catch (err) {
        logger?.debug?.(`netease-xiaomusic: refill failed: ${messageOf(err)}`)
        continue
      }
      const added = distinctTitles(more, entry.keys)
      if (added.length > 0) {
        entry.items.push(...added)
        entry.keys.push(...added.map(titleKey))
        logger?.info?.(`netease-xiaomusic: queue refilled with ${added.length} new title(s) via ${query}`)
      }
      if (entry.items.length >= 2) return
    }
  }

  /** @param {string} did @param {number} durationSec */
  function schedule(did, durationSec) {
    cancelTimer(did)
    const delayMs = Math.max(10_000, (durationSec + 3) * 1000)
    const startedAt = Date.now()
    const timer = setTimeout(async () => {
      timers.delete(did)
      try {
        // If the user stopped or switched early, this fires long before the track
        // would have ended — never resume over a deliberate stop.
        if (Date.now() - startedAt < (durationSec - 5) * 1000) return
        const st = await xm.playerStatus(did)
        // Still playing means our duration estimate was short (or it is looping).
        if (!st.ok || st.status === 1) return
        const result = await advance(did, 1, { random: queues.get(did)?.random === true })
        if (!result.ok) return
        await xm.playUrl(did, result.playUrl)
        logger?.info?.(`netease-xiaomusic: auto-advanced to ${result.song?.name}`)
      } catch (err) {
        logger?.warn?.(`netease-xiaomusic: auto-advance failed: ${messageOf(err)}`)
      }
    }, delayMs)
    timer.unref?.()
    timers.set(did, { timer, at: startedAt + delayMs, durationSec })
  }

  /**
   * Step through the remembered candidates, skipping ones without a stream.
   * @param {string} did
   * @param {1 | -1} step
   * @param {{random?: boolean}} [opts] `random` follows xiaomusic's 随机播放 mode
   * @returns {Promise<{ok: true, playUrl: string, song: object, index: number} | {ok: false, error: string}>}
   */
  async function advance(did, step, opts = {}) {
    const entry = queues.get(did)
    if (!entry || entry.items.length === 0) return { ok: false, error: 'QUEUE_EMPTY' }

    // Mode precedence: the plugin's own setting, then xiaomusic's play_type.
    const mode = cfg.queue.mode || 'random'
    const random = mode === 'random' ? true : mode === 'sequential' ? false : opts.random === true
    entry.random = random
    entry.history = entry.history || []

    // "Next" must leave the current title; if we only have one, go get more.
    if (step > 0) await ensureRoom(entry)

    const from = entry.index
    const len = entry.items.length
    for (let tries = 0; tries < len; tries += 1) {
      if (step < 0 && entry.history.length > 0) {
        // Walking back should retrace what was actually played, in either mode.
        entry.index = entry.history.pop()
      } else if (random && len > 1) {
        let next = entry.index
        while (next === entry.index && len > 1) next = Math.floor(Math.random() * len)
        entry.index = next
      } else {
        entry.index = (entry.index + step + len) % len
      }
      const song = entry.items[entry.index]
      const stream = await netease.resolveStream({ originalId: song.originalId })
      if (stream.ok) {
        entry.artists = song.artists || []
        if (step > 0 && entry.index !== from) entry.history.push(from)
        cancelTimer(did)
        // xiaomusic needs the length to schedule the following track; the search
        // metadata is sometimes empty, so fall back to the stream's own size.
        const durationSec =
          song.durationSec || (stream.br > 0 ? Math.round((stream.size * 8) / stream.br) : 0)
        if (cfg.queue.autoAdvance && durationSec > 0) schedule(did, durationSec)
        return { ok: true, playUrl: stream.url, song, index: entry.index, durationSec }
      }
      logger?.debug?.(`netease-xiaomusic: skip ${song.name} (${stream.error})`)
    }
    return { ok: false, error: 'QUEUE_EXHAUSTED' }
  }

  /** @param {string} did */
  function clear(did) {
    cancelTimer(did)
    queues.delete(did)
  }

  /** @param {string} did */
  const has = (did) => {
    const entry = queues.get(did)
    return Boolean(entry && entry.items.length > 1)
  }

  return {
    record,
    next: (did, opts) => advance(did, 1, opts),
    prev: (did, opts) => advance(did, -1, opts),
    clear,
    has,
    size: () => queues.size,
  }
}
