// Generation Timestamp: 2026-04-08T19:00:00Z
// Location: integrations/openclaw/index.ts
//
// Astral Core Memory — OpenClaw Plugin Entry Point
// Version: 2.0.0
//
// This is the main entry point for the @astralcore/memory-openclaw plugin.
// It registers lifecycle hooks (auto-recall, auto-capture, briefing card)
// and agent tools with the OpenClaw Gateway.
//
// Architecture: Thin TypeScript bridge → Astral Core Memory Server (:8090)
// The memory engine runs as a local server. This plugin handles OpenClaw
// integration only.
//
// Requires: OpenClaw >= 2026.3.22 (before_prompt_build hook support)
// Requires: Astral Core Memory API Server v2.5.0+ for full feature set
//           (degrades gracefully against older servers)
//
// Hook lifecycle:
//   before_prompt_build → fetch relevant memories → inject into system prompt
//   agent_end           → extract conversation → feed to surprise-gated pipeline
//   session_start       → fetch briefing card → inject session context [NEW]
//
// Compatible with: plugins.slots.memory = "memory-astral-core"
//
// Changelog v2.0.0 (2026-04-08, B2 feature release):
//   - Feature: Briefing card injection on session start via GET /v1/memory/briefing.
//     The briefing card is a ≤200 token summary of identity facts, active context,
//     and category health — injected at the top of every new session.
//     (SPEC-PALACE-FOUNDATIONS-001 §1, task PF-1e)
//   - Feature: astral_briefing tool — agent can manually request a fresh briefing
//     card mid-session (e.g. "what do you know about me?").
//   - Feature: astral_enrich tool — surfaces enrichment hints from the Cognitive
//     Shell. Memories flagged for enrichment get presented as questions the agent
//     can ask the user for clarification. (B2 Phase 4 enrichment system)
//   - Fix: min_similarity raised from 0.3 → 0.45 on recall and auto-recall.
//     Addresses dormant reactivation storm (reviewer feedback: 84% dormancy at 7k
//     memories, 7-12 reactivations per search at min_similarity 0.3).
//   - Feature: astral_stats now surfaces importance_scoring section from B2 RT-3.
//   - Feature: Health check now reports active_in_ram vs dormant_cold_storage
//     (RAM-OPT-001 dormant cold storage split).
//   - Feature: configurable minSimilarity in plugin config (default 0.45).
//   - Feature: consolidate() response includes importance_protected count.
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
  minSimilarity: Type.Number({
    default: 0.45,
    description:
      "Minimum cosine similarity for memory recall (0.0-1.0). " +
      "Raised from 0.3 to 0.45 in v2.0.0 to reduce noisy dormant reactivation.",
    minimum: 0.0,
    maximum: 1.0,
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
  briefingCardOnStart: Type.Boolean({
    default: true,
    description:
      "Inject a briefing card at the start of each session. " +
      "The card is a ≤200 token summary of identity facts and active context.",
  }),
  briefingMaxTokens: Type.Number({
    default: 200,
    description: "Maximum tokens for the briefing card (50-500)",
    minimum: 50,
    maximum: 500,
  }),
  fortressUrl: Type.Optional(
    Type.String({
      default: "",
      description:
        "Orbital Fortress URL for fleet sync (leave empty to disable)",
    })
  ),
  healthCheckOnStart: Type.Boolean({
    default: true,
    description: "Check memory server health when plugin loads",
  }),
});

type AstralCoreConfig = Static<typeof AstralCoreConfigSchema>;

// ============================================================================
// HTTP Client — talks to Astral Core Memory Server
// ============================================================================

class AstralCoreClient {
  private baseUrl: string;
  private healthy: boolean = false;
  private serverVersion: string | null = null;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  // --- Health ---------------------------------------------------------------

  async checkHealth(): Promise<{
    ok: boolean;
    version?: string;
    totalMemories?: number;
    activeInRam?: number;
    dormantColdStorage?: number;
    embeddingBackend?: string;
    cognitiveShell?: boolean;
    licenseTier?: string;
  }> {
    try {
      const resp = await fetch(`${this.baseUrl}/health`, {
        signal: AbortSignal.timeout(5000),
      });
      if (!resp.ok) return { ok: false };
      const data = await resp.json();
      this.healthy = data.status === "ok";
      this.serverVersion = data.version ?? null;
      return {
        ok: this.healthy,
        version: data.version,
        totalMemories: data.total_memories,
        activeInRam: data.active_in_ram,
        dormantColdStorage: data.dormant_cold_storage,
        embeddingBackend: data.embedding_backend,
        cognitiveShell: data.cognitive_shell,
        licenseTier: data.license_tier,
      };
    } catch {
      this.healthy = false;
      return { ok: false };
    }
  }

