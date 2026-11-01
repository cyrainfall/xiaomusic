/**
 * Model-facing tools.
 *
 * Registered as raw JSON-Schema definitions through `ctx.tools.register` rather
 * than the host's `defineTool` helper: an out-of-tree bundle installed from a
 * local directory cannot reliably resolve that helper's package.
 * @module netease-xiaomusic/tools
 */

import { existsSync, writeFileSync } from 'node:fs'

import { pickSong } from './resolve.js'

/** @param {any} err @returns {string} */
const messageOf = (err) => String(err?.message ?? err).slice(0, 200)

/** Human-readable reasons the model can act on. */
const ERROR_TEXT = {
  NCM_CLI_NOT_FOUND: '没找到 ncm-cli：请先 `npm i -g @music163/ncm-cli`，或用 ncmCli 配置指向它。',
  NCM_NOT_LOGGED_IN: 'ncm-cli 未登录：请先执行 `ncm-cli login` 扫码登录。',
  NCM_TIMEOUT: 'ncm-cli 超时，稍后重试。',
  NCM_RATE_LIMITED: '网易云接口请求超限，请稍后再试，不要连续重试。',
  NCM_BAD_JSON: 'ncm-cli 返回了无法解析的输出。',
  NCM_API_ERROR: '网易云接口返回错误。',
  NCM_CLI_FAILED: 'ncm-cli 执行失败。',
  NCM_COOKIE_INVALID: '网易云 cookie 失效（-110）：需要更新 MUSIC_U，VIP 曲目暂时播不了。',
  NCM_COOKIE_MISSING: '没有配置网易云 MUSIC_U cookie，VIP 曲目无法解析直链。',
  NCM_NO_SOURCE: '这首歌没有可用音源（可能已下架或无版权），换一首。',
  NCM_VIP_REQUIRED: '这首歌只能试听：当前账号没有对应权益。',
  NCM_BAD_ID: '歌曲 ID 不合法。',
  NCM_UNKNOWN: '解析直链失败。',
  NCM_NETWORK_ERROR: '连不上网易云接口。',
  NCM_HTTP_ERROR: '网易云接口返回异常状态。',
  XIAOMUSIC_UNREACHABLE: '连不上 xiaomusic（默认 http://127.0.0.1:8090），确认服务在跑。',
  XIAOMUSIC_TIMEOUT: 'xiaomusic 响应超时。',
  XIAOMUSIC_UNAUTHORIZED: 'xiaomusic 需要登录：请配置用户名密码，或在其设置里关闭 HTTP 认证。',
  XIAOMUSIC_HTTP_ERROR: 'xiaomusic 返回异常状态。',
  RUNTIME_INSTALL_FAILED: 'xiaomusic 运行时装不上：请确认网络可用，或已安装 uv / Python 3.10+。',
  RUNTIME_PATCH_FAILED: 'xiaomusic 装好了但补丁没覆盖上，语音转发用不了。',
  RUNTIME_START_FAILED: 'xiaomusic 启动失败。',
  RUNTIME_START_TIMEOUT: 'xiaomusic 启动超时：首次安装 Python 依赖可能较慢，稍后再试。',
  PORT_BUSY: '端口被别的程序占用，xiaomusic 起不来：改 port 或先停掉占用者。',
  SPEAKER_NONE: 'xiaomusic 里没有任何音箱设备。',
  SPEAKER_NOT_FOUND: '没找到这台音箱，先用 speaker_list 看可用设备。',
  SPEAKER_PLAY_REJECTED: '音箱拒绝了这次推流。',
  SPEAKER_CONTROL_FAILED: '音箱没有接受这条控制指令。',
}

/** @param {string} code @param {string} [detail] @returns {string} */
function explain(code, detail) {
  const base = ERROR_TEXT[code] || `操作失败（${code}）。`
  return detail ? `${base}（${detail}）` : base
}

/** @param {string} text @param {boolean} [isError] */
const result = (text, isError = false) => (isError ? { text, isError: true } : { text })

