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
        <span class="tool-summary"></span>
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
      // Edit/Write tools matter most — auto-open them immediately, before the
      // diff content streams in, so the user knows where it lives and the row
      // doesn't appear collapsed-and-empty while the input is still streaming.
      if (u.kind === "edit" && !el.dataset.autoOpened) {
        el.classList.add("open");
        el.dataset.autoOpened = "1";
      }
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
      this.applyDiffSummary(el, u.content);
    }
    this.scrollToBottom();
  }

  /**
   * If the tool call contains a diff, surface a `+N −M` summary in the header
   * and auto-expand the row the first time so the user sees the change without
   * clicking. Subsequent updates respect the user's collapse choice.
   */
  applyDiffSummary(el, content) {
    let adds = 0;
    let dels = 0;
    let hasDiff = false;
    for (const c of content) {
      if (c.type !== "diff") continue;
      hasDiff = true;
      const s = diffStats(c);
      adds += s.adds;
      dels += s.dels;
    }
    const summary = el.querySelector(".tool-summary");
    if (!hasDiff) {
      summary.textContent = "";
      return;
    }
    summary.innerHTML =
      `<span class="add">+${adds}</span> <span class="del">−${dels}</span>`;
    if (!el.dataset.autoOpened) {
      el.classList.add("open");
      el.dataset.autoOpened = "1";
    }
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
    const body = document.createElement("div");
    body.className = "diff-body";
    wrap.appendChild(body);

    const pureAdd = diff.oldText == null;
    const oldLines = pureAdd ? [] : diff.oldText.split("\n");
    const newLines = (diff.newText ?? "").split("\n");

    if (pureAdd) {
      // Write tool: every line is new.
      newLines.forEach((line, i) => {
        body.appendChild(diffLine("+", line, "add", null, i + 1));
      });
      return wrap;
    }

    // Edit tool: paired-line diff with gutters for old and new line numbers.
    const max = Math.max(oldLines.length, newLines.length);
    let oldN = 1;
    let newN = 1;
    for (let i = 0; i < max; i++) {
      const o = oldLines[i];
      const n = newLines[i];
      if (o === n) {
        if (o !== undefined) body.appendChild(diffLine(" ", o, "", oldN, newN));
        if (o !== undefined) { oldN++; newN++; }
      } else {
        if (o !== undefined) {
          body.appendChild(diffLine("-", o, "del", oldN, null));
          oldN++;
        }
        if (n !== undefined) {
          body.appendChild(diffLine("+", n, "add", null, newN));
          newN++;
        }
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

function diffLine(prefix, text, kind, oldN, newN) {
  const el = document.createElement("div");
  el.className = "diff-line" + (kind ? ` ${kind}` : "");
  const gOld = document.createElement("span");
  gOld.className = "diff-gutter";
  gOld.textContent = oldN ?? "";
  const gNew = document.createElement("span");
  gNew.className = "diff-gutter";
  gNew.textContent = newN ?? "";
  const mark = document.createElement("span");
  mark.className = "diff-mark";
  mark.textContent = prefix;
  const code = document.createElement("span");
  code.className = "diff-code";
  code.textContent = text;
  el.append(gOld, gNew, mark, code);
  return el;
}

function diffStats(diff) {
  if (diff.oldText == null) {
    const lines = (diff.newText ?? "").split("\n");
    // Trailing empty line from split shouldn't count.
    const adds = lines.length - (lines[lines.length - 1] === "" ? 1 : 0);
    return { adds: Math.max(adds, 0), dels: 0 };
  }
  const oldLines = diff.oldText.split("\n");
  const newLines = (diff.newText ?? "").split("\n");
  const max = Math.max(oldLines.length, newLines.length);
  let adds = 0;
  let dels = 0;
  for (let i = 0; i < max; i++) {
    const o = oldLines[i];
    const n = newLines[i];
    if (o === n) continue;
    if (o !== undefined) dels++;
    if (n !== undefined) adds++;
  }
  return { adds, dels };
}
