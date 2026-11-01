/**
 * Voice bridge: the listener xiaomusic calls when a speaker hears a music request.
 *
 * It reuses one DSH agent session per speaker so follow-ups ("换一个", "再来一首")
 * keep context. The agent's tool calls report back through a per-request slot
 * rather than its prose, so xiaomusic can act on facts instead of sentences: the
 * plugin never pushes audio on this path, it only resolves the URL and hands it
 * back for xiaomusic to play after stopping the speaker's own answer.
 * @module netease-xiaomusic/bridge
 */
import { randomUUID, timingSafeEqual } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Diagnostics sink for the voice path; empty disables it. */
let TRACE_FILE = join(tmpdir(), 'ncm-voice-bridge.log')

/** @param {string} line */
function trace(line) {
  if (!TRACE_FILE) return
  try {
    appendFileSync(TRACE_FILE, `${new Date().toISOString()} ${line}\n`)
  } catch {
    /* diagnostics must never break a turn */
  }
}

/** Tools a voice turn may use. Anything else is refused outright. */
export const MUSIC_TOOLS = ['speaker_list', 'ncm_search', 'ncm_play', 'ncm_control', 'ncm_status', 'speaker_say']

/** Reset a speaker's session once it has served this many turns. */
const MAX_TURNS = 50

/** @param {string} a @param {string} b */
function sameToken(a, b) {
  const x = Buffer.from(String(a ?? ''))
  const y = Buffer.from(String(b ?? ''))
  if (x.length !== y.length) return false
  return timingSafeEqual(x, y)
}

/** @param {unknown} err */
const messageOf = (err) => String(err?.message ?? err).slice(0, 300)

/**
 * Keep the voice session runnable.
 *
 * The harness refuses every step of an archived Session (`agent/pre-step` →
 * `reject`), which ends a voice turn in a few milliseconds with no tool call and
 * nothing to report. Voice sessions are infrastructure rather than conversations
 * the user opens, but they do appear in the session list, so any pass that
 * tidies up archived chats takes them too. Put ours back when that happened.
 * @param {any} ctx @param {string} sessionId
 * @returns {Promise<boolean>} whether the session had been archived and now is not
 */
async function ensureRunnable(ctx, sessionId) {
  const registry = ctx?.workspaceRegistry
  if (!registry || !sessionId) return false
  let archived = []
  try {
    archived = [...(registry.archivedSessionIds ?? [])].map(String)
  } catch {
    return false
  }
  if (!archived.includes(String(sessionId))) return false
  try {
    await registry.unarchiveSession(String(sessionId))
    trace(`unarchived session ${String(sessionId).slice(0, 8)}`)
    return true
  } catch (err) {
    trace(`unarchive failed ${messageOf(err)}`)
    return false
  }
}

/**
 * Reason kind of the newest closed turn, when the harness recorded one.
 * @param {any} handle
 * @returns {string|undefined}
 */
function lastTurnReason(handle) {
  try {
    const events = handle?.agent?.session?.snapshotEvents?.() ?? []
    for (let i = events.length - 1; i >= 0; i -= 1) {
      if (events[i]?.type === 'turn/end') return events[i]?.data?.reason?.kind
    }
  } catch {
    /* diagnostics only */
  }
  return undefined
}

/**
 * @param {{cfg: object, ctx: any, logger?: any, queue: object}} deps
 * @returns {{server?: import('node:http').Server, close: () => void, pendingFor: (id: string) => any, complete: (slot: any, value: object) => void, stats: () => object}}
 */
