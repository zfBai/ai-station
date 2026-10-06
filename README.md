# AI 助手站（ai-station）

给朋友临时用 DeepSeek 聊天的站点。你自己签发令牌，朋友凭令牌进来聊，到期自动失效，也能随时手动关闭。

```
你（管理员）              朋友（访客）
   │                        │
  登录 → 创建令牌           │
  拿到 XXXX-XXXX-XXXX-XXXX ─┼→ 打开网站，粘进令牌
  随时点「关闭」           └→ 直接开聊（像 ChatGPT 那样逐字出结果）
```

- 面向用户的地址：**https://chat.mltd-imagesaving.site**
- 账号：管理员用**图床的 SU 账号**（image.mltd-imagesaving.site 那个），不用单独注册
- 令牌：默认 24 小时有效，可自选 1 小时 ~ 30 天，**随时能提前关闭，关掉立刻失效**
- 模型：**`deepseek-flash`**（就是 DeepSeek-V4.1-Flash）

> ⚠️ **模型名别写错**：官方 API 里叫 `deepseek-flash`。
> `deepseek-v4.1-flash` 是 OpenRouter 那类第三方网关自己的编号，填到官方接口会报 model not found。
> 模型名做成了环境变量，要换随时能改。

---

## 一、它是怎么工作的

```
朋友浏览器              本站函数(Vercel)              DeepSeek
    │                        │                          │
    ├── 输令牌 ─────────────►│ 查 _tokens/ 里的档案       │
    │                        │ 过期了？被关了？额度用完？  │
    │◄─── 有效，放行 ─────────┤                          │
    │                        │                          │
    ├── 发消息 ─────────────►│ 校验令牌 → 记账            │
    │                        ├─── 带上 API key 转发 ────►│
    │◄═══ 逐字流式吐回来 ══════┤◄══ SSE 流 ═══════════════┤
```

**API key 藏得住的原理**：key 只存在 Vercel 的环境变量里，浏览器发的每个请求都不带它、也拿不到它。
朋友能聊，但没法把 key 抠出来自己用——他能拿走的最多是一个 24 小时后自动失效的令牌。

**为什么用流式**：DeepSeek 一个长回答要几十秒，一次性等完体验太差。
本站把上游的 SSE 流原样转发给浏览器，所以是逐字蹦出来的效果。

### 令牌长什么样、存在哪

```
_tokens/{过期毫秒}-{令牌}.json     ← 令牌档案（备注、创建时间、用量）
_users/{用户名}.json              ← 图床写入的用户档案，本站只读
```

令牌是 16 位 base32，**去掉了 I O 0 1** 这四个容易看错的字符（要念给朋友或手打）。

过期时间写在**文件名**里，所以「列个表 + 顺手清理过期」只看键名就够，不必逐个读内容。
撤销就是把这个对象删掉，下一毫秒就进不来。

---

## 二、目录结构

```
ai-station/
├── api/
│   ├── index.js      单段入口：从 query 恢复原始路径，并负责把流式响应灌给浏览器
│   ├── core.js       全部业务逻辑：SU 鉴权 / 令牌增删查 / 流式转发 DeepSeek
│   └── store.js      数据层：Blob（生产）/ 内存（本地测试）
├── public/
│   └── index.html    前端单页：输令牌 / 聊天 / 管理面板 三种状态
├── dev-server.js     本地预览（会把 DeepSeek 换成逐字吐的假流）
├── test.js           本地全流程测试（70 项）
├── vercel.json       rewrites + 函数最大执行时长
└── package.json
```

---

## 三、本地开发

```bash
cd ai-station
node test.js          # 跑测试，70 项全过即可（不需要装依赖，也不需要真 key）
node dev-server.js    # 本地预览：http://localhost:8790
```

本地账号：管理员 `zfbai` / `siBAIsiBAI`，普通用户 `mltd` / `123456`（用来验证非管理员进不去管理页）。

本地**不会**真的调 DeepSeek：dev-server 把请求截下来，回一段逐字吐的假回复。
令牌校验、用量记账、流式输出全是真逻辑，只有模型那几个字是假的。

---

## 四、部署

### 步骤 1：建 GitHub 仓库并推送

在 GitHub 新建一个仓库（比如 `ai-station`，**不要勾** Add README），然后：

```bash
cd ai-station
git init && git add . && git commit -m "AI 助手站：令牌制 DeepSeek 聊天"
git branch -M main
git remote add origin https://github.com/zfBai/ai-station.git
git push -u origin main
```

### 步骤 2：Vercel 导入