  get isHealthy(): boolean {
    return this.healthy;
  }

  // --- Briefing Card (v2.5.0+) ---------------------------------------------

  async getBriefingCard(
    maxTokens: number = 200
  ): Promise<{
    card: string;
    approxTokens: number;
    totalMemories: number;
  } | null> {
    try {
      const resp = await fetch(
        `${this.baseUrl}/v1/memory/briefing?max_tokens=${maxTokens}`,
        { signal: AbortSignal.timeout(10000) }
      );
      if (!resp.ok) return null; // Server too old or endpoint not available
      const data = await resp.json();
      if (data.error) return null;
      return {
        card: data.card ?? "",
        approxTokens: data.approx_tokens ?? 0,
        totalMemories: data.total_memories ?? 0,
      };
    } catch {
      return null; // Graceful degradation — briefing is nice-to-have
    }
  }

  // --- Memory Recall (search) -----------------------------------------------

  async recall(
    query: string,
    limit: number = 5,
    minSimilarity: number = 0.45,
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
      importance_score?: number;
      needs_enrichment?: boolean;
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
    maxMemories: number = 5,
    minSimilarity: number = 0.45
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
          min_similarity: minSimilarity,
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
  ): Promise<{
    promoted: number;
    archived: number;
    importance_protected: number;
  }> {
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
      importance_protected: data.importance_protected ?? 0,
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
      minSimilarity: 0.45,
      captureMinMessages: 2,
      captureMaxChars: 8000,
      briefingCardOnStart: true,
      briefingMaxTokens: 200,
      fortressUrl: "",
      healthCheckOnStart: true,
      ...(api.config ?? {}),
    };

    const client = new AstralCoreClient(cfg.serverUrl);

    api.logger.info(
      `[astral-core] Initialising v2.0.0 — server: ${cfg.serverUrl}, ` +
        `autoRecall: ${cfg.autoRecall}, autoCapture: ${cfg.autoCapture}, ` +
        `briefingCard: ${cfg.briefingCardOnStart}, minSim: ${cfg.minSimilarity}`
    );

