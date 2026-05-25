import { TranscriptView } from "./chat.js";

// ---- DOM refs --------------------------------------------------------------
const $ = (id) => document.getElementById(id);
const sidebar = {
  el: $("sidebar"),
  list: $("session-list"),
  newBtn: $("new-session-btn"),
  closeBtn: $("close-sidebar-btn"),
  status: $("connection-status"),
};
const view = {
  empty: $("empty-state"),
  session: $("session-view"),
  agentBadge: $("session-agent"),
  cwd: $("session-cwd"),
  transcript: $("transcript"),
  composer: $("composer"),
  input: $("prompt-input"),
  sendBtn: $("send-btn"),
  cancelBtn: $("cancel-btn"),
  closeBtn: $("close-session-btn"),
  stopReason: $("stop-reason"),
};
const topbar = {
  openBtn: $("open-sidebar-btn"),
  newBtn: $("topbar-new-btn"),
  title: $("topbar-title"),
};
const backdrop = $("backdrop");

// --- Drawer (mobile sidebar) ---
const DESKTOP = "(min-width: 720px)";
const isDesktop = () => window.matchMedia(DESKTOP).matches;

function openSidebar() {
  document.body.classList.add("sidebar-open");
}
function closeSidebar() {
  document.body.classList.remove("sidebar-open");
}
topbar.openBtn.addEventListener("click", openSidebar);
sidebar.closeBtn.addEventListener("click", closeSidebar);
backdrop.addEventListener("click", closeSidebar);
topbar.newBtn.addEventListener("click", () => {
  closeSidebar();
  openNewSessionModal();
});
window.matchMedia(DESKTOP).addEventListener("change", closeSidebar);
const newModal = {
  root: $("new-session-modal"),
  agent: $("new-session-agent"),
  installHint: $("new-session-install-hint"),
  cwd: $("new-session-cwd"),
  cancel: $("new-session-cancel"),
  start: $("new-session-start"),
};
const permModal = {
  root: $("permission-modal"),
  tool: $("permission-tool"),
  options: $("permission-options"),
};
const authModal = {
  root: $("auth-modal"),
  options: $("auth-options"),
  skip: $("auth-skip"),
};

// ---- state -----------------------------------------------------------------
const state = {
  clientId: null,
  /** Last event seq received from the server. Sent back as `?since=` on polls. */
  since: 0,
  /** Set true once we've successfully connected at least once. */
  connected: false,
  agents: [],
  defaultCwd: "~",
  /** sessionId -> { id, agentId, cwd, transcript: TranscriptView, busy: bool } */
  sessions: new Map(),
  /** Listed (persisted) sessions: { id, agentId, cwd, title, lastActiveAt } */
  listedSessions: [],
  activeId: null,
  /** Pending new-session creation: clientSessionId -> { agentId, cwd } */
  pendingNew: new Map(),
  /** Active permission request: { sessionId, requestId } */
  pendingPermission: null,
};

// ---- Long-poll transport ---------------------------------------------------

const RECONNECT_BACKOFF_MS = [500, 1000, 2000, 4000, 8000];

/** Active poll AbortController so wake events (visibilitychange, online) can
 *  cancel a stale long-poll on iOS, where suspended fetches don't resume. */
let pollAbort = null;
/** When sleeping in backoff, this resolver wakes the loop early. */
let backoffWake = null;

async function connect() {
  // Persist clientId per tab so a refresh tries to reattach to the same
  // bridge if it's still around (within the server's idle window).
  state.clientId = sessionStorage.getItem("agent-well-client-id");
  if (!state.clientId) {
    const conn = await postJson("/api/connect", null);
    state.clientId = conn.clientId;
    sessionStorage.setItem("agent-well-client-id", state.clientId);
    state.since = 0;
  }
  sidebar.status.textContent = "connected";
  state.connected = true;
  pollLoop();
}

