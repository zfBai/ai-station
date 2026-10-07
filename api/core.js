// ============================================================================
// ai-station 核心逻辑
//
// 一句话：管理员（图床的 SU 账号）签发 24 小时令牌，访客凭令牌与 DeepSeek 聊天。
//        DeepSeek 的 API key 只存在于服务端环境变量里，前端从头到尾拿不到。
//
// 数据布局（Vercel Blob，与图床/文件站共用同一个 store）：
//   _tokens/{过期毫秒}-{令牌}.json   令牌档案（标签、创建时间、用量）
//   _users/{用户名}.json             图床写入的用户档案，本站只读
//
// 令牌的键名自带过期时间，所以「列出令牌 + 顺手清理过期的」只看键名就够，
// 不必逐个读内容。撤销 = 直接删对象，下一毫秒就失效。
// ============================================================================
const crypto = require('crypto')
const store = require('./store.js')

// ---------- 可调参数（都可用环境变量覆盖） ----------
const TOKEN_PREFIX = '_tokens/'
const ADMIN_ROLE = 'su'                                     // 只有图床的 SU 能进管理页
const TTL_MS = Number(process.env.TOKEN_TTL_HOURS || 24) * 3600 * 1000
const TOKEN_LEN = 16                                        // 16 位 base32 ≈ 80 bit，暴力猜不可能
// 去掉了容易看错的 I O 0 1 —— 令牌要念给朋友或手打，认错一个字符就白折腾
const TOKEN_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'   // 恰好 32 个，整除 256，取样无偏
const MAX_CALLS = Number(process.env.MAX_CALLS || 300)      // 单个令牌最多聊多少次（防令牌外泄被刷）
const MAX_MESSAGES = Number(process.env.MAX_MESSAGES || 40) // 最多带多少条上下文
const MAX_CHARS = Number(process.env.MAX_CHARS || 8000)     // 单条消息字符上限
const MAX_TOKENS = Number(process.env.MAX_TOKENS || 4096)   // 单次回复上限

const DEEPSEEK_KEY = process.env.DEEPSEEK_API_KEY || ''
const DEEPSEEK_BASE = (process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com').replace(/\/+$/, '')
// 注意：官方模型名是 deepseek-flash（即 DeepSeek-V4.1-Flash）。
// “deepseek-v4.1-flash” 那个写法是第三方网关自己的编号，填到官方接口会报 model not found。
const MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-flash'
// 默认提示词：让回答自带 Markdown 结构与 LaTeX 公式，聊天页会渲染成排版好的富文本
// （想换人设或风格，在 Vercel 配 SYSTEM_PROMPT 环境变量覆盖即可，改完记得 Redeploy）
const DEFAULT_SYSTEM_PROMPT = [
  '你是一个乐于助人的中文助手，回答简洁、准确、有条理。',
  '',
  '请用 Markdown 组织回答，让重点一眼可见：',
  '- 关键结论、术语、警告用 **加粗** 标出，但不要整段加粗；',
  '- 内容较多时用 ## 小标题、有序或无序列表分点展开；',
  '- 对比或多字段信息用表格呈现；',
  '- 代码、命令、文件名写成行内 `代码`，多行代码用带语言名的围栏代码块。',
  '',
  '数学、公式一律用 LaTeX 书写：',
  '- 行内公式用 $...$，例如 $E = mc^2$（$ 与公式之间不留空格，也不要跨行）；',
  '- 独立成段的公式用 $$...$$，例如：',
  '',
  '$$\\frac{a}{b} = c^2$$',
  '',
  '回答长度随问题而定：简单问题两三句说清，不必为排版硬凑结构。',
].join('\n')
const SYSTEM_PROMPT = process.env.SYSTEM_PROMPT || DEFAULT_SYSTEM_PROMPT

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status }
}

function json(statusCode, data, extraHeaders) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...(extraHeaders || {}) },
    body: JSON.stringify(data),
  }
}

function readJson(event) {
  try { return JSON.parse(event.body ? event.body.toString('utf8') : '{}') } catch { return {} }
}

// ---------- 令牌编解码 ----------
function newToken() {
  const bytes = crypto.randomBytes(TOKEN_LEN)
  let out = ''
  for (let i = 0; i < TOKEN_LEN; i++) out += TOKEN_ALPHABET[bytes[i] % TOKEN_ALPHABET.length]
  return out
}
// 用户可能连字符、空格、小写混着输，统一归一化后再比对
function normalizeToken(raw) {
  return String(raw || '').toUpperCase().replace(/[^A-Z2-9]/g, '')
}
function formatToken(t) {
  return (t.match(/.{1,4}/g) || []).join('-')   // XXXX-XXXX-XXXX-XXXX
}
function tokenKey(expiresAt, token) {
  return `${TOKEN_PREFIX}${expiresAt}-${token}.json`
}
// 键名 → { expiresAt, token }，不合规的键返回 null（当场跳过）
function parseTokenKey(key) {
  const m = /^_tokens\/(\d+)-([A-Z2-9]{16})\.json$/.exec(key)
  return m ? { expiresAt: Number(m[1]), token: m[2] } : null
}

