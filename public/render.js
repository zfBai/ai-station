/**
 * render.js —— 聊天内容渲染管线：Markdown（markdown-it）+ LaTeX（KaTeX）
 *
 * 浏览器：先加载 vendor/markdown-it.min.js 与 vendor/katex.min.js，本文件挂 window.AiRender
 * Node：module.exports（供 test.js 直接 require），内部 require ./vendor/*.min.js
 *
 * 安全性：markdown-it 以 html:false 运行，原始 HTML 一律转义；KaTeX 输出自带转义。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./vendor/markdown-it.min.js'), require('./vendor/katex.min.js'))
  } else {
    root.AiRender = factory(root.markdownit, root.katex)
  }
})(typeof self !== 'undefined' ? self : this, function (markdownit, katex) {
  'use strict'

  /* ---------- 常量与工具 ---------- */

  var PH_START = '\uE000' // 占位符起始（Unicode 私有区）
  var PH_END = '\uE001' // 占位符结束
  var PUA_RE = /[\uE000-\uF8FF]/g // 输入先清空私有区字符，避免与占位符撞车

  var HTML_ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) { return HTML_ESC[c] })
  }

  function isDigit(ch) {
    return ch >= '0' && ch <= '9'
  }

  // 位置 i 是否被反斜杠转义（前面连续奇数个 \）
  function isEscaped(src, i) {
    var k = 0
    while (i - k - 1 >= 0 && src[i - k - 1] === '\\') k++
    return k % 2 === 1
  }

  // 从 from 起找未转义的 token，找不到返回 -1
  function findUnescaped(src, token, from) {
    var i = src.indexOf(token, from)
    while (i >= 0) {
      if (!isEscaped(src, i)) return i
      i = src.indexOf(token, i + 1)
    }
    return -1
  }

  // i 是否处于行首（前面只允许 0~3 个空格/tab）
  function atLineStart(src, i) {
    var k = i
    var sp = 0
    while (k > 0 && (src[k - 1] === ' ' || src[k - 1] === '\t')) { k--; sp++ }
    return sp <= 3 && (k === 0 || src[k - 1] === '\n')
  }

  // 找闭合围栏（行首、同字符、数量 >= len），返回闭合行之后的下标；找不到返回 -1
  function findFenceEnd(src, from, ch, len) {
    var lineStart = from
    while (lineStart <= src.length) {
      var lineEnd = src.indexOf('\n', lineStart)
      if (lineEnd < 0) lineEnd = src.length
      var j = lineStart
      var sp = 0
      while (j < lineEnd && (src[j] === ' ' || src[j] === '\t')) { j++; sp++ }
      if (sp <= 3 && src[j] === ch) {
        var k = j
        while (k < lineEnd && src[k] === ch) k++
        if (k - j >= len) return lineEnd < src.length ? lineEnd + 1 : lineEnd
      }
      if (lineEnd >= src.length) break
      lineStart = lineEnd + 1
    }
    return -1
  }

  // 找到与 i 处反引号串等长的闭合，返回其后下标；未闭合返回 -1
  function findInlineCodeEnd(src, i) {
    var j = i
    while (j < src.length && src[j] === '`') j++
    var len = j - i
    var tick = new Array(len + 1).join('`')
    var close = src.indexOf(tick, j)
    while (close >= 0) {
      var k = close + len
      if (src[k] !== '`') return k // 闭段后还有反引号则长度不匹配，继续找
      close = src.indexOf(tick, k)
    }
    return -1
  }

  // 行内 $...$ 的闭合位置；不满足启发式则返回 -1
  // 规则：开 $ 后不能是空白；闭 $ 前不能是空白、后不能是数字（防「$5 到 $10」误判）；不跨行
  function findInlineDollarEnd(src, from) {
    if (from >= src.length || /\s/.test(src[from])) return -1
    for (var k = from; k < src.length; k++) {
      var ch = src[k]
      if (ch === '\n') return -1
      if (ch === '$' && !isEscaped(src, k)) {
        if (k === from) return -1
        if (/\s/.test(src[k - 1])) return -1
        if (isDigit(src[k + 1])) return -1
        return k
      }
    }
    return -1
  }

  /**
   * 提取数学公式并替换为私有区占位符（代码区整体跳过）
   * 支持 $$...$$、\[...\]、\(...\)、$...$、\begin{}...\end{}
   * @param {string} src
   * @param {function(string, boolean): string} renderTex 公式 -> HTML
   * @returns {{text: string, items: string[]}}
   */
  function extractMath(src, renderTex) {
    var out = ''
    var items = []
    var i = 0
    var n = src.length
    var plainStart = 0

    function emit(tex, display) {
      out += src.slice(plainStart, i)
      out += PH_START + items.length + PH_END
      items.push(renderTex(tex, display))
    }

    while (i < n) {
      var c = src[i]

      // 代码围栏（``` / ~~~）
      if ((c === '`' || c === '~') && atLineStart(src, i)) {
        var j = i
        while (j < n && src[j] === c) j++
        var flen = j - i
        if (flen >= 3) {
          var fend = findFenceEnd(src, j, c, flen)
          i = fend < 0 ? n : fend // 未闭合围栏延伸到文末（与 CommonMark 一致）
          continue
        }
      }

      // 行内代码
      if (c === '`') {
        var cend = findInlineCodeEnd(src, i)
        i = cend < 0 ? i + 1 : cend
        continue
      }

      // \( \) \[ \] 与 \begin{}...\end{}
      if (c === '\\' && !isEscaped(src, i)) {
        var d = src[i + 1]
        if (d === '(' || d === '[') {
          var closer = d === '(' ? '\\)' : '\\]'
          var e = findUnescaped(src, closer, i + 2)
          if (e >= 0) {
            emit(src.slice(i + 2, e), d === '[')
            i = e + 2
            plainStart = i
            continue
          }
        } else if (d === 'b') {
          var m = /^\\begin\{([a-zA-Z*]+)\}/.exec(src.slice(i))
          if (m) {
            var endTag = '\\end{' + m[1] + '}'
            var e2 = findUnescaped(src, endTag, i + m[0].length)
            if (e2 >= 0) {
              emit(src.slice(i, e2 + endTag.length), true)
              i = e2 + endTag.length
              plainStart = i
              continue
            }
          }
        }
        i++
        continue
      }

      // $$...$$ 与 $...$
      if (c === '$' && !isEscaped(src, i) && src[i - 1] !== '$' && !isDigit(src[i - 1])) {
        if (src[i + 1] === '$') {
          var de = findUnescaped(src, '$$', i + 2)
          if (de >= 0) {
            emit(src.slice(i + 2, de), true)
            i = de + 2
            plainStart = i
            continue
          }
        } else {
          var se = findInlineDollarEnd(src, i + 1)
          if (se > 0) {
            emit(src.slice(i + 1, se), false)
            i = se + 1
            plainStart = i
            continue
          }
        }
        i++
        continue
      }

      i++
    }

    out += src.slice(plainStart, n)
    return { text: out, items: items }
  }

  /* ---------- 渲染器 ---------- */

  // KaTeX 渲染 + memoize（流式重渲染时同一公式只算一次；上限防半成品公式撑爆缓存）
  function makeRenderTex(Katex) {
    var cache = Object.create(null)
    var keys = []
    var LIMIT = 600

    return function (tex, display) {
      var key = (display ? 'D' : 'I') + tex
      var hit = cache[key]
      if (hit !== undefined) return hit
      var html
      try {
        html = Katex.renderToString(tex, {
          displayMode: display,
          throwOnError: false,
          output: 'html' // 不输出 MathML：流式重渲染下 DOM 减半
        })
      } catch (err) {
        html = '<code class="math-err">' + escapeHtml(tex) + '</code>'
      }
      if (keys.length >= LIMIT) {
        cache = Object.create(null)
        keys = []
      }
      cache[key] = html
      keys.push(key)
      return html
    }
  }

  function createRenderer(mdit, Katex) {
    var md = mdit({
      html: false, // 不解析原始 HTML，双保险防注入
      linkify: true, // 裸 URL 变链接
      breaks: true, // 单个换行即换行（聊天习惯）
      typographer: false
    })

    // 链接一律新窗口打开
    var defaultLinkOpen = md.renderer.rules.link_open ||
      function (tokens, idx, options, env, self) { return self.renderToken(tokens, idx, options) }
    md.renderer.rules.link_open = function (tokens, idx, options, env, self) {
      tokens[idx].attrSet('target', '_blank')
      tokens[idx].attrSet('rel', 'noopener noreferrer')
      return defaultLinkOpen(tokens, idx, options, env, self)
    }

    var renderTex = makeRenderTex(Katex)

    function render(text) {
      if (text == null) return ''
      var src = String(text).replace(PUA_RE, '')
      var ex = extractMath(src, renderTex)
      var html = md.render(ex.text)
      // 独立成段的公式不要被 <p> 包着（KaTeX display 输出块级布局）
      html = html.replace(/<p>\uE000(\d+)\uE001<\/p>/g, function (_, id) {
        return ex.items[+id]
      })
      // 其余（行内 / 混排）逐个还原
      html = html.replace(/\uE000(\d+)\uE001/g, function (_, id) {
        return ex.items[+id]
      })
      return html
    }

    return { render: render }
  }

  /* ---------- 导出 ---------- */

  var API
  if (typeof markdownit === 'function' && katex && typeof katex.renderToString === 'function') {
    API = createRenderer(markdownit, katex)
  } else {
    // 依赖缺失时降级为纯文本（转义 + 换行），保证聊天仍可用
    if (typeof console !== 'undefined' && console.warn) {
      console.warn('[AiRender] 缺少 markdown-it / katex，已降级为纯文本渲染')
    }
    API = {
      render: function (text) {
        if (text == null) return ''
        return escapeHtml(String(text).replace(PUA_RE, '')).replace(/\n/g, '<br>')
      }
    }
  }

  API.escapeHtml = escapeHtml
  return API
})