async function pollLoop() {
  let attempt = 0;
  while (true) {
    try {
      pollAbort = new AbortController();
      const res = await fetch(
        `/api/events?since=${state.since}`,
        { headers: { "X-Client-Id": state.clientId }, signal: pollAbort.signal },
      );
      if (res.status === 410) {
        // Server forgot the transport bridge. The session-host registry is
        // separate, so agents may still be running — but our in-memory live
        // session map is now stale (it referenced the dead bridge). Drop it
        // and let `ready` repopulate the sidebar; auto-reattach kicks in for
        // the previously active session.
        sessionStorage.removeItem("agent-well-client-id");
        state.clientId = null;
        state.since = 0;
        resetForReconnect();
        await connect();
        return;
      }
      if (!res.ok) throw new Error(`events: ${res.status}`);
      const data = await res.json();
      state.since = data.next ?? state.since;
      attempt = 0;
      sidebar.status.textContent = "connected";
      for (const ev of data.events ?? []) onServerMessage(ev);
    } catch (err) {
      if (err?.name === "AbortError") {
        // Woken by visibility/online: retry immediately without backoff.
        attempt = 0;
        continue;
      }
      attempt += 1;
      sidebar.status.textContent =
        attempt > 1 ? `reconnecting… (${attempt})` : "reconnecting…";
      const wait = RECONNECT_BACKOFF_MS[
        Math.min(attempt - 1, RECONNECT_BACKOFF_MS.length - 1)
      ];
      await new Promise((r) => {
        const t = setTimeout(() => {
          backoffWake = null;
          r();
        }, wait);
        backoffWake = () => {
          clearTimeout(t);
          backoffWake = null;
          r();
        };
      });
    }
  }
}

/** Cancel any in-flight long-poll and wake any backoff sleep. */
function wakePoll() {
  pollAbort?.abort();
  backoffWake?.();
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") wakePoll();
});
window.addEventListener("online", wakePoll);
window.addEventListener("pageshow", (e) => {
  // iOS bfcache restore: the page resumes without re-running scripts. Force a
  // poll so we surface the real connection state immediately.
  if (e.persisted) wakePoll();
});

/** Drop live-session state after the transport bridge was lost. Sidebar list
 *  refreshes from the next `ready` event; the auto-reattach there resumes the
 *  previously active session if it's still running on the server. */
function resetForReconnect() {
  state.sessions.clear();
  state.activeId = null;
  state.pendingNew.clear();
  state.pendingPermission = null;
  permModal.root.classList.add("hidden");
  authModal.root.classList.add("hidden");
  view.empty.classList.remove("hidden");
  view.session.classList.add("hidden");
  topbar.title.textContent = "agent-well";
  view.transcript.replaceChildren();
  view.stopReason.textContent = "";
}

function send(msg) {
  if (!state.clientId) return;
  // Fire-and-forget; results land via the poll stream.
  postJson("/api/command", msg).catch((err) => {
    console.error("send failed", msg.type, err);
  });
}

async function postJson(path, body) {
  const res = await fetch(path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(state.clientId ? { "X-Client-Id": state.clientId } : {}),
    },
    body: body == null ? "" : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return res.json();
}

// Best-effort cleanup on tab close so the server can release the bridge
// immediately rather than waiting for the idle timeout.
window.addEventListener("pagehide", () => {
  if (!state.clientId) return;
  const blob = new Blob([JSON.stringify({})], { type: "application/json" });
  // sendBeacon doesn't let us set custom headers, so we include clientId in
  // the query string for this path.
  navigator.sendBeacon(
    `/api/disconnect?clientId=${encodeURIComponent(state.clientId)}`,
    blob,
  );
});

// ---- inbound dispatch ------------------------------------------------------

