/**
 * Turn a spoken music request into NetEase candidates.
 *
 * The distinction that matters is "a song" versus "a performer". Asking the song
 * search for 「许嵩的歌」 returns tracks literally titled 许嵩的歌 by other people
 * — the performer never enters the ranking — so a performer request is resolved
 * through the artist catalog instead. Everything else stays a title search.
 * @module netease-xiaomusic/resolve
 */

/** Verb openers a spoken request may carry in front of the real subject, longest first. */
const REQUEST_PREFIXES = [
  '帮我播放一下', '帮我播放', '帮我放一下', '帮我放', '帮我找一下', '帮我找',
  '麻烦播放', '麻烦放', '请播放', '请放', '给我播放', '给我放一下', '给我放', '给我来一首', '给我来',
  '我想听一下', '我想听听', '我想听', '想听一下', '想听听', '想听',
  '播放一下', '播放', '放一下', '放一首', '放首', '放点', '放', '听一下', '听一听', '听听', '听',
  '换一首', '换个', '来一首', '来一首歌', '来点', '来首', '来一个', '来', '整一首', '整点', '整首',
].sort((a, b) => b.length - a.length)

/** Endings that mark a performer request, longest first. */
const ARTIST_SUFFIXES = [
  '的全部歌曲', '全部歌曲', '的所有歌曲', '所有歌曲', '的全部的歌', '全部的歌', '所有的歌',
  '的热门歌曲', '热门歌曲', '的热门歌', '热门歌', '的热门单曲', '热门单曲', '的热门',
  '的歌曲', '的歌儿', '的歌', '唱的歌', '的作品',
].sort((a, b) => b.length - a.length)

/** Trailing particles and punctuation that carry no meaning for the lookup. */
const FILLER = /[吧啊呀呗呢哦嘛了吧的\s，,。.、!！?？~～]+$/u

/**
 * Split a request into the subject and whether it names a performer.
 * Only ``core`` is used for an artist lookup; the original sentence is what the
 * song search sees, so a mis-stripped verb can never corrupt a title.
 * @param {string} query
 * @returns {{core: string, marker: boolean}}
 */
export function parseArtistRequest(query) {
  let text = String(query ?? '')
    .replace(/^[\s，,。.、!！?？]+/u, '')
    .replace(FILLER, '')
    .trim()

  let marker = false
  for (let guard = 0; guard < 3; guard += 1) {
    const hit = ARTIST_SUFFIXES.find((suffix) => text.length > suffix.length && text.endsWith(suffix))
    if (!hit) break
    text = text.slice(0, -hit.length).trim()
    marker = true
  }
  for (let guard = 0; guard < 3; guard += 1) {
    const hit = REQUEST_PREFIXES.find((prefix) => text.length > prefix.length + 1 && text.startsWith(prefix))
    if (!hit) break
    text = text.slice(hit.length).trim()
  }
  return { core: text.replace(FILLER, '').trim(), marker }
}

/**
 * Best candidate for a keyword: an exact title wins, then a title that contains
 * or is contained by the keyword, then a matching performer; playability only
 * breaks ties, because the stream call is the real authority on that.
 * @param {object[]} items
 * @param {string} keyword
 * @returns {object|undefined}
 */
export function pickSong(items, keyword) {
  if (!items || items.length === 0) return undefined
  const q = String(keyword || '').trim()
  if (!q) return items[0]

  let best = items[0]
  let bestScore = -1
  for (const song of items) {
    const score = scoreSong(song, q)
    if (score > bestScore) {
      best = song
      bestScore = score
    }
  }
  return best
}

/**
 * Rank one candidate against what the user said.
 *
 * Relevance only: an exact title beats a partial one, a mentioned performer
 * outranks a cover. The platform's playability flag is deliberately absent — it
 * describes the open platform's licensing window, not what this account can
 * play, and letting it break ties promoted other artists' covers over originals.
 * Equal scores keep the search's own order, which is the popularity order.
 * @param {any} song @param {string} q
 * @returns {number}
 */
export function scoreSong(song, q) {
  const name = String(song?.name || '')
  if (!name) return 0
  let score = 0
  if (name === q) score += 4
  else if (q.includes(name) || name.includes(q)) score += 2
  if ((song?.artists || []).some((artist) => artist && q.includes(artist))) score += 3
  return score
}

/**
 * @param {{ncm: any, netease: any, logger?: any}} deps
 */
export function createResolver({ ncm, netease, logger }) {
  /**
   * @param {string} name
   * @returns {Promise<{id: string, name: string}|undefined>}
   */
  async function findArtist(name) {
    const found = await netease.searchArtist(name, { limit: 6 })
    if (!found.ok) return undefined
    // Exact performer name only: 「许嵩的歌」 must not fall back to 不许嵩手.
    return found.items.find((artist) => artist.name === name || artist.alias.includes(name))
  }

  /**
   * Candidates for one spoken request.
   * @param {string} keyword
   * @param {{limit?: number}} [opts]
   * @returns {Promise<{ok: true, items: object[], source: 'artist'|'song', artist?: string} | {ok: false, error: string, detail?: string}>}
   */
  async function candidates(keyword, opts = {}) {
    const limit = Math.max(1, Math.min(50, opts.limit || 20))
    const parsed = parseArtistRequest(keyword)

    /**
     * Resolve a performer name to their hot songs.
     * @param {string} name
     */
    async function byArtist(name) {
      if (!name) return undefined
      const artist = await findArtist(name)
      if (!artist) return undefined
      const hot = await netease.artistTopSongs(artist.id, { limit })
      if (!hot.ok || hot.items.length === 0) {
        logger?.debug?.(`netease-xiaomusic: artist ${artist.name} has no readable songs: ${hot.error}`)
        return undefined
      }
      logger?.debug?.(`netease-xiaomusic: 「${keyword}」→ artist ${artist.name} (${hot.items.length} songs)`)
      return { ok: true, items: hot.items, source: 'artist', artist: artist.name }
    }

    if (parsed.marker) {
      const hit = await byArtist(parsed.core)
      if (hit) return hit
    }

    const search = await ncm.searchSongs(keyword, Math.min(20, limit))
    if (!search.ok) return { ok: false, error: search.error, detail: search.detail }

    // No performer marker, but the title search found nothing that actually
    // carries the words either: the sentence was probably a performer after all
    // (「来点周杰伦」 ranks cover tracks that merely mention the name).
    if (search.items.length > 0) {
      const best = pickSong(search.items, keyword)
      if (scoreSong(best, keyword) <= 1) {
        const hit = await byArtist(parsed.core || keyword)
        if (hit) return hit
      }
    }
    return { ok: true, items: search.items, source: 'song' }
  }

  return { candidates, pickSong }
}
