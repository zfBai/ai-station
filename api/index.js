// 单段 API 入口：vercel.json 的 rewrites 把任意段数的请求都转到这里，原始路径放在 query 里
//
// 为什么要这样：非 Next.js 项目的 api/ 函数 catch-all 只匹配单段路径，
// 多段路径（如 /api/tokens/revoke）会直接 404 不进函数。
// 所以用平台级 rewrites（与框架无关，支持任意段数）统一收口到这一个单段文件：
//   ?path=xxx  → 原始路径为 /api/xxx
// 恢复后的 path 交给 core.js，路由逻辑只认还原后的完整路径。
//
// 与图床/文件站不同的地方：这里的 /api/chat 是流式响应，
// 所以 main() 除了返回完整 body，还可能返回一个 stream（见 core.js 的 chat）。
const { main } = require('./core')

// 从 query 恢复原始请求路径（rewrites 捕获的段数不限，含斜杠；值可能带 URL 编码）
function restorePath(url) {
  const qs = Object.fromEntries(url.searchParams)
  const raw = qs.path
  if (raw == null) return url.pathname // 兜底：直接访问 /api/index
  let decoded
  try {
    decoded = decodeURIComponent(raw) // 非 ASCII 字符在这里还原
  } catch {
    decoded = raw // 个别非法 % 序列时原样使用，避免 500
  }
  return `/api/${decoded}`
}

module.exports = async function handler(req, res) {
  // 只读请求体：本站的请求体都是小 JSON（聊天内容是纯文本），不存在传文件的情况
  const chunks = []
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  const buf = Buffer.concat(chunks)

  const url = new URL(req.url, 'http://localhost')
  const event = {
    path: restorePath(url),
    httpMethod: req.method,
    headers: req.headers,          // Node 的 headers 是小写 key，core 里按小写读取，正好兼容
    queryString: Object.fromEntries(url.searchParams),
    body: buf,
  }

  const result = await main(event)
  res.statusCode = result.statusCode
  for (const [k, v] of Object.entries(result.headers || {})) res.setHeader(k, v)

  // ---- 流式响应（聊天）----
  // 上游是 DeepSeek 的 SSE 流，这里原样转发给浏览器，前端才能逐字显示。
  // 不缓冲、不解析，中间多一层解析只会增加出错面。
  if (result.stream) {
    const reader = result.stream.getReader()
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        res.write(Buffer.from(value))
      }
    } catch {
      // 用户关掉页面，或上游中断：直接收尾，不再尝试写（写了也是抛错）
    }
    res.end()
    return
  }

  res.end(result.body)
}