function onServerMessage(msg) {
  switch (msg.type) {
    case "ready":
      state.agents = msg.agents;
      state.defaultCwd = msg.defaultCwd ?? state.defaultCwd;
      state.listedSessions = msg.sessions ?? [];
      populateAgents();
      renderSessionList();
      autoReattach();
      break;
    case "sessions":
      state.listedSessions = msg.sessions ?? [];
      renderSessionList();
      break;
    case "session_created":
      onSessionCreated(msg);
      break;
    case "session_loaded":
      onSessionLoaded(msg);
      break;
    case "session_busy":
      onSessionBusy(msg);
      break;
    case "session_update":
      onSessionUpdate(msg);
      break;
    case "prompt_complete":
      onPromptComplete(msg);
      break;
    case "prompt_error":
      onPromptError(msg);
      break;
    case "permission_request":
      showPermissionRequest(msg);
      break;
    case "session_closed":
      onSessionClosed(msg);
      break;
    case "session_deleted":
      onSessionDeleted(msg);
      break;
    case "authenticated":
      hideAuthModal();
      break;
    case "error":
      handleError(msg);
      break;
  }
}

function handleError(msg) {
  console.error("[server error]", msg);
  if (msg.context === "new_session") {
    state.pendingNew.clear();
  }
  alert(msg.message ?? "Server error");
}

// ---- session list ----------------------------------------------------------

function renderSessionList() {
  sidebar.list.replaceChildren();
  // Show active live sessions first, then persisted ones not yet active.
  const seen = new Set();
  for (const s of state.sessions.values()) {
    seen.add(s.id);
    sidebar.list.appendChild(sessionListItem({
      id: s.id,
      agentId: s.agentId,
      cwd: s.cwd,
      title: s.title ?? "(active)",
      live: true,
    }));
  }
  for (const s of state.listedSessions) {
    if (seen.has(s.id)) continue;
    sidebar.list.appendChild(sessionListItem({ ...s, live: false }));
  }
}

function sessionListItem(s) {
  const li = document.createElement("li");
  if (s.id === state.activeId) li.classList.add("active");
  const meta = document.createElement("div");
  meta.className = "session-meta";
  const title = document.createElement("div");
  title.className = "session-title-line";
  title.textContent = s.title ?? "(untitled)";
  const sub = document.createElement("div");
  sub.className = "session-sub";
  const agent = state.agents.find((a) => a.id === s.agentId);
  sub.textContent = `${agent?.name ?? s.agentId} · ${shortenPath(s.cwd)}`;
  meta.appendChild(title);
  meta.appendChild(sub);
  li.appendChild(meta);
  li.addEventListener("click", () => activateSession(s));
  return li;
}

function shortenPath(p) {
  if (!p) return "";
  return p.length > 40 ? "…" + p.slice(p.length - 40) : p;
}

function activateSession(s) {
  const existing = state.sessions.get(s.id);
  if (existing && !existing.readOnly) {
    setActive(s.id);
    return;
  }
  // No live attachment yet, or attached read-only because the session was
  // busy elsewhere — try (or retry) to resume.
  if (existing?.readOnly) state.sessions.delete(s.id);
  send({ type: "load_session", sessionId: s.id, agentId: s.agentId, cwd: s.cwd });
}

function setActive(id) {
  state.activeId = id;
  if (id) sessionStorage.setItem("agent-well-active-session", id);
  else sessionStorage.removeItem("agent-well-active-session");
  const s = state.sessions.get(id);
  if (!s) {
    view.empty.classList.remove("hidden");
    view.session.classList.add("hidden");
    topbar.title.textContent = "agent-well";
    renderSessionList();
    return;
  }
  view.empty.classList.add("hidden");
  view.session.classList.remove("hidden");
  const agent = state.agents.find((a) => a.id === s.agentId);
  view.agentBadge.textContent = agent?.name ?? s.agentId;
  view.cwd.textContent = s.cwd;
  topbar.title.textContent = s.title ?? (agent?.name ?? "session");
  view.transcript.replaceChildren();
  s.transcript = new TranscriptView(view.transcript);
  // Replay buffered updates if we just attached.
  if (s.bufferedTranscript) {
    for (const entry of s.bufferedTranscript) {
      replayEntry(s, entry);
    }
    delete s.bufferedTranscript;
  }
  updateBusyChrome();
  renderSessionList();
  closeSidebar();
  // On desktop autofocus the input; on mobile let the user tap to summon the
  // keyboard so it doesn't immediately cover the transcript.
  if (isDesktop()) view.input.focus();
}

