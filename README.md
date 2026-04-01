# Astral Core Memory — OpenClaw Plugin

Offline-first persistent memory for OpenClaw agents. No API keys required.

Your agent remembers across sessions, learns what matters, and works
entirely on your machine.

---

## Quick Start

### 1. Install the plugin

```bash
npm install @astralcore/memory-openclaw
```

### 2. Download and run the memory server

The plugin talks to the Astral Core memory server running on your machine.

```bash
# macOS (Apple Silicon)
curl -L https://orbitalfortress.com/download/macos -o astral-memory-server
chmod +x astral-memory-server

# Linux x86_64
curl -L https://orbitalfortress.com/download/linux -o astral-memory-server
chmod +x astral-memory-server

# Windows — download from https://orbitalfortress.com/download/windows
```

Activate with your license key (one-time):

```bash
./astral-memory-server --activate SOUL-XXXX-XXXX-XXXX-XXXX
```

Start the server:

```bash
./astral-memory-server
```

The server runs on `http://localhost:8090`. Verify:

```bash
curl http://localhost:8090/health
```

### 3. Add the plugin to your OpenClaw config

```json
{
  "plugins": {
    "memory": {
      "provider": "@astralcore/memory-openclaw",
      "config": {
        "serverUrl": "http://localhost:8090",
        "autoCapture": true,
        "autoRecall": true,
        "maxRecallMemories": 5
      }
    }
  }
}
```

That's it. Your agent now has persistent memory.

---

## Setting Up the Embedding Model

The memory server needs a local embedding model to convert text into
searchable vectors. No external API keys are needed — everything runs
on your machine.

### Option A — Use the bundled model (recommended)

If you have `llama.cpp` installed, start the embedding server with
the nomic-embed model:

```bash
# Download the model (~300MB)
curl -L https://huggingface.co/nomic-ai/nomic-embed-text-v1.5-GGUF/resolve/main/nomic-embed-text-v1.5.Q5_K_M.gguf \
  -o nomic-embed-text-v1.5.Q5_K_M.gguf

# Start the embedding server on port 8081
llama-server \
  --model nomic-embed-text-v1.5.Q5_K_M.gguf \
  --port 8081 \
  --embedding \
  --ctx-size 2048
```

The memory server connects to `localhost:8081` by default.

### Option B — Use a different embedding model

Any OpenAI-compatible embedding endpoint works. Pass the URL
when starting the memory server:

```bash
./astral-memory-server --embedding-url http://localhost:11434/api/embeddings
```

This works with Ollama, LM Studio, or any service that serves
embeddings over HTTP.

### Option C — Use a remote embedding API

If you prefer a hosted embedding service:

```bash
./astral-memory-server --embedding-url https://api.openai.com/v1/embeddings \
  --embedding-api-key sk-your-key
```

This still keeps your memories local — only the embedding vectors
are generated remotely, not your stored data.

---

## Ingesting Existing Data

If you have existing notes, documents, or conversation history you
want the memory server to learn from, use the ingest endpoint.

### Ingest conversation turns

```bash
curl -X POST http://localhost:8090/v1/memory/ingest \
  -H "Content-Type: application/json" \
  -d '{
    "turns": [
      {
        "user": "We use Kubernetes for deployment with ArgoCD for GitOps",
        "assistant": "Noted — Kubernetes with ArgoCD for your deployment pipeline."
      },
      {
        "user": "Our database is PostgreSQL 16 with pgvector for embeddings",
        "assistant": "Got it — PostgreSQL 16 with the pgvector extension."
      }
    ],
    "source": "initial-import"
  }'
```

The server evaluates each turn and stores only what it considers
novel. If you ingest overlapping information, duplicates are
automatically filtered out.

### Bulk ingest from a file

For larger imports, use a simple script:

```python
import json
import requests

MEMORY = "http://localhost:8090"

# Load your data — any format, convert to turns
with open("my_notes.jsonl") as f:
    for line in f:
        record = json.loads(line)
        requests.post(f"{MEMORY}/v1/memory/ingest", json={
            "turns": [{
                "user": record["question"],
                "assistant": record["answer"]
            }],
            "source": "bulk-import"
        })

print("Import complete")
```

### Ingest plain text (without conversation structure)

If you have standalone notes or documents:

```bash
curl -X POST http://localhost:8090/v1/memory/ingest \
  -H "Content-Type: application/json" \
  -d '{
    "turns": [
      {
        "user": "Remember this: Our SLA requires 99.9% uptime for the payments service",
        "assistant": "Stored."
      }
    ],
    "source": "manual-notes"
  }'
```

### Check what was stored

```bash
# Total memory count
curl http://localhost:8090/v1/memory/stats

# Search for specific memories
curl -X POST http://localhost:8090/v1/memory/search \
  -H "Content-Type: application/json" \
  -d '{"query": "deployment", "limit": 5}'
```

### Delete imported memories if needed

```bash
# Delete all memories from a specific source
curl -X DELETE http://localhost:8090/v1/memory/source/bulk-import
```

---

## Re-embedding Memories

If you switch to a different embedding model (different dimensions
or better quality), your existing memories need to be re-embedded
to match the new vector space.

### When do I need to re-embed?

- You changed the embedding model (e.g. from nomic 768d to a 1024d model)
- You upgraded to a newer version of the same model
- Searches are returning poor results after a model change

### How to re-embed

Stop the memory server, swap the embedding model, and restart
with the re-embed flag:

```bash
# 1. Stop the running server (Ctrl+C or kill the process)

# 2. Start the new embedding model on port 8081
llama-server \
  --model your-new-embedding-model.gguf \
  --port 8081 \
  --embedding \
  --ctx-size 2048

# 3. Restart the memory server with re-embed flag
./astral-memory-server --rebuild-embeddings
```

The server will re-process all existing memories through the new
embedding model. This may take a few minutes depending on how
many memories you have. Progress is shown in the terminal.

Your memories (the actual text) are never modified — only the
vector representations are regenerated.

### Checking embedding status

```bash
curl http://localhost:8090/health
```

The response includes embedding dimension and model information
so you can verify the new model is active.

---

## Configuration Reference

All configuration is passed as command-line flags or via a
`config.yaml` file in the same directory as the binary.

| Flag | Default | Description |
|------|---------|-------------|
| `--port` | `8090` | Memory server port |
| `--embedding-url` | `http://localhost:8081` | Embedding server URL |
| `--embedding-api-key` | (none) | API key for remote embedding services |
| `--data-dir` | `./data` | Where memories are stored on disk |
| `--rebuild-embeddings` | (off) | Re-embed all memories on startup |
| `--activate KEY` | (none) | Activate with license key (first run only) |

---

## Plugin Configuration

| Option | Default | Description |
|--------|---------|-------------|
| `serverUrl` | `http://localhost:8090` | Memory server URL |
| `autoCapture` | `true` | Store memories after each conversation turn |
| `autoRecall` | `true` | Inject relevant memories into prompts |
| `maxRecallMemories` | `5` | Max memories injected per prompt |
| `captureMinMessages` | `2` | Minimum messages before capturing |
| `fortressUrl` | (empty) | Orbital Fortress URL for cross-device sync |

---

## Troubleshooting

### "Connection refused" on localhost:8090

The memory server isn't running. Start it:

```bash
./astral-memory-server
```

### "Embedding server not available"

The embedding model server isn't running on port 8081. Start it:

```bash
llama-server --model nomic-embed-text-v1.5.Q5_K_M.gguf --port 8081 --embedding
```

### Memories aren't being stored

The server filters out information it already knows or considers
redundant. Check what's stored:

```bash
curl http://localhost:8090/v1/memory/stats
```

If the count is zero, verify the embedding server is running —
memories can't be stored without embeddings.

### Search returns irrelevant results

This usually means the embedding model changed since memories
were stored. Re-embed:

```bash
./astral-memory-server --rebuild-embeddings
```

---

## Links

- [Get a license](https://orbitalfortress.com) — €19, one-time, no subscription
- [How Astral Core works](https://orbitalfortress.com/how-it-works) — for non-technical users
- [For Developers](https://orbitalfortress.com/developers) — API reference and integration guide
- [Report an issue](https://github.com/Suo-commerce/memory-openclaw/issues)

---

## License

MIT — see [LICENSE](./LICENSE) for details.

The plugin is open source. The Astral Core memory server binary
requires a [license](https://orbitalfortress.com) (€19 one-time).
