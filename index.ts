// Generation Timestamp: 2026-05-11T22:15:00Z
// Location: integrations/openclaw/index.ts (repo: Suo-commerce/memory-openclaw)
//
// Astral Core Memory — OpenClaw Plugin Entry Point
// Version: 2.1.2
//
// This is the main entry point for the @suocommerce/memory-openclaw plugin.
// It registers lifecycle hooks (auto-recall, auto-capture) and agent tools
// with the OpenClaw Gateway.
//
// Architecture: Thin TypeScript bridge → Astral Core Memory Server (:8090)
// Target: Rust server (astral-memory-server v2.7.0+). The Python
// memory_api_server.py is no longer supported — pin v2.0.0 if you need it.
//
// Requires: OpenClaw >= 2026.3.22 (before_prompt_build hook support,
//           kind:"memory" manifest declaration)
// Requires: Astral Core Memory API Server v2.7.0+ (Rust)
//
// Hook lifecycle:
//   before_prompt_build → fetch relevant memories → inject into system prompt
//   agent_end           → extract conversation → feed to surprise-gated pipeline
//
// Compatible with: plugins.slots.memory = "memory-astral-core"
//
// ============================================================================
// Changelog v2.1.2 (2026-05-11, Rust-native rewrite)
// ============================================================================
//
// BREAKING CHANGE: this version is Rust-only. The Python memory_api_server.py
// contract is no longer supported — pin v2.0.0 if you need it.
//
// CONTEXT: in May 2026, an end-to-end OpenClaw test against the running
// Rust server revealed that the plugin and server had drifted in two minor
// versions. The plugin assumed Python field names and Python-only endpoints
// that the Rust server doesn't implement. All hook calls succeeded but
// produced silent zeroes because response parsing failed.
//
// FIXES:
//   - CRITICAL: api.config → api.pluginConfig. OpenClaw exposes plugin
//     config under api.pluginConfig (matching the stock memory-lancedb
//     plugin pattern). The previous spread of api.config ?? {} silently
//     dropped every user-configured value back to the schema default.
//     This single bug masked every other user setting since v2.0.0.
//
//   - Response field mapping aligned to Rust server:
//       /v1/memory/augmented-prompt:
//         memories_injected → memories_used
//       /v1/memory/ingest, /v1/memory/ingest/batch:
//         stored             → segments_stored
//         skipped            → computed as segments_processed - segments_stored
//       /v1/memory/stats:
//         data.*             → data.stats.* (Rust wraps under "stats")
//
//   - Removed unsupported features (Rust server does not implement these
//     endpoints):
//       • Briefing card injection in before_prompt_build
//       • astral_briefing tool
//       • astral_forget tool (DELETE /v1/memory/source/<src> → 404)
//       • astral_sync tool (POST /v1/sync/trigger → 404)
//       • astral_enrich tool (depends on stats.enrichment which Rust omits)
//     When the Rust server gains these endpoints, the tools return in v2.2.0.
//
//   - Removed config options:
//       briefingCardOnStart, briefingMaxTokens, fortressUrl
//
//   - Auto-capture log line corrected: previously reported "all N filtered
//     by surprise gate" when in fact N=0 segments-stored could mean either
//     "none novel" or "all stored". Now distinguishes:
//       segments_processed=N, segments_stored=N: "Captured N memories"
//       segments_processed=N, segments_stored=0: "all N filtered by surprise gate"
//       segments_processed=N, segments_stored=K (0<K<N): mixed result
//
//   - Health check no longer mentions embedding_backend or cognitive_shell.
//     The Rust server doesn't return these fields in /health and the
//     plugin shouldn't claim to know what it can't see.
//
// PRESERVED from v2.1.1:
//   - verboseHooks config flag — entry/branch logging for hook diagnostics
//   - kind: "memory" in openclaw.plugin.json manifest (required for dispatch)
//   - configSchema in both manifest and definePluginEntry()
//   - flattenContent() helper for OpenClaw array-shaped message content
//   - Surprise-gated capture pipeline integration
//
// PROVEN ON: OpenClaw 2026.3.31, Rust server v2.7.0 (./target/debug/
//            astral-memory-server --port 8090 --deep-rerank)

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
    description: "Astral Core Memory API server URL (Rust v2.7.0+)",
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
  healthCheckOnStart: Type.Boolean({
    default: true,
    description: "Check memory server health when plugin loads",
  }),
  verboseHooks: Type.Boolean({
    default: false,
    description:
      "Log every hook invocation at INFO level with dispatch context. " +
      "Enable when diagnosing hook-routing issues. Adds approximately " +
      "5-8 log lines per agent turn. Safe to leave off in production.",
  }),
});