// ---------- 密码校验（与图床完全一致的 scrypt 方案） ----------
function verifyPassword(password, salt, expected) {
  const actual = crypto.scryptSync(password, salt, 32).toString('hex')
  const a = Buffer.from(actual, 'hex')
  const b = Buffer.from(String(expected || ''), 'hex')
  if (a.length !== b.length || a.length === 0) return false
  return crypto.timingSafeEqual(a, b)
}

// ============ 管理员鉴权（读图床的用户档案） ============
async function authAdmin(event) {
  const headers = event.headers || {}
  const username = String(headers['x-user'] || '').toLowerCase()
  const password = String(headers['x-password'] || '')
  if (!username || !password) throw new HttpError(401, '请先登录')

  const user = await store.readUser(username)
  if (!user) throw new HttpError(401, '用户不存在，请确认用的是图片保存站的账号')
  if (user.banned) throw new HttpError(403, '账号已被封禁，请联系管理员')
  if (!verifyPassword(password, user.salt, user.passHash)) throw new HttpError(401, '密码错误')
  if (user.role !== ADMIN_ROLE) throw new HttpError(403, '这个站只有管理员能用，请联系站点主人')
  return user
}

// ============ 路由 ============
async function route(event) {
  const p = event.path
  const m = event.httpMethod

  // ---- 访客接口（凭令牌，无需登录） ----
  if (p === '/api/session' && m === 'POST') return await session(event)
  if (p === '/api/chat' && m === 'POST') return await chat(event)

  // ---- 管理员接口 ----
  if (p === '/api/login' && m === 'POST') return await login(event)
  if (p === '/api/tokens' && m === 'GET') return await listTokens(event)
  if (p === '/api/tokens' && m === 'POST') return await createToken(event)
  if (p === '/api/tokens/revoke' && m === 'POST') return await revokeToken(event)

  return json(404, { error: 'Not Found' })
}

// ============ 登录（只放行 SU） ============
async function login(event) {
  const user = await authAdmin(event)
  return json(200, { ok: true, username: user.username, role: user.role })
}

// ============ 令牌管理 ============
async function listTokens(event) {
  await authAdmin(event)
  const now = Date.now()
  const out = []

  for (const f of await store.listFiles(TOKEN_PREFIX)) {
    const meta = parseTokenKey(f.Key)
    if (!meta) continue
    if (meta.expiresAt <= now) {
      await store.deleteFile(f.Key).catch(() => {})   // 顺手清掉过期的
      continue
    }
    const buf = await store.readFile(f.Key)
    if (!buf) continue
    let info = {}
    try { info = JSON.parse(buf.toString('utf8')) } catch { /* 内容坏了就只显示键名里的信息 */ }
    out.push({
      token: meta.token,
      display: formatToken(meta.token),
      label: info.label || '',
      createdAt: info.createdAt || null,
      expiresAt: meta.expiresAt,
      calls: info.calls || 0,
      lastUsedAt: info.lastUsedAt || null,
    })
  }
  out.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
  return json(200, { tokens: out, ttlHours: TTL_MS / 3600000, maxCalls: MAX_CALLS })
}

async function createToken(event) {
  await authAdmin(event)
  const body = readJson(event)
  const label = String(body.label || '').slice(0, 40).trim()
  const hours = Math.min(Math.max(Number(body.hours) || TTL_MS / 3600000, 0.1), 24 * 30) // 10 分钟 ~ 30 天
  const now = Date.now()
  const expiresAt = now + Math.round(hours * 3600 * 1000)

  const token = newToken()
  const record = { label, createdAt: now, calls: 0, lastUsedAt: null }
  await store.putFile(tokenKey(expiresAt, token), Buffer.from(JSON.stringify(record)), 'application/json')

  return json(201, { token, display: formatToken(token), label, expiresAt })
}

async function revokeToken(event) {
  await authAdmin(event)
  const token = normalizeToken(readJson(event).token)
  if (token.length !== TOKEN_LEN) throw new HttpError(400, '令牌格式不对')

  // 键名里带过期时间，所以得先列出来找，不能直接算键名
  const hit = (await store.listFiles(TOKEN_PREFIX)).find(f => parseTokenKey(f.Key)?.token === token)
  if (!hit) throw new HttpError(404, '这个令牌已经不存在了（可能已过期或已关闭）')

  await store.deleteFile(hit.Key)                     // 删掉即失效，下一毫秒就进不来
  return json(200, { ok: true })
}

