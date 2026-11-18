/**
 * Search fallback: web API first, ncm-cli second.
 *
 * ncm-cli 0.1.7 has no `search` subcommand, so every title request
 * («放首素颜») used to die with 搜歌服务出了点问题 while the performer path
 * (「许嵩的歌」) kept working. These cases pin the new order down, plus one
 * live check that the web endpoint really answers for this account.
 *
 * Run: node dsh-plugin/netease-xiaomusic/test/search-fallback.mjs
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { createNetease } from '../lib/netease.js'
import { createResolver } from '../lib/resolve.js'

const COOKIE_FILE = join(homedir(), '.dsh', 'netease-music-u.txt')

const quiet = { info() {}, debug() {}, warn() {}, error() {} }

let failures = 0
function check(name, ok, detail = '') {
  if (!ok) failures += 1
  console.log(`${ok ? 'OK ' : 'BAD'} ${name}${detail ? `  <- ${detail}` : ''}`)
}

const song = (name, id, artists = []) => ({
  name,
  artists,
  album: '',
  durationSec: 240,
  encryptedId: '',
  originalId: String(id),
  visible: true,
  playable: true,
  vip: false,
  fee: 0,
  coverUrl: '',
})

/** @param {{web?: any, cli?: any}} stub */
function stubDeps(stub) {
  const calls = { web: 0, cli: 0 }
  return {
    calls,
    ncm: {
      async searchSongs() {
        calls.cli += 1
        return stub.cli
      },
    },
    netease: {
      async searchWeb() {
        calls.web += 1
        return stub.web
      },
      async searchArtist() {
        return { ok: false, error: 'stub' }
      },
      async artistTopSongs() {
        return { ok: false, error: 'stub' }
      },
    },
  }
}

async function caseWebWins() {
  const deps = stubDeps({
    web: { ok: true, items: [song('素颜', 16949, ['许嵩'])] },
    cli: { ok: false, error: 'NCM_CLI_FAILED', detail: "unknown command 'search'" },
  })
  const r = await createResolver({ ...deps, logger: quiet }).candidates('素颜', { limit: 5 })
  check(
    'web_wins       网页搜到就不再碰 ncm-cli',
    r.ok && r.items[0].name === '素颜' && deps.calls.cli === 0,
    `cli 调用 ${deps.calls.cli} 次`,
  )
}

async function caseCliFallback() {
  const deps = stubDeps({
    web: { ok: false, error: 'NCM_NETWORK_ERROR', detail: 'timeout' },
    cli: { ok: true, items: [song('稻香', 185809, ['周杰伦'])] },
  })
  const r = await createResolver({ ...deps, logger: quiet }).candidates('稻香', { limit: 5 })
  check(
    'cli_fallback   网页挂了还能退回 ncm-cli',
    r.ok && r.items[0].name === '稻香' && deps.calls.cli === 1,
    `cli 调用 ${deps.calls.cli} 次`,
  )
}

async function caseEmptyIsEmpty() {
  const deps = stubDeps({
    web: { ok: true, items: [] },
    cli: { ok: false, error: 'NCM_CLI_FAILED', detail: "unknown command 'search'" },
  })
  const r = await createResolver({ ...deps, logger: quiet }).candidates('没有这首歌', { limit: 5 })
  check(
    'empty_is_empty  网页搜过没结果时不说「ncm-cli 失败」',
    r.ok && r.items.length === 0,
    JSON.stringify(r).slice(0, 120),
  )
}

async function caseBothFail() {
  const deps = stubDeps({
    web: { ok: false, error: 'NCM_NETWORK_ERROR', detail: 'timeout' },
    cli: { ok: false, error: 'NCM_CLI_FAILED', detail: "unknown command 'search'" },
  })
  const r = await createResolver({ ...deps, logger: quiet }).candidates('素颜', { limit: 5 })
  check(
    'both_fail      两边都挂时把两条原因都留下',
    r.ok === false && /timeout/.test(r.detail) && /unknown command/.test(r.detail),
    String(r.detail).slice(0, 120),
  )
}

async function caseLive() {
  let cookie = ''
  try {
    cookie = readFileSync(COOKIE_FILE, 'utf8').trim()
  } catch {
    console.log('SKIP live         没有 MUSIC_U cookie 文件，跳过联网检查')
    return
  }
  if (!cookie) {
    console.log('SKIP live         cookie 文件是空的，跳过联网检查')
    return
  }

  const netease = createNetease({ netease: { musicU: cookie, cookieFile: COOKIE_FILE, level: 'exhigh' } }, quiet)
  const ncm = {
    async searchSongs() {
      return { ok: false, error: 'NCM_CLI_FAILED', detail: "unknown command 'search'" }
    },
  }
  const resolver = createResolver({ ncm, netease, logger: quiet })

  const title = await resolver.candidates('素颜', { limit: 8 })
  check(
    'live_title     网页接口能点歌（素颜）',
    title.ok && title.items.length > 0 && title.items.some((s) => s.name === '素颜'),
    title.ok ? title.items.slice(0, 3).map((s) => `${s.name}/${s.artists.join('/')}`).join(' | ') : title.error,
  )
  const top = title.ok ? title.items[0] : undefined
  if (top) {
    const stream = await netease.resolveStream({ originalId: top.originalId })
    check(
      'live_stream    搜出来的 id 能换成直链',
      stream.ok && /^https?:/.test(stream.url || ''),
      stream.ok ? String(stream.url).slice(0, 60) : `${stream.error} ${stream.detail || ''}`,
    )
  }

  const artist = await resolver.candidates('播放许嵩的歌', { limit: 12 })
  check(
    'live_artist    歌手路径没被这次改动影响',
    artist.ok && artist.source === 'artist' && artist.items.length > 0,
    artist.ok ? `${artist.source}/${artist.artist}/${artist.items.length} 首` : artist.error,
  )
}

await caseWebWins()
await caseCliFallback()
await caseEmptyIsEmpty()
await caseBothFail()
await caseLive()

console.log(`\nFAILURES: ${failures}`)
process.exit(failures ? 1 : 0)