type AstralCoreConfig = Static<typeof AstralCoreConfigSchema>;

// ============================================================================
// HTTP Client — talks to Astral Core Memory Server (Rust v2.7.0+)
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
    uptimeSeconds?: number;
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
        uptimeSeconds: data.uptime_seconds,
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
  // Rust server returns: {context_block, memories_used, query_used}

  async getAugmentedPrompt(
    query: string,
    messages: Array<{ role: string; content: unknown }>,
    maxMemories: number = 5,
    minSimilarity: number = 0.45
  ): Promise<{ contextBlock: string; memoriesInjected: number }> {
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
      memoriesInjected: data.memories_used ?? 0,
    };
  }

  // --- Memory Capture (ingest/batch) ----------------------------------------
  // Rust server returns: {turns_received, segments_processed, segments_stored,
  //                      memories_before, memories_after, session_id}

  async capture(
    turns: Array<{
      user_message: string;
      assistant_response: string;
    }>,
    source: string
  ): Promise<{
    stored: number;
    skipped: number;
    processed: number;
    memoriesBefore: number;
    memoriesAfter: number;
  }> {
    const resp = await fetch(`${this.baseUrl}/v1/memory/ingest/batch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ turns, source }),
      signal: AbortSignal.timeout(15000),
    });
    if (!resp.ok) throw new Error(`Capture failed: ${resp.status}`);
    const data = await resp.json();
    const processed = data.segments_processed ?? 0;
    const stored = data.segments_stored ?? 0;
    return {
      stored,
      skipped: Math.max(0, processed - stored),
      processed,
      memoriesBefore: data.memories_before ?? 0,
      memoriesAfter: data.memories_after ?? 0,
    };
  }

  // --- Manual Store (single-turn ingest) ------------------------------------
  // Same response shape as /ingest/batch but for a single turn.

  async store(
    text: string,
    category: string = "fact",
    source: string = "openclaw_manual"
  ): Promise<{ stored: number; processed: number }> {
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
    return {
      stored: data.segments_stored ?? 0,
      processed: data.segments_processed ?? 0,
    };
  }

  // --- Stats ----------------------------------------------------------------
  // Rust server returns: {stats: {...}, server_version, ingest_count,
  //                      uptime_seconds}

  async stats(): Promise<{
    serverVersion: string;
    ingestCount: number;
    uptimeSeconds: number;
    stats: Record<string, unknown>;
  }> {
    const resp = await fetch(`${this.baseUrl}/v1/memory/stats`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!resp.ok) throw new Error(`Stats failed: ${resp.status}`);
    const data = await resp.json();
    return {
      serverVersion: data.server_version ?? "unknown",
      ingestCount: data.ingest_count ?? 0,
      uptimeSeconds: data.uptime_seconds ?? 0,
      stats: data.stats ?? {},
    };
  }

  // --- Consolidate ----------------------------------------------------------
  // Rust server returns: {level, transitions: {evaluated, transitioned,
  //                      promoted, demoted, dormant, pruned, errors}}

  async consolidate(level: string = "session"): Promise<{
    evaluated: number;
    transitioned: number;
    promoted: number;
    demoted: number;
    dormant: number;
    pruned: number;
    errors: number;
  }> {
    const resp = await fetch(`${this.baseUrl}/v1/memory/consolidate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ level }),
      signal: AbortSignal.timeout(30000),
    });
    if (!resp.ok) throw new Error(`Consolidate failed: ${resp.status}`);
    const data = await resp.json();
    const t = data.transitions ?? {};
    return {
      evaluated: t.evaluated ?? 0,
      transitioned: t.transitioned ?? 0,
      promoted: t.promoted ?? 0,
      demoted: t.demoted ?? 0,
      dormant: t.dormant ?? 0,
      pruned: t.pruned ?? 0,
      errors: t.errors ?? 0,
    };
  }
}

