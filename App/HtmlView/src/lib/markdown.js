// 产物 Markdown 预览渲染
// marked(GFM) 解析 → DOMPurify 消毒 → 相对链接/图片回链同任务产物 → 代码高亮 + 复制条
// 输出可直接 v-html 的 HTML；不在渲染前放行任何未消毒的字符串。

import { Marked } from 'marked'
import DOMPurify from 'dompurify'
import hljs from 'highlight.js/lib/core'
import bash from 'highlight.js/lib/languages/bash'
import c from 'highlight.js/lib/languages/c'
import cpp from 'highlight.js/lib/languages/cpp'
import css from 'highlight.js/lib/languages/css'
import go from 'highlight.js/lib/languages/go'
import java from 'highlight.js/lib/languages/java'
import javascript from 'highlight.js/lib/languages/javascript'
import json from 'highlight.js/lib/languages/json'
import kotlin from 'highlight.js/lib/languages/kotlin'
import markdown from 'highlight.js/lib/languages/markdown'
import php from 'highlight.js/lib/languages/php'
import python from 'highlight.js/lib/languages/python'
import rust from 'highlight.js/lib/languages/rust'
import sql from 'highlight.js/lib/languages/sql'
import typescript from 'highlight.js/lib/languages/typescript'
import xml from 'highlight.js/lib/languages/xml'
import yaml from 'highlight.js/lib/languages/yaml'

// core 版按需注册：覆盖产物里最常见的代码语言（别名由 highlight.js 各语言自带）
for (const [name, lang] of Object.entries({
  bash, c, cpp, css, go, java, javascript, json, kotlin,
  markdown, php, python, rust, sql, typescript, xml, yaml,
})) {
  hljs.registerLanguage(name, lang)
}

/** 可走 Markdown 渲染的产物扩展名 */
export const MD_RE = /\.(md|markdown|mdown|mkd|mdx)$/i

// breaks: true —— 预览按源文件换行显示，移动端单换行不粘连
const marked = new Marked({ gfm: true, breaks: true, async: false })

/** 把 a/../b 归一成 b；越出根（.. 太多）返回 null */
function normalizePath(base, rel) {
  const parts = `${base}/${rel}`.split('/')
  const out = []
  for (const p of parts) {
    if (!p || p === '.') continue
    if (p === '..') {
      if (!out.length) return null
      out.pop()
    } else out.push(p)
  }
  return out.join('/')
}

/** 相对 URL → 同任务产物直链；绝对 URL / 锚点返回 null（保持原样） */
function resolveArtifactUrl(url, { taskId, relPath, artifacts, artifactUrl }) {
  if (!url || !taskId || !relPath || !artifacts?.length || !artifactUrl) return null
  if (/^[a-z][a-z0-9+.-]*:/i.test(url) || url.startsWith('//') || url.startsWith('#') || url.startsWith('/')) {
    return null
  }
  const path = url.split(/[?#]/)[0]
  if (!path) return null
  const dir = relPath.includes('/') ? relPath.slice(0, relPath.lastIndexOf('/')) : ''
  const target = normalizePath(dir, path)
  if (target == null) return null
  const hit =
    artifacts.find((a) => a.rel_path === target) ||
    (!path.includes('/') && artifacts.find((a) => a.rel_path === path)) ||
    (!path.includes('/') && artifacts.find((a) => a.filename === path))
  if (!hit) return null
  return artifactUrl(taskId, hit.artifact_id, { inline: true })
}

/**
 * 渲染 Markdown 为安全 HTML
 * @param {string} src Markdown 原文
 * @param {{taskId?:number, relPath?:string, artifacts?:Array, artifactUrl?:Function}} ctx
 *        用于把文档内的相对图片/链接指回本任务产物（不给则原样保留）
 * @returns {string} 可直接 v-html 的 HTML
 */
export function renderMarkdown(src, ctx = {}) {
  const raw = marked.parse(src ?? '')
  const tpl = document.createElement('template')
  tpl.innerHTML = DOMPurify.sanitize(raw) // 先消毒：脚本/事件属性一律剥掉

  const root = tpl.content

  // 图片：相对路径回链产物；本地图片懒加载
  root.querySelectorAll('img').forEach((img) => {
    const abs = resolveArtifactUrl(img.getAttribute('src'), ctx)
    if (abs) img.setAttribute('src', abs)
    img.setAttribute('loading', 'lazy')
  })

  // 链接：相对路径回链产物；外链新标签打开
  root.querySelectorAll('a[href]').forEach((a) => {
    const href = a.getAttribute('href')
    const abs = resolveArtifactUrl(href, ctx)
    if (abs) a.setAttribute('href', abs)
    a.target = '_blank'
    a.rel = 'noopener noreferrer'
  })

  // 表格套横向滚动容器，窄屏不撑破布局
  root.querySelectorAll('table').forEach((tb) => {
    const wrap = document.createElement('div')
    wrap.className = 'md-table'
    tb.replaceWith(wrap)
    wrap.appendChild(tb)
  })

  // 代码块：语言标签 + 复制按钮（按钮事件由预览层委托处理）
  root.querySelectorAll('pre > code').forEach((code) => {
    const langKey = (code.className.match(/language-([\w+#-]+)/) || [])[1] || ''
    const lang = langKey.toLowerCase()
    if (lang && hljs.getLanguage(lang)) {
      try {
        code.innerHTML = hljs.highlight(code.textContent, {
          language: lang,
          ignoreIllegals: true,
        }).value
      } catch {
        /* 高亮失败退回纯文本 */
      }
    }
    code.classList.add('hljs')

    const pre = code.parentElement
    const wrap = document.createElement('div')
    wrap.className = 'md-code'
    const bar = document.createElement('div')
    bar.className = 'md-code-hd'
    const label = document.createElement('span')
    label.className = 'md-code-lang'
    label.textContent = lang || 'code'
    const copy = document.createElement('button')
    copy.type = 'button'
    copy.className = 'md-code-copy'
    copy.textContent = '复制'
    bar.append(label, copy)
    // 先把 pre 换成 wrap，再把 pre 挂进去；顺序反了会变成“用包含 pre 的节点替换 pre”
    pre.replaceWith(wrap)
    wrap.append(bar, pre)
  })

  return tpl.innerHTML
}
