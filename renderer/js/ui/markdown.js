'use strict';

// ============================================================================
//  ui/markdown.js —— 极简 Markdown 渲染
//  先整体转义 HTML，再按块级/行内规则替换，所以内容是安全的。
//  这个模块不依赖任何别的东西，可以单独拿去测。
// ============================================================================

export function esc(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function renderInline(text) {
  let out = text;

  // 行内代码 `code` —— 先抽出来占位，避免里面的符号被当成格式
  const codes = [];
  out = out.replace(/`([^`\n]+)`/g, (_m, code) => {
    codes.push(code);
    return `\u0000C${codes.length - 1}\u0000`;
  });

  out = out.replace(/\*\*\*([^*\n]+)\*\*\*/g, '<strong><em>$1</em></strong>');
  out = out.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  out = out.replace(/~~([^~\n]+)~~/g, '<del>$1</del>');

  // ==高亮== —— 比加粗更重的一档：加粗 + 主题色 + 一点底色。
  // 长段落的对话容易看累，靠它把「关键的那一句」拎出来。
  // 用 == 是 Markdown 高亮的通行写法（Obsidian / Typora 都认），模型也更容易照做。
  out = out.replace(/==([^=\n]+)==/g, '<mark class="msg-em">$1</mark>');

  // 链接：只放行 http/https，其他一律当普通文字
  const links = [];
  out = out
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (_m, label, href) => {
      links.push(`<a href="${href}" target="_blank" rel="noreferrer">${label}</a>`);
      return `\u0000L${links.length - 1}\u0000`;
    })
    .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, (_m, pre, href) => {
      links.push(`<a href="${href}" target="_blank" rel="noreferrer">${href}</a>`);
      return `${pre}\u0000L${links.length - 1}\u0000`;
    });

  out = out.replace(/\u0000C(\d+)\u0000/g, (_m, i) => `<code>${codes[Number(i)]}</code>`);
  out = out.replace(/\u0000L(\d+)\u0000/g, (_m, i) => links[Number(i)]);
  return out;
}

export function renderMarkdown(source, options) {
  let text = String(source == null ? '' : source).replace(/\r\n/g, '\n');

  // 流式生成中，代码块可能只来了一半：临时补个结尾，免得显示成乱码
  if (options && options.streaming) {
    const fences = (text.match(/```/g) || []).length;
    if (fences % 2 === 1) text += '\n```';
  }

  // 1. 先把 ``` 代码块抽出来，避免块内内容被解析
  const blocks = [];
  const withoutFences = text.replace(/```([\w+#.-]*)\n?([\s\S]*?)```/g, (_m, lang, code) => {
    const cls = lang ? ` class="language-${esc(lang.toLowerCase())}"` : '';
    blocks.push(`<pre><code${cls}>${esc(code.replace(/\n$/, ''))}</code></pre>`);
    return `\n\u0000B${blocks.length - 1}\u0000\n`;
  });

  // 2. 逐行处理块级元素
  const lines = esc(withoutFences).split('\n');
  const out = [];
  let listType = null;

  const closeList = () => {
    if (listType) {
      out.push(`</${listType}>`);
      listType = null;
    }
  };

  for (const line of lines) {
    const trimmed = line.trim();

    if (/^\u0000B\d+\u0000$/.test(trimmed)) {
      closeList();
      out.push(trimmed);
      continue;
    }

    if (!trimmed) {
      closeList();
      continue;
    }

    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      closeList();
      out.push('<hr />');
      continue;
    }

    const heading = trimmed.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      closeList();
      const level = Math.min(3, heading[1].length);
      out.push(`<h${level}>${renderInline(heading[2])}</h${level}>`);
      continue;
    }

    const quote = trimmed.match(/^&gt;\s?(.*)$/);
    if (quote) {
      closeList();
      out.push(`<blockquote>${renderInline(quote[1])}</blockquote>`);
      continue;
    }

    const bullet = trimmed.match(/^[-*+]\s+(.*)$/);
    if (bullet) {
      if (listType !== 'ul') {
        closeList();
        out.push('<ul>');
        listType = 'ul';
      }
      out.push(`<li>${renderInline(bullet[1])}</li>`);
      continue;
    }

    const ordered = trimmed.match(/^\d+[.)]\s+(.*)$/);
    if (ordered) {
      if (listType !== 'ol') {
        closeList();
        out.push('<ol>');
        listType = 'ol';
      }
      out.push(`<li>${renderInline(ordered[1])}</li>`);
      continue;
    }

    closeList();

    // 心理描写：以标记开头的整段单独成块，渲染成弱化的旁白样式。
    // 标记本身不显示 —— 有样式就不需要文字标记占位了。
    // 只认「段落以标记开头」，所以正文里提到「【心理】」这三个字不会被误伤；
    // 流式生成时半截标记（「【心」）也匹配不上，不会闪。
    const inner = trimmed.match(/^【(心理|内心|心声)】\s*(.*)$/);
    if (inner) {
      out.push(`<p class="msg-inner">${renderInline(inner[2])}</p>`);
      continue;
    }

    const aside = trimmed.match(/^【(旁白|上帝视角|全知)】\s*(.*)$/);
    if (aside) {
      out.push(`<p class="msg-aside">${renderInline(aside[2])}</p>`);
      continue;
    }

    out.push(`<p>${renderInline(trimmed)}</p>`);
  }
  closeList();

  let html = out.join('\n');

  // 3. 还原代码块
  html = html.replace(/\u0000B(\d+)\u0000/g, (_m, i) => blocks[Number(i)]);
  return html;
}