// ============ 访客：查令牌状态（进聊天页前先校验一次） ============
async function resolveToken(event) {
  const raw = (event.headers || {})['x-ai-token']
  const token = normalizeToken(raw)
  if (token.length !== TOKEN_LEN) throw new HttpError(401, '令牌格式不对，请检查是否输漏了字符')

  const hit = (await store.listFiles(TOKEN_PREFIX)).find(f => parseTokenKey(f.Key)?.token === token)
  if (!hit) throw new HttpError(401, '令牌无效、已过期或已被关闭')

  const meta = parseTokenKey(hit.Key)
  if (meta.expiresAt <= Date.now()) {
    await store.deleteFile(hit.Key).catch(() => {})
    throw new HttpError(401, '令牌已过期')
  }

  const buf = await store.readFile(hit.Key)
  if (!buf) throw new HttpError(401, '令牌无效、已过期或已被关闭')
  let info = {}
  try { info = JSON.parse(buf.toString('utf8')) } catch { /* 内容坏了按空档案处理 */ }
  return { token, key: hit.Key, expiresAt: meta.expiresAt, info }
}

async function session(event) {
  const { token, expiresAt, info } = await resolveToken(event)
  return json(200, {
    ok: true,
    label: info.label || '',
    expiresAt,
    calls: info.calls || 0,
    maxCalls: MAX_CALLS,
    model: MODEL,
  })
}

// ============ 访客：聊天（流式转发 DeepSeek） ============
async function chat(event) {
  if (!DEEPSEEK_KEY) throw new HttpError(500, '站点还没配置 DEEPSEEK_API_KEY，请联系站点主人')

  const { key, info } = await resolveToken(event)

  // 先把消息校验干净。顺序很重要：参数不对的请求不该消耗额度，
  // 否则对方随便发个空消息就能把一个令牌的额度耗光。
  const messages = sanitizeMessages(readJson(event).messages)

  // 记账要赶在转发之前：流式响应结束后函数已经交还控制权，那时再写就来不及了。
  // 并发时可能互相覆盖，但计数差一两次无所谓，这里不追求精确。
  const used = (info.calls || 0) + 1
  if (used > MAX_CALLS) throw new HttpError(429, `这个令牌的额度用完了（上限 ${MAX_CALLS} 次）`)
  await store.putFile(
    key,
    Buffer.from(JSON.stringify({ ...info, calls: used, lastUsedAt: Date.now() })),
    'application/json',
  ).catch(() => {})

  let upstream
  try {
    upstream = await fetch(`${DEEPSEEK_BASE}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${DEEPSEEK_KEY}` },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...messages],
        stream: true,
        max_tokens: MAX_TOKENS,
      }),
    })
  } catch (e) {
    throw new HttpError(502, '连不上 DeepSeek 服务，请稍后再试')
  }

  if (!upstream.ok) {
    // 上游的错误是 JSON，读出来翻译成人话（key 无效 / 余额不足 / 限流…）
    const text = await upstream.text().catch(() => '')
    throw new HttpError(upstream.status === 401 ? 500 : 502, describeUpstream(upstream.status, text))
  }

  // 原样转发 SSE 流：前端解析成逐字效果，中间不做任何加工
  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
    stream: upstream.body,
  }
}

function describeUpstream(status, text) {
  let msg = ''
  try { msg = JSON.parse(text)?.error?.message || '' } catch { /* 不是 JSON 就用原文 */ }
  if (!msg) msg = String(text).slice(0, 200)
  if (status === 401 || /invalid.*api.*key|authentication/i.test(msg)) return 'DeepSeek 的 API key 无效，请站点主人检查环境变量'
  if (status === 402 || /insufficient|balance/i.test(msg)) return 'DeepSeek 账户余额不足，请联系站点主人充值'
  if (status === 429) return '上游限流了，等几秒再试'
  if (status === 400 && /model/i.test(msg)) return `模型名「${MODEL}」不被接受：${msg}`
  return `DeepSeek 返回错误（${status}）：${msg}`
}

// 只放行 user / assistant 两种角色：访客不能自己塞 system 提示词改写人设
function sanitizeMessages(raw) {
  if (!Array.isArray(raw)) throw new HttpError(400, '消息格式不对')
  const out = []
  for (const m of raw.slice(-MAX_MESSAGES)) {
    const role = m && m.role === 'assistant' ? 'assistant' : 'user'
    const content = String((m && m.content) ?? '').slice(0, MAX_CHARS).trim()
    if (content) out.push({ role, content })
  }
  if (!out.length) throw new HttpError(400, '没有要发送的内容')
  if (out[out.length - 1].role !== 'user') throw new HttpError(400, '最后一条必须是你的提问')
  return out
}

// ============ 总入口 ============
async function main(event) {
  try {
    return await route(event)
  } catch (e) {
    if (e instanceof HttpError) return json(e.status, { error: e.message })
    console.error('[ai-station] 未捕获异常:', e)
    return json(500, { error: '服务器出错了，稍后再试' })
  }
}

module.exports = { main, _internal: { newToken, formatToken, normalizeToken, tokenKey, parseTokenKey, sanitizeMessages } }