// ============================================================================
// Plugin Entry Point
// ============================================================================

export default definePluginEntry({
  id: "memory-astral-core",
  name: "Astral Core Memory",
  kind: "memory",
  configSchema: AstralCoreConfigSchema,

  register(api: OpenClawPluginApi) {
    // --- Parse config -------------------------------------------------------
    // CRITICAL: read from api.pluginConfig, NOT api.config.
    // The stock memory-lancedb plugin uses api.pluginConfig — the same key
    // OpenClaw exposes user config under. Spreading api.config ?? {} silently
    // dropped every user setting back to the schema default (the bug that
    // hid all of v2.0.0 through v2.1.1).
    const cfg: AstralCoreConfig = {
      serverUrl: "http://localhost:8090",
      autoCapture: true,
      autoRecall: true,
      maxRecallMemories: 5,
      minSimilarity: 0.45,
      captureMinMessages: 2,
      captureMaxChars: 8000,
      healthCheckOnStart: true,
      verboseHooks: false,
      ...(api.pluginConfig ?? {}),
    };

    const client = new AstralCoreClient(cfg.serverUrl);

    api.logger.info(
      `[astral-core] Initialising v2.1.2 — server: ${cfg.serverUrl}, ` +
        `autoRecall: ${cfg.autoRecall}, autoCapture: ${cfg.autoCapture}, ` +
        `minSim: ${cfg.minSimilarity}, ` +
        `verboseHooks: ${cfg.verboseHooks}`
    );

    // --- Startup health check -----------------------------------------------
    if (cfg.healthCheckOnStart) {
      client.checkHealth().then((h) => {
        if (h.ok) {
          api.logger.info(
            `[astral-core] Memory server online — v${h.version}, ` +
              `${h.activeInRam ?? h.totalMemories} active` +
              (h.dormantColdStorage
                ? ` + ${h.dormantColdStorage} dormant`
                : "") +
              (h.uptimeSeconds
                ? `, uptime ${Math.round(h.uptimeSeconds / 60)}min`
                : "")
          );
        } else {
          api.logger.warn(
            `[astral-core] Memory server not reachable at ${cfg.serverUrl}. ` +
              `Start it with: ./astral-memory-server --port 8090`
          );
        }
      });
    }

    // ========================================================================
    // HOOK: before_prompt_build — Auto-Recall
    // ========================================================================
    // Fires before the agent's system prompt is assembled. We fetch relevant
    // memories from the Rust server and inject them as a context block.

    if (cfg.autoRecall) {
      api.on(
        "before_prompt_build",
        async (event: {
          messages?: Array<{ role: string; content: unknown }>;
        }) => {
          if (cfg.verboseHooks) {
            api.logger.info(
              `[astral-core] before_prompt_build invoked — ` +
                `messages=${event.messages?.length ?? 0}`
            );
          }

          if (!client.isHealthy) {
            await client.checkHealth();
            if (!client.isHealthy) {
              if (cfg.verboseHooks) {
                api.logger.info(
                  "[astral-core] before_prompt_build: server unhealthy, skipping"
                );
              }
              return;
            }
          }

          try {
            const messages = event.messages ?? [];
            const lastUser = [...messages]
              .reverse()
              .find((m) => m.role === "user");

            if (!lastUser?.content) {
              if (cfg.verboseHooks) {
                api.logger.info(
                  "[astral-core] before_prompt_build: no user message, skipping"
                );
              }
              return;
            }

            const query = flattenContent(lastUser.content);
            if (!query) {
              if (cfg.verboseHooks) {
                api.logger.info(
                  "[astral-core] before_prompt_build: empty query, skipping"
                );
              }
              return;
            }

            const { contextBlock, memoriesInjected } =
              await client.getAugmentedPrompt(
                query,
                messages.slice(-10),
                cfg.maxRecallMemories,
                cfg.minSimilarity
              );

            if (contextBlock && memoriesInjected > 0) {
              if (cfg.verboseHooks) {
                api.logger.info(
                  `[astral-core] Auto-recall injected — ${memoriesInjected} ` +
                    `memories (query length: ${query.length} chars)`
                );
              }
              return {
                systemPromptParts: [
                  {
                    text: contextBlock,
                    position: "before",
                    label: "astral-core-memories",
                  },
                ],
              };
            }
            if (cfg.verboseHooks) {
              api.logger.info(
                `[astral-core] Auto-recall: no memories above similarity ` +
                  `threshold ${cfg.minSimilarity} (query: ${query.length} chars)`
              );
            }
          } catch (err) {
            api.logger.warn(
              `[astral-core] Auto-recall failed: ${
                err instanceof Error ? err.message : String(err)
              }`
            );
          }
        },
        { name: "astral-core-auto-recall", priority: 10 }
      );
    }

    // ========================================================================
    // HOOK: agent_end — Auto-Capture
    // ========================================================================
    // Fires after the agent finishes a response. Send the conversation turn
    // through the Rust server's surprise-gated MASK pipeline.

    if (cfg.autoCapture) {
      api.on(
        "agent_end",
        async (event: {
          messages?: Array<{ role: string; content: unknown }>;
          sessionId?: string;
          agentId?: string;
        }) => {
          if (cfg.verboseHooks) {
            api.logger.info(
              `[astral-core] agent_end invoked — ` +
                `messages=${event.messages?.length ?? 0}, ` +
                `session=${event.sessionId ?? "?"}, ` +
                `agent=${event.agentId ?? "?"}`
            );
          }

          if (!client.isHealthy) {
            if (cfg.verboseHooks) {
              api.logger.info(
                "[astral-core] agent_end: server unhealthy, skipping capture"
              );
            }
            return;
          }

          try {
            const messages = event.messages ?? [];
            if (messages.length < cfg.captureMinMessages) {
              if (cfg.verboseHooks) {
                api.logger.info(
                  `[astral-core] agent_end: only ${messages.length} messages ` +
                    `(< ${cfg.captureMinMessages}), skipping`
                );
              }
              return;
            }

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
                if (turns.length >= 3) break;
              }
            }

            if (turns.length === 0) {
              if (cfg.verboseHooks) {
                api.logger.info(
                  "[astral-core] agent_end: no user/assistant pairs found"
                );
              }
              return;
            }

            const source = `openclaw_${event.agentId ?? "default"}_${
              event.sessionId ?? "session"
            }`;

            const { stored, skipped, processed } = await client.capture(
              turns,
              source
            );

            // Three-way log message reflecting actual Rust server semantics:
            //   - all stored      → "Captured N memories"
            //   - all skipped     → "filtered by surprise gate (no novel)"
            //   - partial         → "Captured K of N (M filtered)"
            if (stored > 0 && skipped === 0) {
              api.logger.info(
                `[astral-core] Captured ${stored} memories`
              );
            } else if (stored === 0 && processed > 0) {
              if (cfg.verboseHooks) {
                api.logger.info(
                  `[astral-core] agent_end: ${processed} segments processed, ` +
                    `all filtered by surprise gate (no novel content)`
                );
              }
            } else if (stored > 0 && skipped > 0) {
              api.logger.info(
                `[astral-core] Captured ${stored} of ${processed} memories ` +
                  `(${skipped} filtered by surprise gate)`
              );
            }
          } catch (err) {
            api.logger.warn(
              `[astral-core] Auto-capture failed: ${
                err instanceof Error ? err.message : String(err)
              }`
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
        "Search long-term memory for relevant information. Use this when you " +
        "need to remember something from a previous conversation, recall user " +
        "preferences, find project context, or look up facts the user has " +
        "shared before. Returns semantically similar memories ranked by relevance.",
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
            description:
              "Filter by source (e.g. 'openclaw_main_session-uuid')",
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
              `[${i + 1}] (${(r.similarity * 100).toFixed(0)}% match, ` +
              `${r.category}, ${r.speed}) ${r.text}`
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
        "Explicitly store something important in long-term memory. Use this " +
        "when the user asks you to remember something specific, or when you " +
        "identify a critical fact, preference, or decision that should " +
        "persist across sessions. The memory goes through surprise-gated " +
        "filtering — truly redundant information may be automatically skipped.",
      parameters: Type.Object({
        text: Type.String({
          description: "The information to remember",
        }),
        category: Type.Optional(
          Type.String({
            description:
              "Category: fact, preference, decision, entity, event, pattern " +
              "(default: fact)",
            default: "fact",
          })
        ),
      }),
      execute: async (params) => {
        const { stored, processed } = await client.store(
          params.text,
          params.category ?? "fact",
          "openclaw_manual"
        );
        if (stored > 0) {
          return {
            content: `Stored ${stored} segment(s) in long-term memory.`,
          };
        }
        if (processed > 0) {
          return {
            content:
              "Memory was filtered by surprise gate (likely already known). " +
              "Nothing stored.",
          };
        }
        return {
          content: "No content to store.",
        };
      },
    });

    // ========================================================================
    // TOOL: astral_stats — Memory system statistics
    // ========================================================================
    api.registerTool({
      name: "astral_stats",
      description:
        "Get memory system statistics including total memories, tier " +
        "distribution, matrices state, and embedding dimensions. Useful " +
        "for understanding the current state of the memory system.",
      parameters: Type.Object({}),
      execute: async () => {
        const health = await client.checkHealth();
        const { serverVersion, ingestCount, uptimeSeconds, stats } =
          await client.stats();
        return {
          content: JSON.stringify(
            {
              server: {
                online: health.ok,
                version: serverVersion,
                uptimeSeconds,
                ingestCount,
                totalMemories: health.totalMemories,
                activeInRam: health.activeInRam,
                dormantColdStorage: health.dormantColdStorage,
              },
              stats,
            },
            null,
            2
          ),
        };
      },
    });

    // ========================================================================
    // TOOL: astral_consolidate — Trigger consolidation pass
    // ========================================================================
    api.registerTool({
      name: "astral_consolidate",
      description:
        "Trigger a memory consolidation pass. Evaluates all memories for " +
        "tier transitions (promotion to faster tiers if frequently accessed, " +
        "demotion or dormancy if rarely useful). Use sparingly — runs " +
        "across the entire memory store.",
      parameters: Type.Object({
        level: Type.Optional(
          Type.String({
            description:
              "Consolidation level: 'session' (default), 'daily', or 'deep'",
            default: "session",
          })
        ),
      }),
      execute: async (params) => {
        const result = await client.consolidate(params.level ?? "session");
        return {
          content:
            `Consolidation complete. ` +
            `Evaluated ${result.evaluated} memories. ` +
            `Transitions: ${result.transitioned} ` +
            `(${result.promoted} promoted, ${result.demoted} demoted, ` +
            `${result.dormant} dormant, ${result.pruned} pruned). ` +
            (result.errors > 0 ? `Errors: ${result.errors}.` : ""),
          metadata: result,
        };
      },
    });

    api.logger.info("[astral-core] Plugin v2.1.2 registered successfully");
  },
});
