// Tiny safe markdown renderer for chat content.
// Handles: paragraphs, headings, bold, italic, inline code, fenced code blocks,
// ordered/unordered lists, links, hard line breaks. Escapes HTML by default.
// A small allowlist of media tags (<audio>, <video>) is preserved so agents
// can embed playable media in responses.

const MEDIA_TAGS = {
  audio: new Set(["controls", "preload", "loop", "muted", "src"]),
  video: new Set([
    "controls",
    "preload",
    "loop",
    "muted",
    "src",
    "poster",
    "width",
    "height",
  ]),
  img: new Set(["src", "alt", "width", "height"]),
};
const VOID_MEDIA = new Set(["img"]);
const CONTAINER_MEDIA_RE =
  /<(audio|video)((?:\s[^>]*)?)(?:\s*\/\s*>|>\s*<\/\1\s*>)/gi;
const VOID_MEDIA_RE = /<(img)((?:\s[^>]*)?)\s*\/?>/gi;
const URL_OK_RE = /^(https?:\/\/|\/|\.{1,2}\/)/;

function sanitizeMediaTag(tag, attrsStr) {
  const allowed = MEDIA_TAGS[tag];
  const parts = [];
  const re = /(\w[\w-]*)(?:=("([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  let m;
  while ((m = re.exec(attrsStr)) !== null) {
    const name = m[1].toLowerCase();
    if (!allowed.has(name)) continue;
    const value = m[3] ?? m[4] ?? m[5];
    if (name === "src" || name === "poster") {
      if (!value || !URL_OK_RE.test(value)) continue;
      parts.push(`${name}="${escapeAttr(value)}"`);
    } else if (value == null) {
      parts.push(name);
    } else {
      parts.push(`${name}="${escapeAttr(value)}"`);
    }
  }
  return VOID_MEDIA.has(tag)
    ? `<${tag} ${parts.join(" ")}>`
    : `<${tag} ${parts.join(" ")}></${tag}>`;
}

function escapeAttr(s) {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

function preserveMedia(src, sink) {
  const swap = (re) => (input) =>
    input.replace(re, (_, tag, attrs) => {
      const safe = sanitizeMediaTag(tag.toLowerCase(), attrs ?? "");
      const key = `\u0000MEDIA${sink.length}\u0000`;
      sink.push(safe);
      return key;
    });
  return swap(VOID_MEDIA_RE)(swap(CONTAINER_MEDIA_RE)(src));
}

// ---- math ----------------------------------------------------------------
// Recognised delimiters, longest first so $$ is checked before $.
const MATH_RULES = [
  { open: "$$", close: "$$", display: true },
  { open: "\\[", close: "\\]", display: true },
  { open: "\\(", close: "\\)", display: false },
  { open: "$", close: "$", display: false },
];

function preserveMath(src, sink) {
  let out = "";
  let i = 0;
  outer: while (i < src.length) {
    // Skip past inline code spans so $ inside `code` is left alone.
    if (src[i] === "`") {
      const end = src.indexOf("`", i + 1);
      if (end !== -1) {
        out += src.slice(i, end + 1);
        i = end + 1;
        continue;
      }
    }
    // Skip past fenced code blocks for the same reason.
    if (src.startsWith("```", i)) {
      const end = src.indexOf("```", i + 3);
      if (end !== -1) {
        out += src.slice(i, end + 3);
        i = end + 3;
        continue;
      }
    }
    for (const rule of MATH_RULES) {
      if (!src.startsWith(rule.open, i)) continue;
      // $...$ requires that the char before $ is not $ or \ (avoid eating $$
      // boundaries and escaped dollars).
      if (rule.open === "$") {
        const prev = src[i - 1];
        if (prev === "$" || prev === "\\") continue;
      }
      const start = i + rule.open.length;
      const end = src.indexOf(rule.close, start);
      if (end === -1) continue;
      const body = src.slice(start, end);
      // Inline $...$ must not span lines or be empty.
      if (rule.open === "$" && (body.length === 0 || /\n/.test(body))) continue;
      const key = `\u0000MATH${sink.length}\u0000`;
      sink.push({ tex: body, display: rule.display });
      out += key;
      i = end + rule.close.length;
      continue outer;
    }
    out += src[i];
    i++;
  }
  return out;
}

function restoreMath(html, sink) {
  if (!sink.length) return html;
  return html.replace(/\u0000MATH(\d+)\u0000/g, (_, idx) => {
    const { tex, display } = sink[Number(idx)];
    if (typeof window !== "undefined" && window.katex) {
      try {
        return window.katex.renderToString(tex, {
          displayMode: display,
          throwOnError: false,
          output: "html",
        });
      } catch (e) {
        return `<span class="math-error">${escapeAttr(tex)}</span>`;
      }
    }
    // KaTeX not loaded yet: fall back to raw text. The bubble re-renders on
    // each chunk, so a later chunk (or next user action) will hit this path
    // again once katex.min.js has loaded.
    return display
      ? `<pre class="math-fallback">${escapeAttr(tex)}</pre>`
      : `<code class="math-fallback">${escapeAttr(tex)}</code>`;
  });
}

function restoreMedia(html, sink) {
  if (!sink.length) return html;
  return html.replace(/\u0000MEDIA(\d+)\u0000/g, (_, i) => sink[Number(i)]);
}

function escapeHtml(s) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderInline(s) {
  let t = escapeHtml(s);
  // Inline code first to protect contents from other transforms.
  t = t.replace(/`([^`]+)`/g, (_, c) => `<code>${c}</code>`);
  // Bold then italic.
  t = t.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  t = t.replace(/(^|[^*])\*([^*]+)\*(?!\*)/g, "$1<em>$2</em>");
  // Links [text](url) — only http(s) and relative paths.
  t = t.replace(
    /\[([^\]]+)\]\(([^)\s]+)\)/g,
    (m, label, url) => {
      if (/^(https?:\/\/|\/|\.{1,2}\/)/.test(url)) {
        return `<a href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>`;
      }
      return m;
    },
  );
  return t;
}

export function renderMarkdown(src) {
  if (!src) return "";
  const media = [];
  const math = [];
  // Math is preserved first so $...$ inside it can't be touched by escapeHtml;
  // media tags are preserved next so they survive paragraph wrapping.
  const preprocessed = preserveMedia(preserveMath(src, math), media);
  const lines = preprocessed.replace(/\r\n?/g, "\n").split("\n");
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    // Fenced code block.
    const fence = /^```(\w+)?\s*$/.exec(line);
    if (fence) {
      const lang = fence[1] ?? "";
      const buf = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) {
        buf.push(lines[i]);
        i++;
      }
      if (i < lines.length) i++; // closing fence
      out.push(
        `<pre><code data-lang="${escapeHtml(lang)}">${escapeHtml(
          buf.join("\n"),
        )}</code></pre>`,
      );
      continue;
    }
    // Heading.
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      const level = h[1].length;
      out.push(`<h${level}>${renderInline(h[2])}</h${level}>`);
      i++;
      continue;
    }
    // Unordered list.
    if (/^\s*[-*+]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*+]\s+/, ""));
        i++;
      }
      out.push(
        "<ul>" +
          items.map((x) => `<li>${renderInline(x)}</li>`).join("") +
          "</ul>",
      );
      continue;
    }
    // Ordered list.
    if (/^\s*\d+\.\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+\.\s+/, ""));
        i++;
      }
      out.push(
        "<ol>" +
          items.map((x) => `<li>${renderInline(x)}</li>`).join("") +
          "</ol>",
      );
      continue;
    }
    // Blank line.
    if (/^\s*$/.test(line)) {
      i++;
      continue;
    }
    // Paragraph: gather until blank or block-starter.
    const buf = [];
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !/^```/.test(lines[i]) &&
      !/^#{1,6}\s+/.test(lines[i]) &&
      !/^\s*([-*+]|\d+\.)\s+/.test(lines[i])
    ) {
      buf.push(lines[i]);
      i++;
    }
    out.push(`<p>${renderInline(buf.join(" "))}</p>`);
  }
  return restoreMath(restoreMedia(out.join(""), media), math);
}
