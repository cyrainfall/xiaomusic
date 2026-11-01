/**
 * NetEase Cloud Music → xiaomusic → Xiaomi speaker.
 *
 * Search and version picking are delegated to `ncm-cli`; the playable URL comes
 * from NetEase's own player endpoint with the account cookie; playback is pushed
 * through xiaomusic, which owns the speaker.
 * @module @local/netease-xiaomusic
 */
import { normalizeConfig } from './lib/config.js'
import { createNcm } from './lib/ncm.js'
import { createNetease } from './lib/netease.js'
import { createXiaomusic } from './lib/xiaomusic.js'
import { createTools } from './lib/tools.js'
import { createVoiceBridge } from './lib/bridge.js'
import { createQueue } from './lib/queue.js'
import { createResolver } from './lib/resolve.js'

export const name = 'netease-xiaomusic'

/**
 * The tool registry, the agent service, the model route, and the workspace
 * registry the voice bridge needs to keep its own sessions runnable.
 */
export const inject = ['tools', 'agents', 'agentDefaultModel', 'workspaceRegistry']

/**
 * @param {any} ctx Cordis context provided by the Loader
 * @param {unknown} config row config from `cordis.patch.yml`
 */
export function apply(ctx, config) {
  const cfg = normalizeConfig(config)
  if (!cfg.enabled) {
    ctx.logger?.info?.('netease-xiaomusic: disabled by config')
    return
  }

  const logger = ctx.logger
  const ncm = createNcm(cfg, logger)
  const netease = createNetease(cfg, logger)
  const xm = createXiaomusic(cfg, logger)
  const resolver = createResolver({ ncm, netease, logger })
  const queue = createQueue({
    xm,
    netease,
    logger,
    cfg,
    // Refill a queue whose candidates are all one title, using the web search
    // (the CLI's top-N is what created the problem). Performer requests refill
    // from the artist catalog, so 「许嵩的歌」 keeps queueing 许嵩.
    refill: async (query) => {
      const result = await resolver.candidates(query, { limit: 40 })
      return result.ok ? result.items : []
    },
  })
  const voice = createVoiceBridge({ cfg, ctx, logger, queue })
  const tools = createTools({ cfg, ncm, netease, xm, logger, voice, queue, resolver })

  for (const definition of tools) {
    ctx.effect(() => ctx.tools.register(definition))
  }
  ctx.effect(() => () => voice.close())

  logger?.info?.(
    `netease-xiaomusic: registered ${tools.length} tools ` +
      `(ncm-cli ${ncm.entry ? 'resolved' : 'MISSING'}, xiaomusic ${cfg.xiaomusic.baseUrl}, ` +
      `cookie ${cfg.netease.musicU ? 'from env/config' : `file ${cfg.netease.cookieFile}`})`,
  )
}