/**
 * Songs this plugin pushed, per device.
 *
 * `playurl` hands the URL straight to the speaker, so xiaomusic's own
 * `is_playing`/`cur_music` never learn about it. Remembering the push lets
 * `ncm_status` tell the truth while the device reports `status=1`.
 * @type {Map<string, {name: string, artists: string[], album: string, originalId: string, at: number}>}
 */
const lastPushed = new Map()

/**
 * The most recent search, so a play that arrives with explicit ids can still
 * remember the list it was chosen from — otherwise "下一首" has nowhere to go and
 * wraps back to the same song.
 * @type {{items: object[], keyword: string, at: number} | null}
 */
let lastSearch = null

/** @param {object} song @returns {string} one line summary */
function songLine(song) {
  const artists = (song.artists || []).join('/') || '未知歌手'
  const mm = String(Math.floor((song.durationSec || 0) / 60)).padStart(1, '0')
  const ss = String((song.durationSec || 0) % 60).padStart(2, '0')
  const flags = [song.vip ? 'VIP' : '', song.playable ? '' : '接口标记受限'].filter(Boolean).join('/')
  return `${song.name} — ${artists}《${song.album || '未知专辑'}》 ${mm}:${ss}${flags ? ` [${flags}]` : ''} id=${song.encryptedId} num=${song.originalId}`
}

/**
 * Build every tool definition this plugin contributes.
 * @param {{cfg: object, ncm: object, netease: object, xm: object, logger?: object, voice?: object, queue?: object, resolver: object, runtime?: object}} deps
 * @returns {object[]} raw JSON-Schema tool definitions
 */
