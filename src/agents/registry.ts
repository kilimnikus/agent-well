// Agent registry, mirroring the agents that agent-shell supports.
// Each entry declares how to spawn its ACP wrapper as a subprocess. Users may
// override `command`/`args`/`env` via ~/.agent-well/config.json (see config.ts).

export interface AgentDefinition {
  id: string;
  name: string;
  description: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
  // Hint shown in the UI when the binary cannot be found.
  installHint: string;
}

export const BUILTIN_AGENTS: AgentDefinition[] = [
  {
    id: "claude",
    name: "Claude Agent",
    description: "Anthropic Claude via claude-agent-acp",
    command: "claude-agent-acp",
    args: [],
    installHint: "npm install -g @agentclientprotocol/claude-agent-acp",
  },
  {
    id: "codex",
    name: "OpenAI Codex",
    description: "OpenAI codex-acp",
    command: "codex-acp",
    args: [],
    installHint: "See https://github.com/zed-industries/codex-acp",
  },
  {
    id: "gemini",
    name: "Gemini CLI",
    description: "Google Gemini via gemini-cli",
    command: "gemini",
    args: ["--experimental-acp"],
    installHint: "npm install -g @google/gemini-cli",
  },
  {
    id: "qwen",
    name: "Qwen Code",
    description: "Qwen Code ACP",
    command: "qwen",
    args: ["--experimental-acp"],
    installHint: "See https://github.com/QwenLM/qwen-code",
  },
  {
    id: "goose",
    name: "Goose",
    description: "Block's Goose via ACP",
    command: "goose",
    args: ["acp"],
    installHint: "See https://block.github.io/goose/",
  },
  {
    id: "auggie",
    name: "Auggie",
    description: "Augment Auggie via ACP",
    command: "auggie",
    args: ["--acp"],
    installHint: "See https://www.augmentcode.com/",
  },
  {
    id: "mistral-vibe",
    name: "Mistral Vibe",
    description: "Mistral Vibe via ACP",
    command: "vibe",
    args: ["acp"],
    installHint: "See Mistral Vibe docs",
  },
  {
    id: "cursor",
    name: "Cursor",
    description: "Cursor Agent via ACP",
    command: "cursor-agent",
    args: ["--acp"],
    installHint: "See https://www.cursor.com/",
  },
  {
    id: "factory-droid",
    name: "Factory Droid",
    description: "Factory droid / Kiro CLI",
    command: "droid",
    args: ["acp"],
    installHint: "See https://factory.ai/",
  },
  {
    id: "pi",
    name: "Pi coding agent",
    description: "Pi coding agent",
    command: "pi",
    args: ["acp"],
    installHint: "See Pi coding agent docs",
  },
];

export function findAgent(id: string): AgentDefinition | undefined {
  return BUILTIN_AGENTS.find((a) => a.id === id);
}