function replayEntry(s, entry) {
  if (entry.kind === "user_prompt") {
    s.transcript.appendUserPrompt(entry.content);
  } else if (entry.kind === "session_update") {
    s.transcript.applyUpdate(entry.update);
  } else if (entry.kind === "prompt_complete") {
    s.transcript.finishTurn();
  }
}

// ---- new session -----------------------------------------------------------

function populateAgents() {
  newModal.agent.replaceChildren();
  for (const a of state.agents) {
    const opt = document.createElement("option");
    opt.value = a.id;
    opt.textContent = a.name;
    newModal.agent.appendChild(opt);
  }
  updateInstallHint();
  newModal.cwd.value = state.defaultCwd;
}

function updateInstallHint() {
  const a = state.agents.find((a) => a.id === newModal.agent.value);
  newModal.installHint.textContent = a
    ? `Requires: ${a.description}. Install: ${a.installHint}`
    : "";
}

function openNewSessionModal() {
  newModal.root.classList.remove("hidden");
  newModal.cwd.value = state.defaultCwd;
  // Avoid focusing the input on mobile to prevent the soft keyboard from
  // covering the modal before the user has read it.
  if (isDesktop()) newModal.cwd.focus();
}
sidebar.newBtn.addEventListener("click", () => {
  closeSidebar();
  openNewSessionModal();
});
newModal.cancel.addEventListener("click", () => {
  newModal.root.classList.add("hidden");
});
newModal.agent.addEventListener("change", updateInstallHint);
newModal.start.addEventListener("click", () => {
  const agentId = newModal.agent.value;
  const cwd = newModal.cwd.value.trim() || state.defaultCwd;
  const clientSessionId = crypto.randomUUID();
  state.pendingNew.set(clientSessionId, { agentId, cwd });
  send({ type: "new_session", agentId, cwd, mcpServers: [], clientSessionId });
  newModal.root.classList.add("hidden");
});

function onSessionCreated(msg) {
  state.pendingNew.delete(msg.clientSessionId);
  const session = {
    id: msg.sessionId,
    agentId: msg.agentId,
    cwd: msg.cwd,
    title: undefined,
    busy: false,
    modes: msg.modes,
    authMethods: msg.authMethods ?? [],
  };
  state.sessions.set(msg.sessionId, session);
  setActive(msg.sessionId);
  if (session.authMethods.length > 0) {
    showAuthModal(session);
  }
}

function onSessionLoaded(msg) {
  const session = {
    id: msg.sessionId,
    agentId: msg.agentId,
    cwd: msg.cwd,
    title: undefined,
    busy: !!msg.busy,
    bufferedTranscript: msg.transcript ?? [],
  };
  state.sessions.set(msg.sessionId, session);
  setActive(msg.sessionId);
  // If the agent was mid-prompt when we (re)attached, surface the waiting
  // chrome immediately so the user knows we're listening for the response.
  if (session.busy) {
    view.stopReason.textContent = "";
    updateBusyChrome();
  }
}

/** After a transport reconnect, if a session was active before and is still
 *  listed (i.e. exists on disk), automatically re-request `load_session` for
 *  it. The server-side host may still be live (agent still working) — in that
 *  case we just re-attach and the buffered transcript + busy flag put the UI
 *  back into the right state. */
function autoReattach() {
  const targetId = sessionStorage.getItem("agent-well-active-session");
  if (!targetId) return;
  if (state.sessions.has(targetId)) return; // already live in this tab
  const listed = state.listedSessions.find((s) => s.id === targetId);
  if (!listed) {
    sessionStorage.removeItem("agent-well-active-session");
    return;
  }
  send({
    type: "load_session",
    sessionId: listed.id,
    agentId: listed.agentId,
    cwd: listed.cwd,
  });
}

function onSessionBusy(msg) {
  const session = {
    id: msg.sessionId,
    agentId: msg.agentId,
    cwd: msg.cwd,
    title: undefined,
    busy: false,
    readOnly: true,
    bufferedTranscript: msg.transcript ?? [],
  };
  state.sessions.set(msg.sessionId, session);
  setActive(msg.sessionId);
}

