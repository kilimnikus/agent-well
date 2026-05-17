// Minimal ACP type surface used by this server. See https://agentclientprotocol.com
// for the full spec. We model only what the bridge and UI need; unknown fields are
// preserved opaquely.

export type ProtocolVersion = number;

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcResponse | JsonRpcNotification;

// ---- Initialize ----------------------------------------------------------

export interface ClientCapabilities {
  fs?: { readTextFile?: boolean; writeTextFile?: boolean };
  terminal?: boolean;
}

export interface InitializeParams {
  protocolVersion: ProtocolVersion;
  clientCapabilities: ClientCapabilities;
}

export interface InitializeResult {
  protocolVersion: ProtocolVersion;
  agentCapabilities?: {
    loadSession?: boolean;
    promptCapabilities?: {
      image?: boolean;
      audio?: boolean;
      embeddedContext?: boolean;
    };
    mcpCapabilities?: { http?: boolean; sse?: boolean };
  };
  authMethods?: { id: string; name: string; description?: string }[];
}

// ---- Authenticate --------------------------------------------------------

export interface AuthenticateParams {
  methodId: string;
}

// ---- Sessions ------------------------------------------------------------

export interface McpServer {
  name: string;
  command: string;
  args: string[];
  env?: { name: string; value: string }[];
}

export interface NewSessionParams {
  cwd: string;
  mcpServers: McpServer[];
}

export interface NewSessionResult {
  sessionId: string;
  modes?: { currentModeId: string; availableModes: SessionMode[] };
}

export interface SessionMode {
  id: string;
  name: string;
  description?: string;
}

export interface LoadSessionParams {
  sessionId: string;
  cwd: string;
  mcpServers: McpServer[];
}

// ---- Content blocks ------------------------------------------------------

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; mimeType: string; data: string } // base64
  | { type: "audio"; mimeType: string; data: string }
  | { type: "resource"; resource: { uri: string; text?: string; mimeType?: string } }
  | { type: "resource_link"; uri: string; name?: string; mimeType?: string };

export interface PromptParams {
  sessionId: string;
  prompt: ContentBlock[];
}

export type StopReason =
  | "end_turn"
  | "max_tokens"
  | "max_turn_requests"
  | "refusal"
  | "cancelled";

export interface PromptResult {
  stopReason: StopReason;
}

// ---- session/update notification ----------------------------------------

export type SessionUpdate =
  | { sessionUpdate: "user_message_chunk"; content: ContentBlock }
  | { sessionUpdate: "agent_message_chunk"; content: ContentBlock }
  | { sessionUpdate: "agent_thought_chunk"; content: ContentBlock }
  | {
      sessionUpdate: "tool_call";
      toolCallId: string;
      title?: string;
      kind?: ToolKind;
      status?: ToolCallStatus;
      content?: ToolCallContent[];
      locations?: { path: string; line?: number }[];
      rawInput?: unknown;
      rawOutput?: unknown;
    }
  | {
      sessionUpdate: "tool_call_update";
      toolCallId: string;
      title?: string;
      kind?: ToolKind;
      status?: ToolCallStatus;
      content?: ToolCallContent[];
      locations?: { path: string; line?: number }[];
      rawInput?: unknown;
      rawOutput?: unknown;
    }
  | { sessionUpdate: "plan"; entries: PlanEntry[] }
  | { sessionUpdate: "available_commands_update"; availableCommands: SlashCommand[] }
  | { sessionUpdate: "current_mode_update"; currentModeId: string };

export type ToolKind =
  | "read"
  | "edit"
  | "delete"
  | "move"
  | "search"
  | "execute"
  | "think"
  | "fetch"
  | "other";

export type ToolCallStatus = "pending" | "in_progress" | "completed" | "failed";

export type ToolCallContent =
  | { type: "content"; content: ContentBlock }
  | { type: "diff"; path: string; oldText?: string | null; newText: string }
  | { type: "terminal"; terminalId: string };

export interface PlanEntry {
  content: string;
  priority?: "high" | "medium" | "low";
  status?: "pending" | "in_progress" | "completed";
}

export interface SlashCommand {
  name: string;
  description?: string;
  input?: { hint?: string };
}

export interface SessionNotification {
  sessionId: string;
  update: SessionUpdate;
}

// ---- Permission ----------------------------------------------------------

export interface PermissionOption {
  optionId: string;
  name: string;
  kind: "allow_once" | "allow_always" | "reject_once" | "reject_always";
}

export interface RequestPermissionParams {
  sessionId: string;
  toolCall: {
    toolCallId: string;
    title?: string;
    kind?: ToolKind;
    content?: ToolCallContent[];
    locations?: { path: string; line?: number }[];
  };
  options: PermissionOption[];
}

export interface RequestPermissionResult {
  outcome:
    | { outcome: "cancelled" }
    | { outcome: "selected"; optionId: string };
}

// ---- Filesystem reverse calls -------------------------------------------

export interface ReadTextFileParams {
  sessionId: string;
  path: string;
  line?: number;
  limit?: number;
}
export interface ReadTextFileResult {
  content: string;
}

export interface WriteTextFileParams {
  sessionId: string;
  path: string;
  content: string;
}

// ---- Terminal reverse calls ---------------------------------------------

export interface TerminalCreateParams {
  sessionId: string;
  command: string;
  args?: string[];
  env?: { name: string; value: string }[];
  cwd?: string;
  outputByteLimit?: number;
}
export interface TerminalCreateResult {
  terminalId: string;
}

export interface TerminalOutputParams {
  sessionId: string;
  terminalId: string;
}
export interface TerminalOutputResult {
  output: string;
  truncated: boolean;
  exitStatus?: { exitCode: number | null; signal: string | null };
}

export interface TerminalWaitParams {
  sessionId: string;
  terminalId: string;
}
export interface TerminalWaitResult {
  exitCode: number | null;
  signal: string | null;
}

export interface TerminalKillParams {
  sessionId: string;
  terminalId: string;
}

export interface TerminalReleaseParams {
  sessionId: string;
  terminalId: string;
}

// ---- Cancel notification -------------------------------------------------

export interface CancelParams {
  sessionId: string;
}
