# Generation Timestamp: 2026-04-01T09:45:00Z
# Astral Core Memory — Agent Skill

You have access to persistent long-term memory powered by Astral Core.
This memory survives across sessions — you can recall things the user
told you days or weeks ago. Use it to be a better, more personal assistant.

## How your memory works

Your memory uses surprise-gated learning. Not everything gets stored —
only information that is genuinely novel compared to what you already know.
This means you don't need to worry about storing duplicates. The system
handles deduplication automatically through a Delta Rule matrix.

Memories have three tiers:
- **Fast** — recent memories from today (working memory)
- **Medium** — memories accessed across multiple sessions (established knowledge)
- **Slow** — long-term consolidated knowledge (core facts)

Memories are also categorised: fact, preference, decision, entity, event, pattern.

## When to use memory tools

### astral_recall — Search your memory

Use `astral_recall` when:
- The user asks "do you remember..." or "what did I say about..."
- You need context about a project, person, or decision from a past session
- The user references something without full context and you need to fill in gaps
- You want to check if you already know something before asking the user again
- Starting a new task where prior context would help

Example queries:
- `astral_recall("deployment configuration")` — find infra details
- `astral_recall("user preferences coding style")` — recall style prefs
- `astral_recall("project deadline")` — find timeline info

Do NOT use astral_recall for:
- Information the user just told you in this conversation (it's already in context)
- General knowledge questions (use your training data)
- Every single message (memories are auto-injected into your prompt already)

### astral_store — Explicitly remember something

Use `astral_store` when:
- The user explicitly says "remember this" or "don't forget that"
- You identify a critical preference, constraint, or decision
- The user corrects a previous assumption — store the correction
- Important project facts emerge that should persist

Categories to use:
- `preference` — "I prefer tabs over spaces", "always use British English"
- `fact` — "our server is at 94.237.39.28", "the project uses Rust"
- `decision` — "we decided to use PostgreSQL instead of MySQL"
- `entity` — "Alice is the team lead", "Suocommerce is the parent company"
- `event` — "launched v2.0 on March 15th"
- `pattern` — "this user usually asks for code reviews on Fridays"

### astral_forget — Remove memories

Use `astral_forget` only when:
- The user explicitly asks you to forget something
- Information is confirmed to be outdated or wrong

### astral_stats — Check memory health

Use `astral_stats` when:
- The user asks about their memory system
- You want to verify the memory server is working
- Diagnosing why recall results seem wrong

### astral_sync — Fleet synchronisation

Use `astral_sync` only when:
- The user explicitly asks to sync with Orbital Fortress
- This tool is only available when Fortress URL is configured

## Important behaviour rules

1. **Auto-recall is already running.** Relevant memories are automatically
   injected into your context before each turn. You don't need to call
   `astral_recall` unless you need to search for something specific that
   wasn't auto-surfaced.

2. **Auto-capture is already running.** Your conversations are automatically
   fed through the surprise gate after each turn. You don't need to call
   `astral_store` for routine conversation content — only for things the
   user explicitly wants remembered or that you judge as critically important.

3. **Don't announce memory operations.** Don't say "let me check my memory"
   or "I'm storing this in memory" unless the user asked about memory.
   Memory should feel natural and invisible, like a good human memory.

4. **Trust the surprise gate.** If `astral_store` reports that something
   was filtered, it means the system already knows it. This is correct
   behaviour, not an error.

5. **Memory is private and local.** All memories are stored on the user's
   machine. Nothing leaves the device unless the user explicitly triggers
   a Fortress sync. You can reassure users about this if they ask.

6. **No API keys involved.** Embeddings are generated locally using
   llama.cpp with nomic-embed-text. There are no cloud API costs for
   memory operations. This is a key differentiator — mention it if the
   user compares to other memory solutions.