// ---- composer --------------------------------------------------------------

view.composer.addEventListener("submit", (e) => {
  e.preventDefault();
  submitPrompt();
});
view.input.addEventListener("keydown", (e) => {
  // Desktop: Cmd/Ctrl+Enter sends; bare Enter inserts newline.
  // Mobile (touch + no physical keyboard): bare Enter inserts newline too —
  // users send with the Send button. We can't reliably detect "no physical
  // keyboard," so we keep the desktop convention and provide a prominent
  // Send button for mobile.
  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
    e.preventDefault();
    submitPrompt();
  }
});
view.input.addEventListener("input", autoGrow);
function autoGrow() {
  view.input.style.height = "auto";
  const max = Math.floor(window.innerHeight * 0.4);
  view.input.style.height = Math.min(view.input.scrollHeight, max) + "px";
}

function submitPrompt() {
  const id = state.activeId;
  if (!id) return;
  const s = state.sessions.get(id);
  if (!s || s.busy || s.readOnly) return;
  const text = view.input.value.trim();
  if (!text) return;
  const prompt = [{ type: "text", text }];
  s.transcript.appendUserPrompt(prompt);
  s.transcript.finishTurn();
  if (!s.title) {
    s.title = text.slice(0, 80);
    topbar.title.textContent = s.title;
    renderSessionList();
  }
  view.input.value = "";
  autoGrow();
  view.stopReason.textContent = "";
  s.busy = true;
  updateBusyChrome();
  send({ type: "prompt", sessionId: id, prompt });
}

view.cancelBtn.addEventListener("click", () => {
  const id = state.activeId;
  if (!id) return;
  send({ type: "cancel", sessionId: id });
});

view.closeBtn.addEventListener("click", () => {
  const id = state.activeId;
  if (!id) return;
  const s = state.sessions.get(id);
  if (s?.readOnly) {
    // Server doesn't own this session in our connection — just detach locally.
    state.sessions.delete(id);
    setActive(null);
    return;
  }
  send({ type: "close_session", sessionId: id });
});

function updateBusyChrome() {
  const s = state.sessions.get(state.activeId);
  if (!s) return;
  const locked = s.busy || s.readOnly;
  view.sendBtn.disabled = locked;
  view.input.disabled = !!s.readOnly;
  view.cancelBtn.classList.toggle("hidden", !s.busy);
  if (s.readOnly) {
    view.stopReason.textContent =
      "open in another tab — click again in the sidebar to take over";
  }
}

function onSessionUpdate(msg) {
  const s = state.sessions.get(msg.sessionId);
  if (!s) return;
  if (s.id === state.activeId && s.transcript) {
    s.transcript.applyUpdate(msg.update);
  } else {
    s.bufferedTranscript = s.bufferedTranscript ?? [];
    s.bufferedTranscript.push({
      kind: "session_update",
      at: new Date().toISOString(),
      update: msg.update,
    });
  }
}

function onPromptComplete(msg) {
  const s = state.sessions.get(msg.sessionId);
  if (!s) return;
  s.busy = false;
  if (s.id === state.activeId) {
    s.transcript.finishTurn();
    view.stopReason.textContent =
      msg.stopReason && msg.stopReason !== "end_turn"
        ? `stopped: ${msg.stopReason}`
        : "";
    updateBusyChrome();
  }
}

function onPromptError(msg) {
  const s = state.sessions.get(msg.sessionId);
  if (!s) return;
  s.busy = false;
  if (s.id === state.activeId) {
    view.stopReason.textContent = `error: ${msg.message}`;
    updateBusyChrome();
  }
}

// ---- permission ------------------------------------------------------------

