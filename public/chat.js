// Chat transcript rendering. Each session keeps a list of "blocks" derived from
// session/update notifications, and we render incrementally into the DOM.
import { renderMarkdown } from "./markdown.js";

const STATUS_LABELS = {
  pending: "pending",
  in_progress: "running",
  completed: "done",
  failed: "failed",
};

export class TranscriptView {
  constructor(rootEl) {
    this.root = rootEl;
    /** Map blockKey -> DOM element. Keys: `tool:<id>`, `msg:<seq>`, `plan` */
    this.elements = new Map();
    /** Sequence counter for streaming message bubbles. */
    this.seq = 0;
    /** Current open agent_message_chunk bubble (string -> el). */
    this.currentAssistantBubble = null;
    this.currentThoughtBubble = null;
  }

  clear() {
    this.root.replaceChildren();
    this.elements.clear();
    this.currentAssistantBubble = null;
    this.currentThoughtBubble = null;
    this.seq = 0;
  }

  finishTurn() {
    this.currentAssistantBubble = null;
    this.currentThoughtBubble = null;
  }

  // ---- user messages ------------------------------------------------------

  appendUserPrompt(content) {
    const text = content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n");
    const images = content.filter((b) => b.type === "image");

    const el = document.createElement("div");
    el.className = "bubble user";
    if (text) {
      const md = document.createElement("div");
      md.className = "markdown";
      md.innerHTML = renderMarkdown(text);
      el.appendChild(md);
    }
    for (const img of images) {
      const i = document.createElement("img");
      i.src = `data:${img.mimeType};base64,${img.data}`;
      i.style.maxWidth = "200px";
      i.style.borderRadius = "6px";
      el.appendChild(i);
    }
    this.append(el);
  }

  // ---- session updates ---------------------------------------------------

  applyUpdate(u) {
    switch (u.sessionUpdate) {
      case "agent_message_chunk":
        return this.appendChunk("assistant", u.content);
      case "agent_thought_chunk":
        return this.appendChunk("thought", u.content);
      case "user_message_chunk":
        return this.appendChunk("user", u.content);
      case "tool_call":
        return this.upsertToolCall(u, true);
      case "tool_call_update":
        return this.upsertToolCall(u, false);
      case "plan":
        return this.renderPlan(u.entries);
      case "available_commands_update":
        return; // could surface slash commands; skipped for now
      case "current_mode_update":
        return;
    }
  }

  appendChunk(kind, block) {
    const text = block?.type === "text" ? block.text : "";
    if (!text) return;
    let bubble =
      kind === "assistant"
        ? this.currentAssistantBubble
        : kind === "thought"
          ? this.currentThoughtBubble
          : null;
    if (!bubble) {
      bubble = document.createElement("div");
      bubble.className =
        kind === "thought" ? "bubble thought" : `bubble ${kind}`;
      bubble.dataset.markdown = "";
      bubble.innerHTML = '<div class="markdown"></div>';
      this.append(bubble);
      if (kind === "assistant") this.currentAssistantBubble = bubble;
      if (kind === "thought") this.currentThoughtBubble = bubble;
    }
    bubble.dataset.markdown += text;
    bubble.querySelector(".markdown").innerHTML = renderMarkdown(
      bubble.dataset.markdown,
    );
    this.scrollToBottom();
  }

  upsertToolCall(u, isNew) {
    const key = `tool:${u.toolCallId}`;
    let el = this.elements.get(key);
    if (!el) {
      el = this.createToolEl(u);
      this.elements.set(key, el);
      this.append(el);
      // tool calls reset the message-chunk grouping so subsequent agent text
      // appears in a fresh bubble after the tool block.
      this.currentAssistantBubble = null;
      this.currentThoughtBubble = null;
    }
    this.updateToolEl(el, u);
  }

  createToolEl(u) {
    const el = document.createElement("div");
    el.className = "tool";
    el.innerHTML = `
      <div class="tool-header">
        <span class="tool-status"></span>
        <span class="tool-kind"></span>
        <span class="tool-title"></span>
        <span class="tool-caret">›</span>
      </div>
      <div class="tool-body">
        <div class="tool-content"></div>
        <div class="tool-locations"></div>
      </div>`;
    el.querySelector(".tool-header").addEventListener("click", () => {
      el.classList.toggle("open");
    });
    return el;
  }

  updateToolEl(el, u) {
    if (u.status) {
      const dot = el.querySelector(".tool-status");
      dot.className = `tool-status ${u.status}`;
      dot.title = STATUS_LABELS[u.status] ?? u.status;
    }
    if (u.kind) {
      el.querySelector(".tool-kind").textContent = u.kind;
    }
    if (u.title !== undefined) {
      el.querySelector(".tool-title").textContent = u.title ?? "";
    }
    if (u.locations && u.locations.length) {
      el.querySelector(".tool-locations").textContent = u.locations
        .map((l) => (l.line != null ? `${l.path}:${l.line}` : l.path))
        .join("  ·  ");
    }
    if (u.content) {
      this.renderToolContent(el.querySelector(".tool-content"), u.content);
    }
    this.scrollToBottom();
  }

  renderToolContent(host, content) {
    host.replaceChildren();
    for (const c of content) {
      if (c.type === "content") {
        const text = c.content?.type === "text" ? c.content.text : "";
        if (text) {
          const md = document.createElement("div");
          md.className = "markdown";
          md.innerHTML = renderMarkdown(text);
          host.appendChild(md);
        }
      } else if (c.type === "diff") {
        host.appendChild(this.renderDiff(c));
      } else if (c.type === "terminal") {
        const ph = document.createElement("div");
        ph.className = "markdown";
        ph.innerHTML = `<p><em>terminal: ${c.terminalId}</em></p>`;
        host.appendChild(ph);
      }
    }
  }

  renderDiff(diff) {
    const wrap = document.createElement("div");
    wrap.className = "diff";
    const path = document.createElement("div");
    path.className = "diff-path";
    path.textContent = diff.path;
    wrap.appendChild(path);
    const oldLines = (diff.oldText ?? "").split("\n");
    const newLines = (diff.newText ?? "").split("\n");
    // Naive line-by-line diff.
    const max = Math.max(oldLines.length, newLines.length);
    for (let i = 0; i < max; i++) {
      const o = oldLines[i];
      const n = newLines[i];
      if (o === n) {
        if (o !== undefined) wrap.appendChild(diffLine(" ", o));
      } else {
        if (o !== undefined) wrap.appendChild(diffLine("-", o, "del"));
        if (n !== undefined) wrap.appendChild(diffLine("+", n, "add"));
      }
    }
    return wrap;
  }

  renderPlan(entries) {
    let el = this.elements.get("plan");
    if (!el) {
      el = document.createElement("div");
      el.className = "plan";
      el.innerHTML = "<h3>Plan</h3><ol></ol>";
      this.elements.set("plan", el);
      this.append(el);
    }
    const ol = el.querySelector("ol");
    ol.replaceChildren();
    for (const e of entries) {
      const li = document.createElement("li");
      if (e.status) li.classList.add(e.status);
      li.textContent = e.content;
      ol.appendChild(li);
    }
    this.scrollToBottom();
  }

  // ---- internal -----------------------------------------------------------

  append(el) {
    this.root.appendChild(el);
    this.scrollToBottom();
  }

  scrollToBottom() {
    this.root.scrollTop = this.root.scrollHeight;
  }
}

function diffLine(prefix, text, kind) {
  const el = document.createElement("div");
  el.className = "diff-line" + (kind ? ` ${kind}` : "");
  el.textContent = prefix + " " + text;
  return el;
}