    // --- Startup health check -----------------------------------------------
    if (cfg.healthCheckOnStart) {
      client.checkHealth().then((h) => {
        if (h.ok) {
          api.logger.info(
            `[astral-core] Memory server online — v${h.version}, ` +
              `${h.activeInRam ?? h.totalMemories} active` +
              (h.dormantColdStorage ? ` + ${h.dormantColdStorage} dormant` : "") +
              `, backend: ${h.embeddingBackend}` +
              `, cognitive_shell: ${h.cognitiveShell}` +
              (h.licenseTier ? `, license: ${h.licenseTier}` : "")
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
    // HOOK: session_start — Briefing Card Injection
    // ========================================================================
    // Fires at the start of a new session (or conversation).
    // Fetches a ≤200 token briefing card summarising the user's identity facts,
    // active context, and category health. Injected into the system prompt so
    // the agent begins every session with awareness of who it's talking to.
    //
    // SPEC: SPEC-PALACE-FOUNDATIONS-001 §1.3, task PF-1e
    // Endpoint: GET /v1/memory/briefing?max_tokens=200
    // Degrades gracefully: if the server is too old (< v2.5.0) or down,
    // the hook returns nothing and the session starts without a card.

    if (cfg.briefingCardOnStart) {
      api.on(
        "before_prompt_build",
        async (event: {
          messages?: Array<{ role: string; content: unknown }>;
          isNewSession?: boolean;
        }) => {
          // Only inject the briefing card at the start of a session
          // (first message, or when OpenClaw signals a new session)
          const messages = event.messages ?? [];
          const userMessages = messages.filter((m) => m.role === "user");

          // Inject card on first user message only (session start)
          if (userMessages.length > 1) return;

          if (!client.isHealthy) {
            await client.checkHealth();
            if (!client.isHealthy) return;
          }

          try {
            const briefing = await client.getBriefingCard(cfg.briefingMaxTokens);
            if (briefing && briefing.card) {
              return {
                systemPromptParts: [
                  {
                    text: briefing.card,
                    position: "before",
                    label: "astral-core-briefing-card",
                  },
                ],
              };
            }
          } catch (err) {
            api.logger.debug(
              `[astral-core] Briefing card fetch failed (non-fatal): ${
                err instanceof Error ? err.message : String(err)
              }`
            );
          }
        },
        { name: "astral-core-briefing-card", priority: 5 }
      );
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
                cfg.maxRecallMemories,
                cfg.minSimilarity
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
          cfg.minSimilarity,
          params.source
        );
        const formatted = results
          .map(
            (r, i) =>
              `[${i + 1}] (${(r.similarity * 100).toFixed(0)}% match, ${r.category}, ${r.speed}) ${r.text}`
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
    // TOOL: astral_briefing — Get briefing card on demand
    // ========================================================================
    // Lets the agent fetch a fresh briefing card mid-session.
    // Useful when the user asks "what do you know about me?" or "summarise
    // what you remember" — the card is a concise ≤200 token summary.

    api.registerTool({
      name: "astral_briefing",
      description:
        "Get a briefing card — a concise summary of what you know about the user. " +
        "Includes identity facts, active project context, and memory health. " +
        "Use when the user asks what you remember or for a summary of your knowledge. " +
        "This is different from astral_recall which searches for specific topics.",
      parameters: Type.Object({
        max_tokens: Type.Optional(
          Type.Number({
            description: "Maximum tokens for the card (default: 200)",
            default: 200,
          })
        ),
      }),
      execute: async (params) => {
        const briefing = await client.getBriefingCard(params.max_tokens ?? 200);
        if (!briefing || !briefing.card) {
          return {
            content:
              "Briefing card not available. The memory server may be too old " +
              "(requires v2.5.0+) or no memories have been stored yet.",
          };
        }
        return {
          content: briefing.card,
          metadata: {
            approxTokens: briefing.approxTokens,
            totalMemories: briefing.totalMemories,
          },
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
        "category health, importance scoring status, and embedding backend info. " +
        "Useful for understanding the current state of the memory system.",
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
                activeInRam: health.activeInRam,
                dormantColdStorage: health.dormantColdStorage,
                licenseTier: health.licenseTier,
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
    // TOOL: astral_enrich — Surface enrichment hints from Cognitive Shell
    // ========================================================================
    // The enrichment system flags memories where the surprise gate stored
    // something that could benefit from user clarification. The agent can
    // surface these hints as natural follow-up questions.
    //
    // Example: Memory stored "user prefers X framework" but confidence is low.
    // Enrichment hint: "You mentioned X — did you mean the React framework
    // or the testing framework?"
    //
    // Reads from /v1/memory/stats → enrichment section. If no enrichment
    // data is available (pre-B2 server), degrades gracefully.

    api.registerTool({
      name: "astral_enrich",
      description:
        "Check for memories that need clarification from the user. The memory system " +
        "may have stored ambiguous information that could benefit from follow-up " +
        "questions. Use this occasionally (not every turn) to improve memory quality. " +
        "Returns pending enrichment hints or 'none pending' if all clear.",
      parameters: Type.Object({}),
      execute: async () => {
        try {
          const stats = (await client.stats()) as Record<string, any>;
          const enrichment = stats.enrichment;
          if (!enrichment || enrichment.pending === 0) {
            return {
              content: "No enrichment hints pending. All memories are clear.",
            };
          }
          return {
            content:
              `${enrichment.pending} memories could benefit from clarification. ` +
              `${enrichment.asked} hints already asked, ${enrichment.resolved} resolved, ` +
              `${enrichment.expired} expired. ` +
              `Use astral_recall to find memories with ambiguous content and ask ` +
              `the user for clarification.`,
            metadata: enrichment,
          };
        } catch {
          return {
            content:
              "Enrichment system not available (requires memory server with B2 features).",
          };
        }
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

    api.logger.info("[astral-core] Plugin v2.0.0 registered successfully");
  },
});