function showPermissionRequest(msg) {
  state.pendingPermission = { sessionId: msg.sessionId, requestId: msg.requestId };
  permModal.tool.replaceChildren();
  const title = document.createElement("div");
  title.style.marginBottom = "8px";
  title.innerHTML = `<strong>${escapeHtml(msg.toolCall?.title ?? "Tool call")}</strong>
    <span class="tool-kind" style="margin-left:6px">${escapeHtml(msg.toolCall?.kind ?? "tool")}</span>`;
  permModal.tool.appendChild(title);
  if (msg.toolCall?.locations?.length) {
    const loc = document.createElement("div");
    loc.className = "tool-locations";
    loc.textContent = msg.toolCall.locations
      .map((l) => (l.line != null ? `${l.path}:${l.line}` : l.path))
      .join("  ·  ");
    permModal.tool.appendChild(loc);
  }
  permModal.options.replaceChildren();
  for (const opt of msg.options ?? []) {
    const btn = document.createElement("button");
    btn.className = "permission-option";
    btn.innerHTML = `<span>${escapeHtml(opt.name)}</span><span class="kind">${escapeHtml(opt.kind)}</span>`;
    btn.addEventListener("click", () => {
      send({
        type: "permission_response",
        sessionId: msg.sessionId,
        requestId: msg.requestId,
        outcome: "selected",
        optionId: opt.optionId,
      });
      hidePermissionModal();
    });
    permModal.options.appendChild(btn);
  }
  const cancel = document.createElement("button");
  cancel.className = "ghost";
  cancel.textContent = "Cancel";
  cancel.addEventListener("click", () => {
    send({
      type: "permission_response",
      sessionId: msg.sessionId,
      requestId: msg.requestId,
      outcome: "cancelled",
    });
    hidePermissionModal();
  });
  permModal.options.appendChild(cancel);
  permModal.root.classList.remove("hidden");
}

function hidePermissionModal() {
  permModal.root.classList.add("hidden");
  state.pendingPermission = null;
}

// ---- auth ------------------------------------------------------------------

function showAuthModal(session) {
  authModal.options.replaceChildren();
  for (const m of session.authMethods) {
    const btn = document.createElement("button");
    btn.textContent = m.name + (m.description ? ` — ${m.description}` : "");
    btn.addEventListener("click", () => {
      send({ type: "authenticate", sessionId: session.id, methodId: m.id });
    });
    authModal.options.appendChild(btn);
  }
  authModal.root.classList.remove("hidden");
}
function hideAuthModal() {
  authModal.root.classList.add("hidden");
}
authModal.skip.addEventListener("click", hideAuthModal);

// ---- close/delete ----------------------------------------------------------

function onSessionClosed(msg) {
  state.sessions.delete(msg.sessionId);
  if (state.activeId === msg.sessionId) {
    setActive(null);
  }
  renderSessionList();
}

function onSessionDeleted(msg) {
  state.listedSessions = state.listedSessions.filter((s) => s.id !== msg.sessionId);
  state.sessions.delete(msg.sessionId);
  if (state.activeId === msg.sessionId) {
    setActive(null);
  }
  renderSessionList();
}

function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

connect();

// ---- sysstat (CPU / memory) -----------------------------------------------

const SYSSTAT_INTERVAL_MS = 2000;
const sysstatTargets = [
  document.getElementById("sysstat-topbar"),
  document.getElementById("sysstat-sidebar"),
].filter(Boolean);

function formatBytes(n) {
  const gb = n / (1024 ** 3);
  if (gb >= 1) return gb.toFixed(1) + "G";
  const mb = n / (1024 ** 2);
  return Math.round(mb) + "M";
}

async function pollSysStat() {
  try {
    const res = await fetch("/api/sysstat");
    if (!res.ok) throw new Error(`sysstat ${res.status}`);
    const data = await res.json();
    const cpuText = `CPU ${data.cpu}%`;
    const memText = `MEM ${data.mem.percent}% (${formatBytes(data.mem.used)}/${formatBytes(data.mem.total)})`;
    for (const el of sysstatTargets) {
      el.querySelector(".sysstat-cpu").textContent = cpuText;
      el.querySelector(".sysstat-mem").textContent = memText;
    }
  } catch {
    // next tick will retry
  }
}

pollSysStat();
setInterval(pollSysStat, SYSSTAT_INTERVAL_MS);