export function createVoiceBridge({ cfg, ctx, logger, queue }) {
  /** @type {Map<string, {sessionId: string, handle: any, turns: number, queue: Promise<any>}>} */
  const speakers = new Map()
  /** @type {Map<string, {requestId: string, did: string, box: any, done: (v: any) => void}>} */
  const pending = new Map()

  /** @param {string} sessionId */
  const pendingFor = (sessionId) => (sessionId ? pending.get(sessionId) : undefined)

  /**
   * Record what the tool actually achieved for this request.
   * @param {any} slot @param {{playUrl?: string, speak?: string, song?: object, action?: string}} value
   */
  function complete(slot, value) {
    if (!slot) return
    slot.box = { ...slot.box, ...value }
  }

  /**
   * Build the model-facing prompt for one utterance.
   * @param {{query: string, deviceName: string}} input
   */
  function promptFor({ query, deviceName }) {
    return [
      `[来自小爱音箱的语音] 设备：${deviceName || '小爱音箱'}。`,
      `用户说：「${query}」`,
      '这句话是语音识别结果，可能有错别字或语气词。',
      '判断顺序：',
      '1. 想听歌（说了歌名、歌手、或"来点/放点/听点+某样东西"）→ 立刻调用一次 ncm_play，keyword 原样传用户说的内容。',
      '   例：「播放许嵩的歌」→ ncm_play(keyword="许嵩的歌")；「来点周杰伦」→ ncm_play(keyword="周杰伦")；',
      '   「放首素颜」→ ncm_play(keyword="素颜")。工具自己会搜索、会按歌手取歌、会选版本，不需要你先搜索。',
      '2. 停 / 下一首 / 上一首 / 音量 → ncm_control。',
      '3. 只有在问"在放什么"时才用 ncm_status。',
      '4. 只有整句话里完全听不出任何歌名或歌手时，才用 speaker_say 请用户再说一遍。',
      '说了歌手就算说清楚了：**不要反问"想听哪一首"，不要说"没听清"**。',
      '最多两次工具调用；不要输出 Markdown，不要解释工具。',
    ].join('\n')
  }

  /**
   * Get (or create) the session bound to one speaker.
   * @param {string} did
   */
  async function sessionFor(did) {
    const existing = speakers.get(did)
    if (existing && existing.turns < MAX_TURNS) return existing

    if (existing) {
      try {
        await existing.handle.dispose()
      } catch {
        /* disposed or never published */
      }
      speakers.delete(did)
    }

    const sessionId = randomUUID()
    const selection = ctx.agentDefaultModel?.currentSelection?.()
    trace(`create session sel=${JSON.stringify(selection)}`)
    const handle = await ctx.agents.create({
      sessionId,
      meta: { cwd: process.cwd() },
      agentOptions: selection
        ? { provider: selection.provider, model: selection.model, ...(selection.reasoningEffort ? { reasoningEffort: selection.reasoningEffort } : {}) }
        : {},
      // Scope the voice agent's world before it is published: music tools only,
      // plus the speaking persona.
      setup: (agentCtx) => {
        try {
          agentCtx.tools.guard((exec) => {
            const allowed = MUSIC_TOOLS.includes(exec.name)
            trace(`tool ${allowed ? 'allow' : 'deny'} ${exec.name}`)
            return allowed ? undefined : `语音链路只允许音乐工具（拒绝 ${exec.name}）`
          })
        } catch (err) {
          logger?.warn?.(`netease-xiaomusic: could not scope voice tools: ${messageOf(err)}`)
        }
        try {
          agentCtx.systemPrompt.section({
            name: 'netease-xiaomusic:voice-persona',
            order: agentCtx.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX'),
            text:
              '你是小爱音箱的音乐助手。用户的话来自音箱语音识别，可能有错别字或语气词。' +
              '只在音乐范围内行动：播放用 ncm_play（它自己会搜索、按歌手取歌、选版本），' +
              '搜歌用 ncm_search，控制用 ncm_control，查询用 ncm_status，需要说话用 speaker_say。' +
              '用户说「播放某歌手的歌」时直接调用 ncm_play，不要说没听清、不要反问想听哪一首。' +
              '回复简短、口语化，不要输出 Markdown。',
          })
        } catch (err) {
          logger?.warn?.(`netease-xiaomusic: could not add voice persona: ${messageOf(err)}`)
        }
      },
    })
    trace(`created status=${handle.agent.status} model=${handle.agent.options?.model}`)
    await ensureRunnable(ctx, sessionId)

    const entry = { sessionId, handle, turns: 0, queue: Promise.resolve() }
    speakers.set(did, entry)
    logger?.info?.(`netease-xiaomusic: opened voice session ${sessionId.slice(0, 8)} for ${did}`)
    return entry
  }

  /**
   * Run one utterance to completion and return what to do about it.
   * @param {{requestId: string, did: string, deviceName: string, query: string}} req
   */
  async function runTurn(req) {
    const started = Date.now()
    const entry = await sessionFor(req.did)
    await ensureRunnable(ctx, entry.sessionId)

    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const sessionId = entry.sessionId
      const box = { action: 'chat', playUrl: '', speak: '', song: null }
      const slot = { requestId: req.requestId, did: req.did, box, done: () => {} }
      pending.set(sessionId, slot)
      let blocked = false

      try {
        entry.turns += 1
        entry.handle.agent.followup({
          id: randomUUID(),
          role: 'user',
          content: [{ type: 'text', text: promptFor(req) }],
          source: { kind: 'user' },
        })
        trace(`followup sid=${sessionId.slice(0, 8)} status=${entry.handle.agent.status}`)

        // followup wakes the driver asynchronously; give it a moment to leave idle so
        // whenIdle() does not resolve against the pre-turn state.
        const spinUntil = Date.now() + 2000
        while (entry.handle.agent.status === 'idle' && Date.now() < spinUntil) {
          await new Promise((resolve) => setTimeout(resolve, 50))
        }
        trace(`after wake status=${entry.handle.agent.status}`)

        const budget = Math.max(1000, Number(cfg.voiceBridge.agentTimeoutMs) || 15000)
        await Promise.race([
          entry.handle.agent.whenIdle(),
          new Promise((_resolve, reject) => setTimeout(() => reject(new Error('agent timeout')), budget)),
        ])
        blocked = lastTurnReason(entry.handle) === 'blocked'
        trace(`idle status=${entry.handle.agent.status} blocked=${blocked} box=${JSON.stringify(slot.box)}`)
      } catch (err) {
        trace(`turn error ${messageOf(err)}`)
        logger?.warn?.(`netease-xiaomusic: voice turn failed: ${messageOf(err)}`)
        return { handled: false, reason: messageOf(err), elapsedMs: Date.now() - started }
      } finally {
        pending.delete(sessionId)
      }

      // A blocked turn means the harness refused the step outright, so nothing ran
      // and the utterance is still unanswered: restore the session and try once more.
      if (blocked && attempt === 1 && (await ensureRunnable(ctx, sessionId))) {
        trace('blocked turn; session restored, retrying once')
        logger?.info?.('netease-xiaomusic: voice session was archived; restored and retried')
        continue
      }

      const elapsedMs = Date.now() - started
      if (slot.box.playUrl) {
        return {
          handled: true,
          action: 'play',
          playUrl: slot.box.playUrl,
          song: slot.box.song,
          durationSec: slot.box.durationSec || 0,
          speak: '',
          elapsedMs,
        }
      }
      if (slot.box.speak) {
        return { handled: true, action: 'chat', speak: slot.box.speak, elapsedMs }
      }
      return {
        handled: false,
        reason: blocked ? 'session blocked' : 'no tool decided',
        elapsedMs,
      }
    }
    return { handled: false, reason: 'no tool decided', elapsedMs: Date.now() - started }
  }

  const stats = () => ({ sessions: speakers.size, inflight: pending.size })

  if (!cfg.voiceBridge.enabled) return { close() {}, pendingFor, complete, stats }

  const server = createServer((req, res) => {
    void (async () => {
      const send = (status, body) => {
        const text = JSON.stringify(body)
        res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
        res.end(text)
      }

      if (req.method !== 'POST' || !req.url) {
        send(404, { error: 'not found' })
        return
      }
      const route = req.url.split('?')[0]
      if (!['/ask', '/next', '/prev', '/forget'].includes(route)) {
        send(404, { error: 'not found' })
        return
      }
      if (cfg.voiceBridge.token && !sameToken(`Bearer ${cfg.voiceBridge.token}`, req.headers.authorization)) {
        send(401, { error: 'unauthorized' })
        return
      }

      let raw = ''
      try {
        for await (const chunk of req) {
          raw += chunk
          if (raw.length > 32 * 1024) throw new Error('body too large')
        }
      } catch (err) {
        send(413, { error: messageOf(err) })
        return
      }

      let body
      try {
        body = JSON.parse(raw)
      } catch {
        send(400, { error: 'invalid json' })
        return
      }
      const query = String(body?.query ?? '').trim()
      const did = String(body?.did ?? '').trim()
      if (!did || (route === '/ask' && !query)) {
        send(400, { error: route === '/ask' ? 'query and did are required' : 'did is required' })
        return
      }

      const requestId = String(body?.requestId || randomUUID())

      // Queue stepping stays out of the model: xiaomusic forwards "下一首" here when
      // the last thing it played came from this plugin.
      if (route === '/next' || route === '/prev') {
        const random = body?.random === true
        const result = route === '/next' ? await queue.next(did, { random }) : await queue.prev(did, { random })
        logger?.info?.(
          `netease-xiaomusic: ${route} ${did}${random ? ' (random)' : ''} -> ` +
            (result.ok
              ? `${result.song?.name}${result.song?.artists?.length ? ' / ' + result.song.artists.join('/') : ''} (#${result.index})`
              : result.error),
        )
        send(200, result.ok
          ? {
              requestId,
              handled: true,
              action: 'play',
              playUrl: result.playUrl,
              song: result.song,
              durationSec: result.durationSec || 0,
            }
          : { requestId, handled: false, reason: result.error })
        return
      }
      if (route === '/forget') {
        queue.clear(did)
        send(200, { requestId, handled: true, action: 'cleared' })
        return
      }

      try {
        const result = await runTurn({ requestId, did, deviceName: String(body?.deviceName ?? ''), query })
        logger?.info?.(
          `netease-xiaomusic: voice ${requestId.slice(0, 8)} "${query}" -> ` +
            `${result.handled ? result.action : 'unhandled'} (${result.elapsedMs}ms)`,
        )
        send(200, { requestId, ...result })
      } catch (err) {
        logger?.warn?.(`netease-xiaomusic: voice request failed: ${messageOf(err)}`)
        send(500, { requestId, handled: false, reason: messageOf(err) })
      }
    })()
  })

  server.listen(cfg.voiceBridge.port, cfg.voiceBridge.host, () => {
    logger?.info?.(
      `netease-xiaomusic: voice bridge listening on http://${cfg.voiceBridge.host}:${cfg.voiceBridge.port}/ask` +
        `${cfg.voiceBridge.token ? '' : ' (no token configured)'}`,
    )
  })
  server.on('error', (err) => logger?.warn?.(`netease-xiaomusic: voice bridge error: ${messageOf(err)}`))

  return {
    server,
    close() {
      for (const entry of speakers.values()) entry.handle.dispose?.().catch?.(() => {})
      speakers.clear()
      server.close()
    },
    pendingFor,
    complete,
    stats,
  }
}
