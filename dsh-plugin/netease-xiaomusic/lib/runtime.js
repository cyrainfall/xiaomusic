/**
 * Managed xiaomusic runtime.
 *
 * The plugin owns the whole stack the user used to install by hand: a Python
 * environment, the `xiaomusic` package from PyPI, the local patches that make
 * voice routing and pushed-stream continuation work, a generated `config.json`,
 * and the server process itself. Installing the DSH bundle is therefore the only
 * install step; nothing else has to be started by hand.
 *
 * Two modes are supported by the same code path:
 * - **fresh**: `home` is empty, so an environment is created, the package is
 *   installed from the configured mirror, and a default `config.json` is written;
 * - **adopted**: `home` already holds a xiaomusic install (its own `config.json`
 *   or `.venv`), which is reused as-is — the overlay and the process still come
 *   from here, but the user's music library and credentials are untouched.
 *
 * Anything the runtime cannot provide is reported as a structured error instead
 * of throwing, because a plugin load must never take the Host down.
 * @module netease-xiaomusic/runtime
 */

import { spawn, spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { createConnection } from 'node:net'
import { homedir, networkInterfaces, platform } from 'node:os'
import { dirname, join, resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'

/** PyPI mirror tried first; the official index is the fallback. */
const MIRRORS = ['https://pypi.tuna.tsinghua.edu.cn/simple', 'https://pypi.org/simple']

/** Where the vendored overlay (patched xiaomusic sources) lives. */
const VENDOR_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'vendor', 'xiaomusic')

const IS_WINDOWS = platform() === 'win32'

/** @param {unknown} err */
const messageOf = (err) => String(err?.message ?? err).slice(0, 300)

/** @param {string} text */
const hashText = (text) => createHash('sha1').update(text).digest('hex').slice(0, 16)

/** @param {string} file */
function hashFile(file) {
  try {
    return hashText(readFileSync(file))
  } catch {
    return ''
  }
}

/**
 * Walk a directory tree and collect every regular file, relative to `root`.
 * @param {string} root @param {string} [prefix]
 * @returns {string[]}
 */
function walk(root, prefix = '') {
  const out = []
  let entries
  try {
    entries = readdirSync(join(root, prefix), { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) out.push(...walk(root, rel))
    else if (entry.isFile()) out.push(rel)
  }
  return out.sort()
}

/**
 * Run one command to completion.
 * @param {string} command @param {string[]} args
 * @param {{cwd?: string, timeoutMs?: number}} [opts]
 * @returns {{ok: boolean, stdout: string, stderr: string, code?: any}}
 */
function run(command, args, opts = {}) {
  const r = spawnSync(command, args, {
    cwd: opts.cwd,
    timeout: opts.timeoutMs ?? 600000,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  })
  return {
    ok: !r.error && r.status === 0,
    stdout: String(r.stdout || ''),
    stderr: String(r.stderr || r.error?.message || ''),
    code: r.status ?? r.error?.code,
  }
}

/** @param {string} path */
function isFile(path) {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/**
 * First non-loopback IPv4 address: the speaker fetches TTS audio from this host,
 * so `127.0.0.1` would be unreachable from the device.
 * @returns {string}
 */
export function lanAddress() {
  const nets = networkInterfaces()
  for (const list of Object.values(nets)) {
    for (const net of list || []) {
      if (net.family === 'IPv4' && !net.internal) return net.address
    }
  }
  return '127.0.0.1'
}

/**
 * Find an executable on PATH (plus the uv user-local bin directory).
 * @param {string} name @returns {string|undefined}
 */
function which(name) {
  const exts = IS_WINDOWS ? ['.exe', '.cmd', '.bat', ''] : ['']
  const dirs = String(process.env.PATH || '').split(IS_WINDOWS ? ';' : ':').filter(Boolean)
  if (process.env.LOCALAPPDATA) dirs.push(join(process.env.LOCALAPPDATA, 'Programs', 'uv'))
  dirs.push(join(homedir(), '.local', 'bin'), join(homedir(), '.cargo', 'bin'))
  for (const dir of dirs) {
    for (const ext of exts) {
      const full = join(dir, name + ext)
      if (isFile(full)) return full
    }
  }
  return undefined
}

/**
 * The `python` inside a virtual environment.
 * @param {string} venv @returns {string}
 */
function venvPython(venv) {
  return IS_WINDOWS ? join(venv, 'Scripts', 'python.exe') : join(venv, 'bin', 'python')
}

/** @param {string} venv @returns {string} the site-packages directory that holds xiaomusic */
function sitePackages(venv) {
  if (IS_WINDOWS) return join(venv, 'Lib', 'site-packages')
  const lib = join(venv, 'lib')
  let versions = []
  try {
    versions = readdirSync(lib).filter((n) => n.startsWith('python'))
  } catch {
    /* not created yet */
  }
  return join(lib, versions[0] || 'python3', 'site-packages')
}

/**
 * Ask an interpreter where its packages live.
 *
 * An operator may point `python` at an environment outside `home` (an existing
 * install, or conda); the directory layout alone cannot answer that, so the
 * interpreter is the authority. Falls back to the venv convention.
 * @param {string} python @param {string} home
 * @returns {string}
 */
function resolveSitePackages(python, home) {
  const r = run(python, ['-c', 'import sysconfig;print(sysconfig.get_paths()["purelib"])'], {
    cwd: home,
    timeoutMs: 60000,
  })
  const path = r.ok ? r.stdout.trim().split(/\r?\n/).pop() : ''
  return path && existsSync(path) ? path : sitePackages(join(home, '.venv'))
}

/** @param {string} port @returns {Promise<boolean>} whether something already listens there */
function portOpen(port) {
  return new Promise((done) => {
    const socket = createConnection({ host: '127.0.0.1', port: Number(port) })
    const finish = (value) => {
      socket.destroy()
      done(value)
    }
    socket.setTimeout(1200)
    socket.once('connect', () => finish(true))
    socket.once('timeout', () => finish(false))
    socket.once('error', () => finish(false))
  })
}

/**
 * Generate the `config.json` a fresh install needs.
 *
 * Every path is absolute: xiaomusic resolves relative paths against its working
 * directory, and the managed process is started from the plugin, not a shell.
 * @param {object} cfg @param {string} home
 */
export function defaultConfig(cfg, home) {
  const lan = cfg.xiaomusic.hostname || lanAddress()
  const port = cfg.xiaomusic.port
  const active = [
    'play', 'set_play_type_rnd', 'playlocal', 'play_music_list', 'play_music_list_index',
    'stop_after_minute', 'stop', 'play_next', 'play_prev', 'set_play_type_one',
    'set_play_type_all', 'set_play_type_sin', 'set_play_type_seq', 'gen_music_list',
    'add_to_favorites', 'del_from_favorites', 'cmd_del_music', 'online_play', 'singer_play',
  ].join(',')
  return {
    account: cfg.xiaomusic.account,
    password: cfg.xiaomusic.password,
    mi_did: cfg.xiaomusic.miDid,
    music_path: join(home, 'music'),
    temp_path: join(home, 'music', 'tmp'),
    download_path: join(home, 'music', 'download'),
    conf_path: join(home, 'conf'),
    cache_dir: join(home, 'music', 'cache'),
    hostname: `http://${lan}`,
    port,
    public_port: port,
    ffmpeg_location: join(home, 'ffmpeg', 'bin'),
    // mutagen reads mp3 headers without an external ffprobe binary, which a
    // managed install has no way to bundle.
    get_duration_type: 'mutagen',
    active_cmd: active,
    log_file: join(home, 'xiaomusic.log.txt'),
    disable_httpauth: true,
    enable_analytics: false,
    edge_tts_voice: 'zh-CN-XiaoyiNeural',
    enable_agent_bridge: true,
    agent_bridge_url: `http://127.0.0.1:${cfg.voiceBridge.port}/ask`,
    agent_bridge_when: 'play_intent',
    agent_bridge_tts: '好的，正在找歌',
    agent_bridge_timeout: 35,
  }
}

/**
 * Create the supervisor: environment preparation plus the server process.
 * @param {{cfg: any, logger?: any, xm?: any}} deps
 */
export function createRuntime({ cfg, logger, xm }) {
  const home = cfg.xiaomusic.home
  const venv = join(home, '.venv')
  const python = cfg.xiaomusic.python || venvPython(venv)
  const stampFile = join(home, '.dsh-overlay.json')
  const serverLog = join(home, 'dsh-xiaomusic-server.log')

  /** @type {{child?: any, stopped: boolean, restarts: number, lastExit?: {code: any, at: number}, adopted: boolean}|null} */
  let state = null
  let readyResolve
  /** Resolves once xiaomusic answers; never rejects. */
  const ready = new Promise((done) => {
    readyResolve = done
  })
  let disposed = false

  /**
   * Install the vendored overlay over the installed package.
   *
   * The patches are the whole point of this plugin — without them xiaomusic
   * cannot route a voice request to the model or continue a pushed stream — so
   * the copy is re-applied whenever the recorded package version or any file hash
   * differs. `pip install -U` therefore cannot silently undo them.
   * @returns {{ok: boolean, applied: boolean, detail?: string}}
   */
  function applyOverlay() {
    const site = resolveSitePackages(python, home)
    const target = join(site, 'xiaomusic')
    if (!existsSync(target)) return { ok: false, applied: false, detail: `xiaomusic 未安装到 ${site}` }

    const files = walk(VENDOR_DIR)
    const wanted = {}
    for (const rel of files) wanted[rel] = hashFile(join(VENDOR_DIR, rel))

    let previous = {}
    try {
      previous = JSON.parse(readFileSync(stampFile, 'utf8'))
    } catch {
      /* first run */
    }
    const same =
      previous &&
      previous.version === cfg.xiaomusic.version &&
      JSON.stringify(previous.files) === JSON.stringify(wanted) &&
      files.every((rel) => hashFile(join(target, rel)) === wanted[rel])
    if (same) return { ok: true, applied: false }

    let copied = 0
    for (const rel of files) {
      const dest = join(target, rel)
      mkdirSync(dirname(dest), { recursive: true })
      writeFileSync(dest, readFileSync(join(VENDOR_DIR, rel)))
      copied += 1
    }
    writeFileSync(
      stampFile,
      JSON.stringify({ version: cfg.xiaomusic.version, files: wanted, at: new Date().toISOString() }, null, 2),
    )
    logger?.info?.(`netease-xiaomusic: 已覆盖 ${copied} 个补丁文件到 ${target}`)
    return { ok: true, applied: true }
  }

  /**
   * Create the virtual environment and install the pinned package.
   * @returns {{ok: boolean, detail?: string}}
   */
  function ensureEnvironment() {
    mkdirSync(home, { recursive: true })
    const hasVenv = isFile(python)

    if (!hasVenv) {
      const uv = which('uv')
      if (uv) {
        logger?.info?.(`netease-xiaomusic: 用 uv 创建 Python 环境（${venv}）`)
        const r = run(uv, ['venv', '--python', cfg.xiaomusic.pythonVersion, venv], { timeoutMs: 300000 })
        if (!r.ok) return { ok: false, detail: `uv venv 失败：${(r.stderr || r.stdout).slice(0, 300)}` }
      } else {
        const base = which(IS_WINDOWS ? 'python' : 'python3') || which('python')
        if (!base) return { ok: false, detail: '没有找到 Python，也没有找到 uv：请先安装 https://docs.astral.sh/uv/' }
        logger?.info?.(`netease-xiaomusic: 用 ${base} 创建 Python 环境（${venv}）`)
        const r = run(base, ['-m', 'venv', venv], { timeoutMs: 300000 })
        if (!r.ok) return { ok: false, detail: `python -m venv 失败：${(r.stderr || r.stdout).slice(0, 300)}` }
      }
    }

    if (!isFile(python)) return { ok: false, detail: `环境里没有 python 可执行文件：${python}` }

    // Run from `home`: a probe started inside a xiaomusic source checkout would
    // import that copy from the working directory and look installed.
    const probe = run(python, ['-c', 'import xiaomusic;print(xiaomusic.__version__)'], {
      cwd: home,
      timeoutMs: 60000,
    })
    const installed = probe.ok ? probe.stdout.trim().split(/\r?\n/).pop() : ''
    if (installed === cfg.xiaomusic.version) return { ok: true }

    const uv = which('uv')
    logger?.info?.(
      `netease-xiaomusic: 安装 xiaomusic==${cfg.xiaomusic.version}（当前 ${installed || '无'}），首次安装约需 10-60 秒`,
    )
    let lastDetail = ''
    for (const index of MIRRORS) {
      const spec = `xiaomusic==${cfg.xiaomusic.version}`
      const r = uv
        ? run(uv, ['pip', 'install', '--python', python, '--index-url', index, spec], { timeoutMs: 900000 })
        : run(python, ['-m', 'pip', 'install', '--index-url', index, spec], { timeoutMs: 900000 })
      if (r.ok) return { ok: true }
      lastDetail = (r.stderr || r.stdout).slice(-400)
      logger?.warn?.(`netease-xiaomusic: 从 ${index} 安装失败，换下一个源`)
    }
    return { ok: false, detail: `pip 安装失败：${lastDetail}` }
  }

  /** Write the generated config when the target directory has none yet. */
  function ensureConfigFile() {
    const file = join(home, 'config.json')
    if (existsSync(file)) return { ok: true, created: false, file }
    const data = defaultConfig(cfg, home)
    writeFileSync(file, JSON.stringify(data, null, 2), 'utf8')
    logger?.info?.(`netease-xiaomusic: 已生成默认配置 ${file}（音箱需要小米账号，请在 DSH 里配置 xiaomusic.account/password）`)
    return { ok: true, created: true, file }
  }

  /**
   * Patch an existing `conf/setting.json` so the voice bridge is on.
   *
   * xiaomusic re-applies that file after the CLI config, so a user who already
   * ran it by hand keeps their settings — only the bridge keys are forced.
   * @returns {boolean} whether the file changed
   */
  function patchExistingSetting() {
    const file = join(home, 'conf', 'setting.json')
    if (!existsSync(file)) return false
    let data
    try {
      data = JSON.parse(readFileSync(file, 'utf8'))
    } catch {
      return false
    }
    const wanted = {
      enable_agent_bridge: true,
      agent_bridge_url: `http://127.0.0.1:${cfg.voiceBridge.port}/ask`,
      agent_bridge_when: data.agent_bridge_when || 'play_intent',
      agent_bridge_timeout: data.agent_bridge_timeout || 35,
    }
    let changed = false
    for (const [key, value] of Object.entries(wanted)) {
      if (data[key] !== value) {
        data[key] = value
        changed = true
      }
    }
    if (!changed) return false
    try {
      renameSync(file, `${file}.dsh-bak`)
    } catch {
      /* the backup is best effort */
    }
    writeFileSync(file, JSON.stringify(data, null, 2), 'utf8')
    logger?.info?.('netease-xiaomusic: 已在 conf/setting.json 打开语音桥接')
    return true
  }

  /** @param {number} ms @param {number} max */
  const backoff = (ms, max) => Math.min(max, Math.max(1000, ms))

  /** @returns {Promise<boolean>} */
  async function healthy() {
    try {
      const res = await fetch(`http://127.0.0.1:${cfg.xiaomusic.port}/getsetting`, {
        signal: AbortSignal.timeout(2500),
      })
      return res.ok
    } catch {
      return false
    }
  }

  /** Poll until xiaomusic answers or the budget runs out. @param {number} budgetMs */
  async function waitHealthy(budgetMs) {
    const deadline = Date.now() + budgetMs
    for (;;) {
      if (await healthy()) return true
      if (Date.now() >= deadline) return false
      await new Promise((done) => setTimeout(done, 700))
    }
  }

  /** @param {string} args @param {string} cwd */
  function launch(args, cwd) {
    const child = spawn(python, args, {
      cwd,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8' },
    })
    const sink = []
    const append = (chunk) => {
      const text = String(chunk)
      sink.push(text)
      if (sink.length > 200) sink.splice(0, sink.length - 200)
    }
    child.stdout?.on('data', append)
    child.stderr?.on('data', append)
    child.on('error', (err) => logger?.error?.(`netease-xiaomusic: xiaomusic 进程错误 ${messageOf(err)}`))
    return { child, sink }
  }

  /**
   * Start the server and keep it alive.
   * @param {{configFile: string}} opts
   */
  function supervise({ configFile }) {
    if (disposed) return
    const cwd = home
    const { child, sink } = launch(['-m', 'xiaomusic.cli', '--config', configFile], cwd)
    const startedAt = Date.now()
    state = { child, stopped: false, restarts: state?.restarts ?? 0, adopted: false }

    child.on('exit', (code, signal) => {
      const last = state
      state = { ...(last || {}), child: undefined, stopped: true, lastExit: { code: code ?? signal, at: Date.now() } }
      if (disposed || last?.stopped) return
      const uptime = Date.now() - startedAt
      try {
        writeFileSync(serverLog, `${new Date().toISOString()} exit code=${code ?? signal} uptime=${uptime}ms\n${sink.slice(-60).join('')}`)
      } catch {
        /* diagnostics only */
      }
      // A crash loop (immediate exits) backs off instead of spinning.
      const delay = uptime < 5000 ? backoff(2000 * Math.pow(2, last?.restarts ?? 0), 60000) : 2000
      logger?.warn?.(`netease-xiaomusic: xiaomusic 退出（code=${code ?? signal}），${Math.round(delay / 1000)} 秒后重启`)
      setTimeout(() => {
        if (disposed) return
        supervise({ configFile })
      }, delay)
    })

    return child
  }

  /** @param {string} name */
  function kill(child) {
    if (!child || child.killed) return
    if (IS_WINDOWS) {
      run('taskkill', ['/pid', String(child.pid), '/T', '/F'], { timeoutMs: 15000 })
      return
    }
    try {
      child.kill('SIGTERM')
    } catch {
      /* already gone */
    }
  }

  /**
   * Bring the stack up. Safe to call once per plugin load.
   * @returns {Promise<{ok: boolean, adopted?: boolean, started?: boolean, error?: string, detail?: string}>}
   */
  async function start() {
    if (!cfg.xiaomusic.managed) {
      logger?.info?.('netease-xiaomusic: 托管关闭，使用外部 xiaomusic')
      state = { stopped: true, restarts: 0, adopted: true }
      readyResolve({ ok: true, adopted: true })
      return { ok: true, adopted: true }
    }

    // Something already answers on the port: it is either a previous run of ours
    // or the user's own service. Never fight it.
    if (await healthy()) {
      logger?.info?.(`netease-xiaomusic: 复用已在运行的 xiaomusic（:${cfg.xiaomusic.port}）`)
      state = { stopped: true, restarts: 0, adopted: true }
      readyResolve({ ok: true, adopted: true })
      return { ok: true, adopted: true }
    }
    // A restart just killed our own process; give the socket a moment to close
    // before concluding that a stranger owns the port.
    for (let i = 0; i < 20 && (await portOpen(cfg.xiaomusic.port)); i += 1) {
      await new Promise((done) => setTimeout(done, 500))
    }
    if (await portOpen(cfg.xiaomusic.port)) {
      const detail = `端口 ${cfg.xiaomusic.port} 已被占用，但没有响应 /getsetting`
      logger?.warn?.(`netease-xiaomusic: ${detail}`)
      readyResolve({ ok: false, error: 'PORT_BUSY', detail })
      return { ok: false, error: 'PORT_BUSY', detail }
    }

    logger?.info?.('netease-xiaomusic: 准备 xiaomusic 运行时…')
    try {
      const env = ensureEnvironment()
      if (!env.ok) {
        readyResolve({ ok: false, error: 'RUNTIME_INSTALL_FAILED', detail: env.detail })
        return { ok: false, error: 'RUNTIME_INSTALL_FAILED', detail: env.detail }
      }
      const overlay = applyOverlay()
      if (!overlay.ok) {
        readyResolve({ ok: false, error: 'RUNTIME_PATCH_FAILED', detail: overlay.detail })
        return { ok: false, error: 'RUNTIME_PATCH_FAILED', detail: overlay.detail }
      }
      const conf = ensureConfigFile()
      patchExistingSetting()

      logger?.info?.(`netease-xiaomusic: 启动 xiaomusic（${python} --config ${conf.file}）`)
      supervise({ configFile: conf.file })
      const up = await waitHealthy(cfg.xiaomusic.startTimeoutMs)
      if (!up) {
        const detail = `xiaomusic 在 ${Math.round(cfg.xiaomusic.startTimeoutMs / 1000)} 秒内没有就绪`
        logger?.error?.(`netease-xiaomusic: ${detail}`)
        readyResolve({ ok: false, error: 'RUNTIME_START_TIMEOUT', detail })
        return { ok: false, error: 'RUNTIME_START_TIMEOUT', detail }
      }
      logger?.info?.(`netease-xiaomusic: xiaomusic 已就绪 http://127.0.0.1:${cfg.xiaomusic.port}`)
      readyResolve({ ok: true, started: true })
      return { ok: true, started: true }
    } catch (err) {
      const detail = messageOf(err)
      logger?.error?.(`netease-xiaomusic: 运行时启动失败 ${detail}`)
      readyResolve({ ok: false, error: 'RUNTIME_START_FAILED', detail })
      return { ok: false, error: 'RUNTIME_START_FAILED', detail }
    }
  }

  /** Stop the managed process (no-op when adopting an external service). */
  function close() {
    disposed = true
    const child = state?.child
    if (state) state.stopped = true
    if (child) {
      logger?.info?.('netease-xiaomusic: 停止托管的 xiaomusic')
      kill(child)
    }
  }

  /** @returns {string} the config file the managed runtime reads */
  function configPath() {
    return join(home, 'config.json')
  }

  /**
   * Write keys into the managed `config.json` (and the live `conf/setting.json`
   * when xiaomusic already created one, since that file wins on startup).
   * @param {Record<string, unknown>} patch
   * @returns {{ok: boolean, files: string[], detail?: string}}
   */
  function writeConfig(patch) {
    const files = []
    try {
      const main = configPath()
      const current = existsSync(main) ? JSON.parse(readFileSync(main, 'utf8')) : defaultConfig(cfg, home)
      writeFileSync(main, JSON.stringify({ ...current, ...patch }, null, 2), 'utf8')
      files.push(main)

      const setting = join(home, 'conf', 'setting.json')
      if (existsSync(setting)) {
        const data = JSON.parse(readFileSync(setting, 'utf8'))
        writeFileSync(setting, JSON.stringify({ ...data, ...patch }, null, 2), 'utf8')
        files.push(setting)
      }
      return { ok: true, files }
    } catch (err) {
      return { ok: false, files, detail: messageOf(err) }
    }
  }

  /**
   * Restart the managed server so new credentials take effect.
   * @returns {Promise<{ok: boolean, error?: string, detail?: string}>}
   */
  async function restart() {
    if (!cfg.xiaomusic.managed) return { ok: true, adopted: true }
    const child = state?.child
    if (child) {
      if (state) state.stopped = true
      kill(child)
      const deadline = Date.now() + 15000
      while (Date.now() < deadline && (await healthy())) {
        await new Promise((done) => setTimeout(done, 500))
      }
    }
    const result = await start()
    return result
  }

  return {
    ready,
    start,
    close,
    restart,
    configPath,
    writeConfig,
    /** Compact snapshot for tools and diagnostics — never the child handle. */
    status: () => ({
      managed: cfg.xiaomusic.managed,
      home,
      python,
      running: Boolean(state?.child),
      pid: state?.child?.pid,
      lastExit: state?.lastExit,
      baseUrl: cfg.xiaomusic.baseUrl,
    }),
  }
}

export { randomUUID, resolvePath }
