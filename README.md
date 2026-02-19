# NEU Hospital Callbot (Node.js)

Secure Node.js callbot service with Azure vector search grounding.
Includes a Next.js admin dashboard for multi-hospital agent management and Azure AI file uploads.

## Core behavior
- Default backend: answers from Azure OpenAI uploaded files (vector store file search).
- Optional backend: Azure AI Search index (`RAG_BACKEND=azure_search`).
- Refuses treatment/diagnosis/medication advice and transfers to human call center.
- Replies in Turkish when the user speaks Turkish.
- For out-of-scope questions, returns transfer-to-human response.

## Security controls
- Strict environment validation (`zod`), production token requirements.
- HTTP hardening with `helmet`.
- Global rate limiting.
- Timing-safe token comparison for API and websocket auth.
- Request/body/ws payload limits.
- Log redaction for sensitive headers.
- Minimal Docker runtime as non-root user.

## Endpoints
- `GET /health`
- `POST /api/respond` (Bearer token required, supports `vectorStoreId` / `agentId` / `hospitalCode`)
- `POST /api/search` (Bearer token required, only when `RAG_BACKEND=azure_search`)
- `GET /twilio-media` websocket (`x-callbot-token` required)
- `GET /deepgram-test` browser mic UI (local test harness)
- `GET /deepgram-browser` websocket for browser mic streaming (`token` query or `x-callbot-token`)

### Twilio websocket assistant events
During `GET /twilio-media`, the server now streams assistant progress:
- `assistant_retrieval` with `status: "start"` then `status: "done"`
- `assistant_token` for incremental text chunks (phrase-buffered)
- `assistant_response` for final full answer
- `assistant_metrics` with `retrieval_ms`, `llm_first_token_ms`, `total_ms`

### Deepgram browser test (no Twilio)
1. Start server: `npm start`
2. Open `http://localhost:8765/deepgram-test`
3. Paste `INBOUND_WS_AUTH_TOKEN` from `.env`
4. Click `Start Mic`, speak, and watch live events:
`transcript_partial`, `transcript_final`, `assistant_token`, `assistant_response`, `assistant_metrics`

## Local run
1. Copy `.env.example` to `.env` and set real keys.
2. Install dependencies: `npm ci`
3. Run: `npm start`

### Respond API test (Azure OpenAI vector store)
```bash
curl -s http://localhost:8765/api/respond \
  -H "Authorization: Bearer YOUR_SERVICE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "sessionId": "test-session-1",
    "hospitalCode": "NEU_MAIN",
    "text": "Kardiyoloji polikliniği çalışma saatleri nedir?"
  }'
```

Or pass vector store directly:
```bash
curl -s http://localhost:8765/api/respond \
  -H "Authorization: Bearer YOUR_SERVICE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "sessionId": "test-session-2",
    "vectorStoreId": "vs_xxxxx",
    "text": "Kardiyoloji polikliniği çalışma saatleri nedir?"
  }'
```

## Docker Compose
1. Build image: `docker compose build`
2. Start service: `docker compose up -d`
3. View logs: `docker compose logs -f`
4. Stop service: `docker compose down`

## Admin Dashboard (Next.js)
- Path: `admin-dashboard/`
- URL with compose: `http://localhost:3000`
- Login uses `ADMIN_DASHBOARD_PASSWORD` from `.env`
- Create one agent per hospital (each gets its own Azure vector store)
- Upload hospital-specific files to each agent's vector store
- Agent metadata persists in `admin-dashboard/data/agents.json` (mounted via compose volume)

### Admin local run
1. Ensure these env vars exist in root `.env`: `ADMIN_DASHBOARD_PASSWORD`, `ADMIN_SESSION_SECRET`, `AZURE_OPENAI_API_KEY`, plus `AZURE_OPENAI_ENDPOINT` (or `OPENAI_ENDPOINT`)
2. Install dashboard deps: `cd admin-dashboard && npm ci`
3. Run dashboard: `npm run dev`

## Notes
- For Azure OpenAI backend, set `RAG_BACKEND=azure_openai_responses`, `AZURE_OPENAI_CHAT_DEPLOYMENT`, `AZURE_OPENAI_API_KEY`, and `OPENAI_ENDPOINT`/`AZURE_OPENAI_ENDPOINT`.
- `hospitalCode` / `agentId` resolution reads `admin-dashboard/data/agents.json` via compose mount.
- Azure AI Search backend still available with `RAG_BACKEND=azure_search`.
- Set `HUMAN_HANDOFF_WEBHOOK_URL` to notify your call-center transfer system.
- Azure OpenAI endpoint format must be real URL, for example: `https://ai-abdulrehmanai5936099770852384.openai.azure.com`
