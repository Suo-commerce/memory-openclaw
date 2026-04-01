// Generation Timestamp: 2026-04-01T13:15:00Z
// Location: integrations/openclaw/index.ts
//
// Astral Core Memory — OpenClaw Plugin Entry Point
// Version: 1.1.0
//
// This is the main entry point for the @astralcore/memory-openclaw plugin.
// It registers lifecycle hooks (auto-recall, auto-capture) and agent tools
// (astral_recall, astral_store, astral_forget, astral_stats, astral_sync)
// with the OpenClaw Gateway.
//
// Architecture: Thin TypeScript bridge → Astral Core Memory Server (:8090)
// The memory engine runs as a local server. This plugin handles OpenClaw
// integration only.
//
// Requires: OpenClaw >= 2026.3.22 (before_prompt_build hook support)
// Requires: Astral Core Memory API Server running on configured port
//
// Hook lifecycle:
//   before_prompt_build → fetch relevant memories → inject into system prompt
//   agent_end           → extract conversation → feed to surprise-gated pipeline
//
// Compatible with: plugins.slots.memory = "memory-astral-core"
//
// Changelog v1.1.0 (2026-04-01, tested on OpenClaw 2026.3.31):
//   - Fix: capture uses /v1/memory/ingest/batch (multi-turn endpoint),
//     not /v1/memory/ingest (single-turn). Fixes 400 errors on auto-capture.
//   - Fix: OpenClaw sends message.content as array of content blocks
//     (e.g. [{type:"text", text:"..."}]), not plain strings. Both hooks
//     and the store tool now flatten content before sending to the API.
//   - Fix: removed api.registerCommand() — not available on all OpenClaw
//     builds. Caused "Cannot read properties of undefined (reading 'trim')"
//     crash during plugin registration.
//   - Fix: augmented-prompt messages are flattened to plain strings before
//     sending, fixing "'list' object has no attribute 'strip'" server warning.

import { Type, type Static } from "@sinclair/typebox";
import {
  definePluginEntry,
  type OpenClawPluginApi,
} from "openclaw/plugin-sdk/core";

// ============================================================================
// Helpers
// ============================================================================

/**
 * Flatten OpenClaw message content to a plain string.
 * OpenClaw may send content as a string OR as an array of content blocks
 * (e.g. [{type: "text", text: "Hello"}, {type: "tool_use", ...}]).
 * The memory server expects plain strings.
 */
function flattenContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block: any) => block.text ?? block.content ?? "")
      .filter(Boolean)
      .join("\n");
  }
  return String(content ?? "");
}

// ============================================================================
// Configuration Schema
// ============================================================================

const AstralCoreConfigSchema = Type.Object({
  serverUrl: Type.String({
    default: "http://localhost:8090",
    description: "Astral Core Memory API server URL",
  }),
  autoCapture: Type.Boolean({
    default: true,
    description: "Automatically capture memories from conversations",
  }),
  autoRecall: Type.Boolean({
    default: true,
    description: "Automatically inject relevant memories into prompts",
  }),
  maxRecallMemories: Type.Number({
    default: 5,
    description: "Maximum memories to inject per prompt (1-20)",
    minimum: 1,
    maximum: 20,
  }),
  captureMinMessages: Type.Number({
    default: 2,
    description: "Minimum messages in turn before attempting capture",
    minimum: 1,
  }),
  captureMaxChars: Type.Number({
    default: 8000,
    description: "Maximum characters to send for capture per turn",
  }),
  fortressUrl: Type.Optional(
    Type.String({
      default: "",
      description: "Orbital Fortress URL for fleet sync (leave empty to disable)",
    })
  ),
  healthCheckOnStart: Type.Boolean({
    default: true,
    description: "Check memory server health on plugin startup",
  }),
});

type AstralCoreConfig = Static<typeof AstralCoreConfigSchema>;

// ============================================================================
// HTTP Client — talks to Astral Core Memory Server
// ============================================================================

