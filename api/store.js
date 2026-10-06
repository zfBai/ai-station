// 数据层：临时令牌与用户档案都存在 Vercel Blob 上（无数据库方案）
//   - 临时令牌：_tokens/{令牌}.json
//   - 用户档案：_users/{用户名}.json —— 与图床（img-station）共用同一个 Blob store，格式完全一致
//
// 提供两种实现：Blob（生产）和内存（本地测试），接口完全一致。
//
// 接口：
//   listFiles(prefix)           列出某前缀下的全部对象（自动翻页）
//   putFile(key, buf, type)     写入对象，返回 { url }
//   deleteFile(key)             删除对象
//   readFile(key)               读对象内容（不存在返回 null）
//   readUser(username)          读用户档案（不存在返回 null）

// ============ 生产实现：Vercel Blob ============
function createBlobStore() {
  // 延迟 require：本地测试（内存模式）不需要安装 @vercel/blob
  // 注意：@vercel/blob SDK 没有 get()，读取对象内容需用 list 拿 URL 再 fetch
  const { put, list, del } = require('@vercel/blob')

  return {
    async listFiles(prefix = '') {
      const all = []
      let cursor
      do {
        // Blob 的 prefix/pathname 规范格式不带开头斜杠（如 _tokens/），limit 上限 1000，自动翻页
        const page = await list({ prefix, limit: 1000, cursor })
        for (const b of page.blobs) {
          // 防御：服务端返回的 pathname 偶尔带前导 /，统一 normalize 成不带斜杠的 key
          all.push({ Key: b.pathname.replace(/^\//, ''), Size: b.size, LastModified: b.uploadedAt, url: b.url })
        }
        cursor = page.hasMore ? page.cursor : null
      } while (cursor && all.length < 20000) // 安全上限，防止异常死循环
      return all.filter(c => !c.Key.endsWith('/'))
    },

    async putFile(key, buf, contentType) {
      const result = await put(key, buf, {
        contentType,
        access: 'public',
        addRandomSuffix: false, // key 已含随机令牌，直链必须与 key 一一对应
        cacheControlMaxAge: 60, // 最小值；实际读取靠下面的缓存破坏参数绕开
      })
      return { url: result.url }
    },

    async deleteFile(key) {
      await del(key) // 删除不存在的对象不报错（幂等）
    },

    // 读对象内容：SDK 没有 get()，只能用 list 拿到直链再 fetch；对象不存在返回 null
    //
    // ⚠️ 这里必须绕开 CDN 缓存。撤销/删除令牌后要立刻生效，
    // 而 Blob 的直链会被 CDN 缓存至少 60 秒，照原样 fetch 会读到撤销前的旧副本。
    // 加一个每次都不同的查询参数，让每次读取都回源（令牌文件只有几百字节，开销可忽略）。
    async readFile(key) {
      const prefix = key.slice(0, key.lastIndexOf('/') + 1)
      const f = (await this.listFiles(prefix)).find(c => c.Key === key)
      if (!f) return null
      const bust = `t=${Date.now()}-${Math.random().toString(36).slice(2)}`
      const res = await fetch(`${f.url}?${bust}`, { cache: 'no-store' })
      if (!res.ok) return null
      return Buffer.from(await res.arrayBuffer())
    },

    async readUser(username) {
      const buf = await this.readFile(`_users/${username}.json`)
      return buf ? JSON.parse(buf.toString('utf8')) : null
    },
  }
}

// ============ 测试实现：内存 ============
function createMemoryStore() {
  const files = new Map() // key -> { buf, type, lastModified }

  return {
    async listFiles(prefix = '') {
      const out = []
      for (const [key, f] of files) {
        if (key.startsWith(prefix)) {
          out.push({ Key: key, Size: f.buf.length, LastModified: f.lastModified, url: key })
        }
      }
      return out.filter(c => !c.Key.endsWith('/'))
    },

    async putFile(key, buf, contentType) {
      files.set(key, { buf, type: contentType, lastModified: new Date().toISOString() })
      return { url: key } // 内存模式直接用 key 当 url，方便测试删除逻辑
    },

    async deleteFile(key) {
      files.delete(key)
    },

    async readFile(key) {
      const f = files.get(key)
      return f ? f.buf : null
    },

    async readUser(username) {
      const buf = await this.readFile(`_users/${username}.json`)
      return buf ? JSON.parse(buf.toString('utf8')) : null
    },

    // 测试辅助：写入用户档案（生产环境用户档案由图床项目写入，本项目的 store 不提供）
    async _writeUser(user) {
      await this.putFile(`_users/${user.username}.json`, Buffer.from(JSON.stringify(user)), 'application/json')
    },
  }
}

// 选择实现：默认 Blob；设 TEST_MEMORY=1 时用内存（本地测试用）
module.exports = process.env.TEST_MEMORY === '1' ? createMemoryStore() : createBlobStore()
