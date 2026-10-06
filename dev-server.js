// 本地预览/联调服务器：用 Node http 直接跑 Vercel 的入口，浏览器里能完整试用
// （内存存储，数据不持久，重启即清空）。
// 用法：node dev-server.js  然后浏览器打开 http://localhost:8790
//
// 本地没有 DeepSeek 的 key，所以这里把对 api.deepseek.com 的请求整个截下来，
// 回一段逐字吐的假 SSE —— 打字机效果、用量记账、令牌校验都是真的，
// 只有模型的那几个字是假的。真模型请部署后在线上试。

process.env.TEST_MEMORY = '1'          // 用内存 store，不碰真实 Blob
process.env.DEEPSEEK_API_KEY = 'local-fake-key'
process.env.DEEPSEEK_BASE_URL = 'https://api.deepseek.com'
process.env.DEEPSEEK_MODEL = 'deepseek-flash（本地模拟）'

const http = require('http')
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

// ---------- 假的 DeepSeek：逐字吐，制造打字机效果 ----------
const realFetch = global.fetch
global.fetch = async (url, opts = {}) => {
  if (!String(url).includes('api.deepseek.com')) return realFetch(url, opts)
  let ask = ''
  try { ask = JSON.parse(opts.body).messages.slice(-1)[0].content } catch { /* 拿不到就空着 */ }
  const text = `（这是本地模拟的回复，线上会换成真的 DeepSeek）\n\n你刚才说：「${ask}」\n\n`
    + `我现在还在本地跑，所有逻辑都是真的：令牌校验、用量记账、逐字流式输出。\n`
    + `部署到 Vercel 并配好 DEEPSEEK_API_KEY 之后，这里就会是真正的 ${process.env.DEEPSEEK_MODEL} 了。`
  const enc = new TextEncoder()
  return new Response(new ReadableStream({
    async start(c) {
      for (const ch of text) {
        c.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: ch } }] })}\n\n`))
        await new Promise(r => setTimeout(r, 18))
      }
      c.enqueue(enc.encode('data: [DONE]\n\n'))
      c.close()
    },
  }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
}

const handler = require('./api/index.js')
const store = require('./api/store.js')

// 模拟 vercel.json 的 rewrites：/api/xxx → /api/index?path=xxx
function applyRewrites(req) {
  const u = new URL(req.url, 'http://localhost')
  if (u.pathname.startsWith('/api/')) {
    const orig = u.pathname.slice('/api/'.length)
    u.pathname = '/api/index'
    u.searchParams.set('path', orig)
  }
  return u.pathname + u.search
}

// 造测试账号，密码哈希算法与图床一致（scrypt），所以本地测的就是线上那套
async function seedUsers() {
  const seeds = [
    { username: 'zfbai', password: 'siBAIsiBAI', role: 'su' },   // 管理员
    { username: 'mltd', password: '123456', role: 'h' },         // 普通用户（进不去管理页）
  ]
  for (const s of seeds) {
    const salt = crypto.randomBytes(16).toString('hex')
    await store._writeUser({
      username: s.username, salt,
      passHash: crypto.scryptSync(s.password, salt, 32).toString('hex'),
      role: s.role, banned: false, createdAt: new Date().toISOString(),
    })
  }
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
    res.statusCode = 200
    res.setHeader('Content-Type', 'text/html; charset=utf-8')
    res.end(fs.readFileSync(path.join(__dirname, 'public', 'index.html')))
    return
  }
  req.url = applyRewrites(req)
  await handler(req, res)
})

server.listen(8790, async () => {
  await seedUsers()
  console.log('本地预览：http://localhost:8790  （Ctrl+C 退出）')
  console.log('管理员：zfbai / siBAIsiBAI   （登录后能创建令牌）')
  console.log('普通用户：mltd / 123456       （用来验证非管理员进不去）')
  console.log('提示：模型回复是本地假的（逐字吐），其余逻辑全是真的')
})