class AstralCoreClient {
  private baseUrl: string;
  private healthy: boolean = false;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  // --- Health ---------------------------------------------------------------

  async checkHealth(): Promise<{
    ok: boolean;
    version?: string;
    totalMemories?: number;
    embeddingBackend?: string;
    cognitiveShell?: boolean;
  }> {
    try {
      const resp = await fetch(`${this.baseUrl}/health`, {
        signal: AbortSignal.timeout(5000),
      });
      if (!resp.ok) return { ok: false };
      const data = await resp.json();
      this.healthy = data.status === "ok";
      return {
        ok: this.healthy,
        version: data.version,
        totalMemories: data.total_memories,
        embeddingBackend: data.embedding_backend,
        cognitiveShell: data.cognitive_shell,
      };
    } catch {
      this.healthy = false;
      return { ok: false };
    }
  }

  get isHealthy(): boolean {
    return this.healthy;
  }

  // --- Memory Recall (search) -----------------------------------------------

  async recall(
    query: string,
    limit: number = 5,
    minSimilarity: number = 0.3,
    source?: string
  ): Promise<{
    results: Array<{
      id: string;
      text: string;
      similarity: number;
      speed: string;
      category: string;
      source: string;
      surprise_score: number;
      utility_score: number;
      access_count: number;
    }>;
    count: number;
    totalMemories: number;
  }> {
    const body: Record<string, unknown> = {
      query,
      limit,
      min_similarity: minSimilarity,
    };
    if (source) body.source = source;

    const resp = await fetch(`${this.baseUrl}/v1/memory/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    });
    if (!resp.ok) throw new Error(`Recall failed: ${resp.status}`);
    const data = await resp.json();
    return {
      results: data.results ?? [],
      count: data.count ?? 0,
      totalMemories: data.total_memories ?? 0,
    };
  }

  // --- Augmented Prompt (auto-recall context block) -------------------------

  async getAugmentedPrompt(
    query: string,
    messages: Array<{ role: string; content: unknown }>,
    maxMemories: number = 5
  ): Promise<{ contextBlock: string; memoriesInjected: number }> {
    // Flatten message content to plain strings for the Python server
    const flatMessages = messages.map((m) => ({
      role: m.role,
      content: flattenContent(m.content),
    }));

    const resp = await fetch(
      `${this.baseUrl}/v1/memory/augmented-prompt`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query,
          messages: flatMessages,
          max_memories: maxMemories,
        }),
        signal: AbortSignal.timeout(10000),
      }
    );
    if (!resp.ok) throw new Error(`Augmented prompt failed: ${resp.status}`);
    const data = await resp.json();
    return {
      contextBlock: data.context_block ?? "",
      memoriesInjected: data.memories_injected ?? 0,
    };
  }

  // --- Memory Capture (ingest/batch) ----------------------------------------

  async capture(
    turns: Array<{
      user_message: string;
      assistant_response: string;
    }>,
    source: string
  ): Promise<{ stored: number; skipped: number }> {
    // Uses /ingest/batch (multi-turn endpoint), not /ingest (single-turn)
    const resp = await fetch(`${this.baseUrl}/v1/memory/ingest/batch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ turns, source }),
      signal: AbortSignal.timeout(15000),
    });
    if (!resp.ok) throw new Error(`Capture failed: ${resp.status}`);
    const data = await resp.json();
    return {
      stored: data.stored ?? 0,
      skipped: data.skipped ?? 0,
    };
  }

  // --- Manual Store ---------------------------------------------------------

  async store(
    text: string,
    category: string = "fact",
    source: string = "openclaw_manual"
  ): Promise<{ stored: number }> {
    // Single-turn ingest for explicit user-requested storage
    const resp = await fetch(`${this.baseUrl}/v1/memory/ingest`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        user_message: text,
        assistant_response: `Acknowledged: ${category}`,
        source,
      }),
      signal: AbortSignal.timeout(10000),
    });
    if (!resp.ok) throw new Error(`Store failed: ${resp.status}`);
    const data = await resp.json();
    return { stored: data.stored ?? 0 };
  }

  // --- Forget (delete by source) --------------------------------------------

  async forget(source: string): Promise<{ deleted: number }> {
    const resp = await fetch(
      `${this.baseUrl}/v1/memory/source/${encodeURIComponent(source)}`,
      {
        method: "DELETE",
        signal: AbortSignal.timeout(10000),
      }
    );
    if (!resp.ok) throw new Error(`Forget failed: ${resp.status}`);
    const data = await resp.json();
    return { deleted: data.deleted ?? 0 };
  }

  // --- Stats ----------------------------------------------------------------

  async stats(): Promise<Record<string, unknown>> {
    const resp = await fetch(`${this.baseUrl}/v1/memory/stats`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!resp.ok) throw new Error(`Stats failed: ${resp.status}`);
    return resp.json();
  }

  // --- Consolidate ----------------------------------------------------------

  async consolidate(
    level: string = "session"
  ): Promise<{ promoted: number; archived: number }> {
    const resp = await fetch(`${this.baseUrl}/v1/memory/consolidate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ level }),
      signal: AbortSignal.timeout(30000),
    });
    if (!resp.ok) throw new Error(`Consolidate failed: ${resp.status}`);
    const data = await resp.json();
    return {
      promoted: data.promoted ?? 0,
      archived: data.archived ?? 0,
    };
  }

  // --- Sync to Orbital Fortress ---------------------------------------------

  async sync(
    fortressUrl: string,
    maxBriefings: number = 10
  ): Promise<{
    recordsUploaded: number;
    briefingsReceived: number;
  }> {
    const resp = await fetch(`${this.baseUrl}/v1/sync/trigger`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        fortress_url: fortressUrl,
        max_briefing_records: maxBriefings,
      }),
      signal: AbortSignal.timeout(30000),
    });
    if (!resp.ok) throw new Error(`Sync failed: ${resp.status}`);
    const data = await resp.json();
    return {
      recordsUploaded: data.records_uploaded ?? 0,
      briefingsReceived: data.briefings_received ?? 0,
    };
  }
}

// ============================================================================
// Plugin Entry Point
// ============================================================================

export default definePluginEntry({
  id: "memory-astral-core",
  name: "Astral Core Memory",

  register(api: OpenClawPluginApi) {
    // --- Parse config -------------------------------------------------------
    const cfg: AstralCoreConfig = {
      serverUrl: "http://localhost:8090",
      autoCapture: true,
      autoRecall: true,
      maxRecallMemories: 5,
      captureMinMessages: 2,
      captureMaxChars: 8000,
      fortressUrl: "",
      healthCheckOnStart: true,
      ...(api.config ?? {}),
    };

    const client = new AstralCoreClient(cfg.serverUrl);

    api.logger.info(
      `[astral-core] Initialising — server: ${cfg.serverUrl}, ` +
        `autoRecall: ${cfg.autoRecall}, autoCapture: ${cfg.autoCapture}`
    );

    // --- Startup health check -----------------------------------------------
    if (cfg.healthCheckOnStart) {
      client.checkHealth().then((h) => {
        if (h.ok) {
          api.logger.info(
            `[astral-core] Memory server online — v${h.version}, ` +
              `${h.totalMemories} memories, backend: ${h.embeddingBackend}, ` +
              `cognitive_shell: ${h.cognitiveShell}`
          );
        } else {
          api.logger.warn(
            `[astral-core] Memory server not reachable at ${cfg.serverUrl}. ` +
              `Start it with: ./astral-memory-server`
          );
        }
      });
    }

    // ========================================================================
    // HOOK: before_prompt_build — Auto-Recall
    // ========================================================================
    // Fires before the agent's system prompt is assembled.
    // We fetch relevant memories and inject them as a context block.

    if (cfg.autoRecall) {
      api.on(
        "before_prompt_build",
        async (event: { messages?: Array<{ role: string; content: unknown }> }) => {
          if (!client.isHealthy) {
            // Attempt reconnect silently
            await client.checkHealth();
            if (!client.isHealthy) return;
          }

          try {
            // Extract the latest user message as the recall query
            const messages = event.messages ?? [];
            const lastUser = [...messages]
              .reverse()
              .find((m) => m.role === "user");

            if (!lastUser?.content) return;

            const query = flattenContent(lastUser.content);
            if (!query) return;

            const { contextBlock, memoriesInjected } =
              await client.getAugmentedPrompt(
                query,
                messages.slice(-10), // Last 10 messages for context
                cfg.maxRecallMemories
              );

            if (contextBlock && memoriesInjected > 0) {
              // Inject memories into the system prompt via the hook return
              return {
                systemPromptParts: [
                  {
                    text: contextBlock,
                    position: "before", // Inject before other system prompt parts
                    label: "astral-core-memories",
                  },
                ],
              };
            }
          } catch (err) {
            api.logger.warn(
              `[astral-core] Auto-recall failed: ${err instanceof Error ? err.message : String(err)}`
            );
          }
        },
        { name: "astral-core-auto-recall", priority: 10 }
      );
    }

    // ========================================================================
    // HOOK: agent_end — Auto-Capture
    // ========================================================================
    // Fires after the agent finishes a response.
    // We send the conversation turn through the surprise-gated pipeline.

    if (cfg.autoCapture) {
      api.on(
        "agent_end",
        async (event: {
          messages?: Array<{ role: string; content: unknown }>;
          sessionId?: string;
          agentId?: string;
        }) => {
          if (!client.isHealthy) return;

          try {
            const messages = event.messages ?? [];
            if (messages.length < cfg.captureMinMessages) return;

            // Extract the last user+assistant pair(s)
            const turns: Array<{
              user_message: string;
              assistant_response: string;
            }> = [];

            for (let i = messages.length - 1; i >= 0; i--) {
              if (
                messages[i].role === "assistant" &&
                i > 0 &&
                messages[i - 1].role === "user"
              ) {
                const userMsg = flattenContent(messages[i - 1].content).slice(
                  0,
                  cfg.captureMaxChars
                );
                const assistMsg = flattenContent(messages[i].content).slice(
                  0,
                  cfg.captureMaxChars
                );
                turns.unshift({
                  user_message: userMsg,
                  assistant_response: assistMsg,
                });
                i--; // Skip the user message we just consumed
                // Capture at most 3 turns per hook invocation
                if (turns.length >= 3) break;
              }
            }

            if (turns.length === 0) return;

            const source = `openclaw_${event.agentId ?? "default"}_${event.sessionId ?? "session"}`;

            const { stored, skipped } = await client.capture(turns, source);

            if (stored > 0) {
              api.logger.info(
                `[astral-core] Captured ${stored} memories (${skipped} filtered by surprise gate)`
              );
            }
          } catch (err) {
            api.logger.warn(
              `[astral-core] Auto-capture failed: ${err instanceof Error ? err.message : String(err)}`
            );
          }
        },
        { name: "astral-core-auto-capture", priority: 10 }
      );
    }

    // ========================================================================
    // TOOL: astral_recall — Semantic memory search
    // ========================================================================

    api.registerTool({
      name: "astral_recall",
      description:
        "Search long-term memory for relevant information. Use this when you need to " +
        "remember something from a previous conversation, recall user preferences, " +
        "find project context, or look up facts the user has shared before. " +
        "Returns semantically similar memories ranked by relevance.",
      parameters: Type.Object({
        query: Type.String({
          description: "What to search for in memory",
        }),
        limit: Type.Optional(
          Type.Number({
            description: "Max results to return (default: 5)",
            default: 5,
          })
        ),
        source: Type.Optional(
          Type.String({
            description: "Filter by source (e.g. 'openclaw_default_session')",
          })
        ),
      }),
      execute: async (params) => {
        const { results, count, totalMemories } = await client.recall(
          params.query,
          params.limit ?? 5,
          0.3,
          params.source
        );
        const formatted = results
          .map(
            (r, i) =>
              `[${i + 1}] (${(r.similarity * 100).toFixed(0)}% match, ${r.category}) ${r.text}`
          )
          .join("\n");
        return {
          content: formatted || "No matching memories found.",
          metadata: { count, totalMemories },
        };
      },
    });

    // ========================================================================
    // TOOL: astral_store — Manually store a memory
    // ========================================================================

    api.registerTool({
      name: "astral_store",
      description:
        "Explicitly store something important in long-term memory. Use this when " +
        "the user asks you to remember something specific, or when you identify " +
        "a critical fact, preference, or decision that should persist across sessions. " +
        "The memory goes through surprise-gated filtering — truly redundant " +
        "information may be automatically skipped.",
      parameters: Type.Object({
        text: Type.String({
          description: "The information to remember",
        }),
        category: Type.Optional(
          Type.String({
            description:
              "Category: fact, preference, decision, entity, event, pattern (default: fact)",
            default: "fact",
          })
        ),
      }),
      execute: async (params) => {
        const { stored } = await client.store(
          params.text,
          params.category ?? "fact",
          "openclaw_manual"
        );
        return {
          content:
            stored > 0
              ? `Stored in long-term memory: "${params.text.slice(0, 80)}${params.text.length > 80 ? "..." : ""}"`
              : "Memory was filtered by surprise gate (likely already known). Not stored.",
        };
      },
    });

    // ========================================================================
    // TOOL: astral_forget — Delete memories by source
    // ========================================================================

    api.registerTool({
      name: "astral_forget",
      description:
        "Delete all memories from a specific source. Use when the user wants to " +
        "clear memories from a particular session or context.",
      parameters: Type.Object({
        source: Type.String({
          description:
            "Source identifier to delete (e.g. 'openclaw_default_session')",
        }),
      }),
      execute: async (params) => {
        const { deleted } = await client.forget(params.source);
        return {
          content: `Deleted ${deleted} memories from source "${params.source}".`,
        };
      },
    });

    // ========================================================================
    // TOOL: astral_stats — Memory system statistics
    // ========================================================================

    api.registerTool({
      name: "astral_stats",
      description:
        "Get memory system statistics including total memories, tier distribution, " +
        "category health, and embedding backend info. Useful for understanding " +
        "the current state of the memory system.",
      parameters: Type.Object({}),
      execute: async () => {
        const health = await client.checkHealth();
        const stats = await client.stats();
        return {
          content: JSON.stringify(
            {
              server: {
                online: health.ok,
                version: health.version,
                embeddingBackend: health.embeddingBackend,
                cognitiveShell: health.cognitiveShell,
              },
              ...stats,
            },
            null,
            2
          ),
        };
      },
    });

    // ========================================================================
    // TOOL: astral_sync — Sync with Orbital Fortress
    // ========================================================================

    if (cfg.fortressUrl) {
      api.registerTool({
        name: "astral_sync",
        description:
          "Synchronise local memories with Orbital Fortress for cross-device " +
          "fleet intelligence. Uploads novel memories and receives briefings " +
          "from other devices in the fleet. Only available when Fortress URL " +
          "is configured.",
        parameters: Type.Object({
          maxBriefings: Type.Optional(
            Type.Number({
              description: "Max briefing records to receive (default: 10)",
              default: 10,
            })
          ),
        }),
        execute: async (params) => {
          const { recordsUploaded, briefingsReceived } = await client.sync(
            cfg.fortressUrl!,
            params.maxBriefings ?? 10
          );
          return {
            content:
              `Fortress sync complete. ` +
              `Uploaded: ${recordsUploaded} memories. ` +
              `Received: ${briefingsReceived} briefings from fleet.`,
          };
        },
      });
    }

    // NOTE: api.registerCommand() is not available on all OpenClaw builds.
    // The /astral slash command is omitted to ensure universal compatibility.
    // Users can check memory status via the astral_stats tool instead.

    api.logger.info("[astral-core] Plugin registered successfully");
  },
});