export function createTools({ cfg, ncm, netease, xm, logger, voice, queue, resolver, runtime }) {
  /**
   * Wait for the managed runtime before touching the API.
   *
   * On a fresh install the first call can arrive while `pip` is still working;
   * answering "连不上 xiaomusic" in that window would be misleading, so the call
   * waits for the runtime verdict instead of racing it.
   * @param {number} [budgetMs]
   * @returns {Promise<{ok: boolean, error?: string, detail?: string}>}
   */
  async function awaitRuntime(budgetMs = 90000) {
    if (!runtime) return { ok: true }
    const verdict = await Promise.race([
      runtime.ready,
      new Promise((done) => setTimeout(() => done({ ok: false, error: 'RUNTIME_START_TIMEOUT' }), budgetMs)),
    ])
    return verdict || { ok: true }
  }
  /**
   * The voice request this tool call belongs to, if any.
   *
   * A turn started by the speaker must not push audio itself: xiaomusic plays the
   * URL after stopping the speaker's own answer, so the tool only resolves and
   * records the result.
   * @param {any} exec
   */
  const voiceSlotFor = (exec) => voice?.pendingFor?.(exec?.agent?.session?.id)
  /**
   * Poll the device until it reports playback, so the tool can answer "did it
   * actually start" instead of "the request was accepted".
   * @param {string} did @param {number} budgetMs
   * @returns {Promise<boolean>}
   */
  async function waitForPlayback(did, budgetMs) {
    const deadline = Date.now() + budgetMs
    for (;;) {
      const st = await xm.playerStatus(did)
      if (st.ok && st.status === 1) return true
      if (Date.now() >= deadline) return false
      await new Promise((resolve) => setTimeout(resolve, 1200))
    }
  }
  const speakerParam = {
    type: 'string',
    description: '目标音箱：did、设备名或别名。省略时用配置的默认音箱；只有一个设备时自动选中。',
  }

  const outputSchema = {
    type: 'object',
    additionalProperties: false,
    properties: {
      text: { type: 'string' },
      isError: { type: 'boolean' },
    },
    required: ['text'],
  }

  const render = (_args, value) => [{ type: 'text', text: String(value?.text ?? '') }]

  return [
    {
      name: 'xm_setup',
      timeoutMs: 180000,
      description:
        '查看/配置托管 xiaomusic 的运行状态：小米账号、网易云 cookie、服务是否就绪。' +
        '首次使用必须先配小米账号（account + password），否则音箱列表是空的。' +
        '不传任何参数时只报告状态。',
      parameters: {
        type: 'object',
        properties: {
          account: { type: 'string', description: '小米账号（手机号或邮箱），只在首次配置或更换账号时传' },
          password: { type: 'string', description: '小米账号密码' },
          miDid: { type: 'string', description: '默认音箱 did，多台音箱时用来固定默认设备' },
          musicU: { type: 'string', description: '网易云 MUSIC_U cookie；也可以让它写到文件里，二选一' },
          restart: { type: 'boolean', description: '改完配置后是否重启服务让其生效，默认 true' },
        },
        additionalProperties: false,
      },
      output: { schema: outputSchema, render },
      async execute(args) {
        const lines = []
        const patch = {}
        if (args?.account) patch.account = String(args.account).trim()
        if (args?.password) patch.password = String(args.password)
        if (args?.miDid) patch.mi_did = String(args.miDid).trim()

        if (args?.musicU) {
          // The cookie belongs in the file the resolver reads, not in config: it is
          // a bearer credential and must stay replaceable without a restart.
          try {
            writeFileSync(cfg.netease.cookieFile, String(args.musicU).trim(), 'utf8')
            lines.push(`已写入网易云 cookie：${cfg.netease.cookieFile}`)
          } catch (err) {
            lines.push(`写 cookie 失败：${messageOf(err)}`)
          }
        }

        if (Object.keys(patch).length > 0) {
          const written = runtime?.writeConfig?.(patch)
          if (!written?.ok) return result(`写配置失败：${written?.detail || '未知原因'}`, true)
          lines.push(`已写入配置：${written.files.join('、')}`)
          if (args?.restart !== false) {
            lines.push('正在重启 xiaomusic…')
            const restarted = await runtime.restart()
            lines.push(
              restarted.ok
                ? 'xiaomusic 已重启'
                : `重启失败：${explain(restarted.error, restarted.detail)}`,
            )
          }
        }

        const boot = await awaitRuntime()
        const state = runtime?.status?.() || {}
        const head = [
          `托管目录：${state.home || '(未配置)'}`,
          `服务：${boot.ok ? `就绪 ${cfg.xiaomusic.baseUrl}` : `未就绪（${explain(boot.error, boot.detail)}）`}`,
          `网易云 cookie：${cfg.netease.musicU ? '来自环境变量' : `文件 ${cfg.netease.cookieFile}${existsSync(cfg.netease.cookieFile) ? '（已配置）' : '（缺失）'}`}`,
        ]

        // Only report the account as "configured", never echo the secret.
        if (boot.ok) {
          const speakers = await xm.listSpeakers()
          if (speakers.ok && speakers.items.length > 0) {
            head.push(`音箱：${speakers.items.map((d) => `${d.name}(${d.did})`).join('、')}`)
          } else if (speakers.ok) {
            head.push('音箱：一台都没登录上来 —— 检查小米账号密码，或先扫码登录 xiaomusic 的 Web 界面')
          } else {
            head.push(`音箱：读取失败（${explain(speakers.error, speakers.detail)}）`)
          }
        }
        return result([...head, ...lines].join('\n'))
      },
    },

    {
      name: 'speaker_list',
      timeoutMs: 20000,
      description:
        '列出 xiaomusic 管理的小爱音箱（did、名称、型号、是否在线）。' +
        '在不知道往哪台音箱播放、或用户提到"客厅""卧室"这类说法时先调用它。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: { schema: outputSchema, render },
      async execute() {
        const boot = await awaitRuntime()
        if (!boot.ok) return result(explain(boot.error, boot.detail), true)
        const r = await xm.listSpeakers()
        if (!r.ok) return result(explain(r.error, r.detail), true)
        if (!r.items.length) return result('xiaomusic 里没有任何音箱设备。', true)
        const lines = r.items.map((d) => `- ${d.name}（did=${d.did}，${d.hardware}，${d.online ? '在线' : '离线'}）`)
        return result(`共 ${r.items.length} 台音箱：\n${lines.join('\n')}`)
      },
    },

    {
      name: 'ncm_search',
      timeoutMs: 25000,
      description:
        '用网易云音乐（ncm-cli）搜索歌曲，返回候选及其 ID。' +
        '当用户只说歌名、或你不确定有没有该版本时先搜一次；' +
        '结果里的"接口标记受限"只表示开放平台授权窗口，不代表这个账号播不了，仍可直接尝试播放。',
      parameters: {
        type: 'object',
        properties: {
          keyword: { type: 'string', description: '搜索词，建议"歌名 歌手"' },
          limit: { type: 'integer', description: '返回条数，1-20，默认 8' },
        },
        required: ['keyword'],
        additionalProperties: false,
      },
      output: { schema: outputSchema, render },
      async execute(args) {
        const keyword = String(args?.keyword ?? '').trim()
        if (!keyword) return result('keyword 不能为空。', true)
        const r = await resolver.candidates(keyword, { limit: Number(args?.limit) || 8 })
        if (!r.ok) return result(explain(r.error, r.detail), true)
        if (!r.items.length) return result(`没搜到「${keyword}」。`, true)
        lastSearch = { items: r.items, keyword, at: Date.now() }
        const lines = r.items.map((s, i) => `${i + 1}. ${songLine(s)}`)
        const head =
          r.source === 'artist'
            ? `「${keyword}」按歌手「${r.artist}」解析到 ${r.items.length} 首（热门优先）：`
            : `「${keyword}」搜到 ${r.items.length} 条（可播优先）：`
        return result(`${head}\n${lines.join('\n')}`)
      },
    },

    {
      name: 'ncm_play',
      timeoutMs: 45000,
      description:
        '在小爱音箱上播放网易云音乐的一首歌。' +
        '优先传 encryptedId + originalId（来自 ncm_search），这样版本确定；' +
        '只给 keyword 时本工具会自己搜一次并选最可能的版本（同名歌优先可播条目）。' +
        '播放会打断音箱当前内容。返回播放失败时按错误提示换候选或换 cookie，不要用同一首歌反复重试。',
      parameters: {
        type: 'object',
        properties: {
          keyword: { type: 'string', description: '歌名或"歌名 歌手"。传 ID 时也请一并带上，用于回显歌名' },
          encryptedId: { type: 'string', description: 'ncm_search 返回的 32 位加密 ID' },
          originalId: { type: 'string', description: 'ncm_search 返回的数字原始 ID' },
          speaker: speakerParam,
          level: { type: 'string', enum: ['standard', 'higher', 'exhigh', 'lossless', 'hires'], description: '音质，默认 exhigh（320k mp3）' },
        },
        additionalProperties: false,
      },
      output: { schema: outputSchema, render },
      async execute(args, exec) {
        const boot = await awaitRuntime()
        if (!boot.ok) return result(explain(boot.error, boot.detail), true)
        const speakerRef = String(args?.speaker ?? '')
        const target = await xm.resolveSpeaker(speakerRef, cfg.defaultSpeaker)
        if (!target.ok) return result(explain(target.error, target.detail), true)
        const device = target.device

        let song
        let candidates = []
        if (args?.encryptedId && args?.originalId) {
          song = {
            name: String(args?.keyword || '所选歌曲'),
            artists: [],
            album: '',
            durationSec: 0,
            encryptedId: String(args.encryptedId),
            originalId: String(args.originalId),
            playable: true,
          }
          // Reuse the search this id came from (the agent usually searched first),
          // so the queue can move to a genuinely different track.
          if (lastSearch && Date.now() - lastSearch.at < 5 * 60_000) {
            const hit = lastSearch.items.find((s) => s.originalId === song.originalId)
            if (hit) {
              candidates = lastSearch.items
              song = { ...hit, encryptedId: song.encryptedId || hit.encryptedId }
            }
          }
        } else {
          const keyword = String(args?.keyword ?? '').trim()
          if (!keyword) return result('需要 keyword，或者 encryptedId + originalId。', true)
          const search = await resolver.candidates(keyword, { limit: 20 })
          if (!search.ok) return result(explain(search.error, search.detail), true)
          lastSearch = { items: search.items, keyword, at: Date.now() }
          // A performer request has no title to match, so walking the top of the
          // artist's hot list beats always opening the same first song.
          song =
            search.source === 'artist'
              ? search.items[Math.floor(Math.random() * Math.min(5, search.items.length))]
              : pickSong(search.items, keyword)
          candidates = search.items
          if (!song) return result(`没搜到「${keyword}」。`, true)
          // `visible`/`playFlag` describe the open platform's licensing window, not
          // what this account can play: a VIP cookie resolves songs flagged false.
          // So they only order the candidates; the stream call decides.
        }

        const stream = await netease.resolveStream({ originalId: song.originalId, level: args?.level })
        if (!stream.ok) {
          return result(`《${song.name}》直链解析失败：${explain(stream.error, stream.detail)}`, true)
        }

        // Keep the candidates around so "下一首/上一首" can walk the NetEase list
        // instead of xiaomusic's stale local playlist.
        const durationSec =
          song.durationSec || (stream.br > 0 ? Math.round((stream.size * 8) / stream.br) : 0)
        queue?.record(device.did, {
          items: candidates.length > 0 ? candidates : [song],
          song,
          keyword: String(args?.keyword || ''),
          durationSec,
        })

        // Speaker-initiated turn: resolve only. xiaomusic plays it after stopping
        // the speaker's own answer, so the plugin never pushes on this path.
        const slot = voiceSlotFor(exec)
        if (slot) {
          voice.complete(slot, {
            action: 'play',
            playUrl: stream.url,
            durationSec,
            song: {
              name: song.name,
              artists: song.artists || [],
              album: song.album || '',
              originalId: song.originalId,
            },
          })
          logger?.info?.(`netease-xiaomusic: voice turn resolved ${song.name} (${song.originalId})`)
          return result(
            `已找到《${song.name}》${(song.artists || []).length ? ' — ' + song.artists.join('/') : ''}，交给音箱播放。`,
          )
        }

        const pushed = await xm.playUrl(device.did, stream.url, { durationSec })
        if (!pushed.ok) return result(explain(pushed.error, pushed.detail), true)
        lastPushed.set(device.did, {
          name: song.name,
          artists: song.artists || [],
          album: song.album || '',
          originalId: song.originalId,
          at: Date.now(),
        })

        // A pushed URL does not update xiaomusic's own play state, so confirm with
        // the device: report what actually happened instead of "指令已下发".
        const started = await waitForPlayback(device.did, 6000)

        logger?.info?.(`netease-xiaomusic: playing ${song.name} (${song.originalId}) on ${device.name}`)
        const quality = `${Math.round(stream.br / 1000)}k ${stream.type === 'flac' ? 'FLAC' : 'MP3'}`
        const head = started
          ? `已在「${device.name}」播放：`
          : `已把「${song.name}」推给「${device.name}」，但 6 秒内没读到设备进入播放状态（可能仍在缓冲，或被别的指令抢占）。已下发内容：`
        return result(
          `${head}${song.name}${song.artists?.length ? ' — ' + song.artists.join('/') : ''}` +
            `${song.album ? `《${song.album}》` : ''}（${quality}）\n` +
            `网易云链接：https://music.163.com/#/song?id=${song.originalId}`,
        )
      },
    },

    {
      name: 'ncm_control',
      timeoutMs: 20000,
      description:
        '控制小爱音箱上正在播放的音乐：停止、下一首、上一首、调音量。' +
        '只用于"停下/下一首/大声点"这类控制意图；想换一首具体的歌用 ncm_play。',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['stop', 'next', 'prev', 'volume'], description: '控制动作' },
          value: { type: 'integer', description: 'action=volume 时必填，0-100' },
          speaker: speakerParam,
        },
        required: ['action'],
        additionalProperties: false,
      },
      output: { schema: outputSchema, render },
      async execute(args) {
        const boot = await awaitRuntime()
        if (!boot.ok) return result(explain(boot.error, boot.detail), true)
        const action = String(args?.action ?? '')
        const target = await xm.resolveSpeaker(String(args?.speaker ?? ''), cfg.defaultSpeaker)
        if (!target.ok) return result(explain(target.error, target.detail), true)
        const device = target.device

        if (action === 'stop') {
          const r = await xm.stop(device.did)
          if (r.ok) lastPushed.delete(device.did)
          return r.ok ? result(`已停止「${device.name}」的播放。`) : result(explain(r.error, r.detail), true)
        }
        if (action === 'next' || action === 'prev') {
          const r = await xm.command(device.did, action === 'next' ? '下一首' : '上一首')
          return r.ok ? result(`已${action === 'next' ? '切到下一首' : '回到上一首'}。`) : result(explain('SPEAKER_CONTROL_FAILED', r.detail), true)
        }
        if (action === 'volume') {
          const volume = Number(args?.value)
          if (!Number.isFinite(volume) || volume < 0 || volume > 100) return result('volume 需要 0-100 的整数。', true)
          const r = await xm.setVolume(device.did, Math.round(volume))
          return r.ok ? result(`「${device.name}」音量已设为 ${Math.round(volume)}。`) : result(explain(r.error, r.detail), true)
        }
        return result(`不支持的 action：${action}（可用 stop/next/prev/volume）。`, true)
      },
    },

    {
      name: 'ncm_status',
      timeoutMs: 20000,
      description: '查看小爱音箱当前在放什么（歌名、播放列表、进度、音量、是否在播）。用户问"在放什么"或你需要在控制前确认状态时用。',
      parameters: {
        type: 'object',
        properties: { speaker: speakerParam },
        additionalProperties: false,
      },
      output: { schema: outputSchema, render },
      async execute(args) {
        const boot = await awaitRuntime()
        if (!boot.ok) return result(explain(boot.error, boot.detail), true)
        const target = await xm.resolveSpeaker(String(args?.speaker ?? ''), cfg.defaultSpeaker)
        if (!target.ok) return result(explain(target.error, target.detail), true)
        const device = target.device
        const [np, st] = await Promise.all([xm.nowPlaying(device.did), xm.playerStatus(device.did)])
        if (!np.ok) return result(explain(np.error, np.detail), true)

        const fmt = (sec) => `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`
        const pushed = lastPushed.get(device.did)
        // The device is the authority on "is audio coming out"; xiaomusic only knows
        // about playback it started itself.
        const devicePlaying = st.ok && st.status === 1

        if (!np.playing && !devicePlaying) {
          return result('当前没有在播放。')
        }

        if (np.playing) {
          const detail = [
            `进度 ${fmt(np.offsetSec)} / ${fmt(np.durationSec)}`,
            np.playlist ? `播放列表：${np.playlist}` : '',
            st.ok ? `音箱音量 ${st.volume}` : '',
          ].filter(Boolean)
          return result([`正在播放：${np.music || '(未知曲目)'}`, ...detail.map((d) => `- ${d}`)].join('\n'))
        }

        const title = pushed
          ? `${pushed.name}${pushed.artists?.length ? ' — ' + pushed.artists.join('/') : ''}`
          : '(非本插件推流)'
        const detail = ['- 来源：本插件的直链推流', st.ok ? `- 音箱音量 ${st.volume}` : ''].filter(Boolean)
        return result([`正在播放：${title}`, ...detail].join('\n'))
      },
    },

    {
      name: 'speaker_say',
      timeoutMs: 20000,
      description: '让小爱音箱用语音念一句话（TTS）。用于"它不在放歌时回一句口头确认"，不要用它念长文本或 Markdown。',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: '要念的内容，尽量一句话' },
          speaker: speakerParam,
        },
        required: ['text'],
        additionalProperties: false,
      },
      output: { schema: outputSchema, render },
      async execute(args, exec) {
        const text = String(args?.text ?? '').trim()
        if (!text) return result('text 不能为空。', true)
        const boot = await awaitRuntime()
        if (!boot.ok) return result(explain(boot.error, boot.detail), true)
        const target = await xm.resolveSpeaker(String(args?.speaker ?? ''), cfg.defaultSpeaker)
        if (!target.ok) return result(explain(target.error, target.detail), true)

        const slot = voiceSlotFor(exec)
        if (slot) {
          voice.complete(slot, { action: 'chat', speak: text.slice(0, 200) })
          return result(`会向「${target.device.name}」播报：${text.slice(0, 60)}`)
        }

        const r = await xm.speak(target.device.did, text.slice(0, 200))
        return r.ok ? result(`已让「${target.device.name}」说出：${text.slice(0, 60)}`) : result(explain(r.error, r.detail), true)
      },
    },
  ]
}

export { messageOf }