https://vercel.com/new → 选 `ai-station` → Framework 保持 **Other** → Deploy

### 步骤 3：连接图床那个 Blob 存储

管理员账号能登录就靠这一步（要读图床写在 `_users/` 里的档案）。

1. Vercel → **Storage** → 点开图床在用的那个 Blob store
2. **Projects** 标签 → **Connect Project** → 选 `ai-station`，三个环境全勾
3. **务必勾上 `BLOB_READ_WRITE_TOKEN`**
4. 回项目 → Deployments → 最新一条 Redeploy（连存储不会自动触发部署）

### 步骤 4：绑定域名

1. 项目 → Settings → Domains → 添加 `chat.mltd-imagesaving.site`
2. 记下 Vercel 给的 CNAME 目标（形如 `xxxx.vercel-dns-017.com`）
3. Cloudflare → `mltd-imagesaving.site` → DNS → Add record：
   **CNAME | `chat` | 上面的目标 | 代理状态必须是灰色（DNS only）**

### 步骤 5：配环境变量 ⭐ 这步不做聊天用不了

项目 → Settings → Environment Variables：

| 变量 | 必填 | 说明 |
|---|---|---|
| `DEEPSEEK_API_KEY` | ✅ **必填** | 你的 DeepSeek API key，在 https://platform.deepseek.com 申请 |
| `DEEPSEEK_MODEL` | | 默认 `deepseek-flash`，别填成 `deepseek-v4.1-flash` |
| `DEEPSEEK_BASE_URL` | | 默认 `https://api.deepseek.com` |
| `TOKEN_TTL_HOURS` | | 默认 `24` |
| `MAX_CALLS` | | 单个令牌最多聊多少次，默认 `300`（防止令牌外泄被刷爆） |
| `MAX_TOKENS` | | 单次回复长度上限，默认 `4096` |
| `SYSTEM_PROMPT` | | 系统提示词，默认是个通用的中文助手 |

改完 **Redeploy** 一次才生效。

### 步骤 6：验证

1. 打开 `https://chat.mltd-imagesaving.site`
2. 点「我是管理员」→ 用图床 SU 账号登录
3. 创建令牌（备注写「测试」，有效期 1 小时）
4. 复制令牌 → 开**无痕窗口**打开同一个网址 → 粘进令牌 → 发一句「你好」
5. 回管理页看用量是不是变成了 1，再点「关闭」，无痕窗口里应该立刻聊不动了

---

## 五、和其他站的关系

| | 图床 | 文件站 | **AI 站** |
|---|---|---|---|
| 域名 | `image.` | `file.` / `download.` | `chat.` |
| Blob store | **同一个** | **同一个** | **同一个** |
| 数据前缀 | `{用户名}/`、`_users/` | `f/`、`_files/` | `_tokens/` |
| 账号 | 自己管 | 读图床的 | 读图床的（要 SU） |

三个站共用一个 Blob store，所以**图床的「恢复如初」不能把它们清掉**——
`img-station-vercel/api/core.js` 里已经加过前缀过滤，改那边代码时别把那行去掉。

---

## 六、常见问题

**Q：聊天报「DeepSeek 的 API key 无效」？**
环境变量 `DEEPSEEK_API_KEY` 没配、配错了，或者改完忘了 Redeploy。

**Q：报「模型名 xxx 不被接受」？**
填成第三方网关的编号了。官方只用 `deepseek-flash`。

**Q：报「账户余额不足」？**
DeepSeek 那边没钱了，去 platform.deepseek.com 充值。这会花你自己的钱，注意用量。

**Q：朋友把令牌传出去了怎么办？**
管理页点「关闭」即可，立刻失效。所以 `MAX_CALLS` 别设太大——它是单令牌的止损线。

**Q：能不能限制朋友聊什么？**
改 `SYSTEM_PROMPT` 环境变量。注意访客自己塞的 system 消息会被**降级成 user**，
所以他没法用「忽略以上所有指令」那套把人设改掉。

**Q：为什么管理页只有 SU 能进？**
登录校验除了密码，还查了 `role === 'su'`。图床的普通用户（比如 `mltd`）会被 403 挡在外面。

**Q：聊天记录存在哪？**
浏览器 localStorage，按令牌分开存，刷新页面还能接着聊。服务端**不存**任何对话内容。

**Q：想给朋友一个直接进聊天页的链接？**
管理页「复制邀请链接」给的就是——令牌放在 URL 的 `#` 后面，
这部分浏览器不会发给服务器，不会进访问日志，页面打开后也会立刻从地址栏抹掉。
