const crypto = require("node:crypto");

const Fastify = require("fastify");
const helmet = require("@fastify/helmet");
const rateLimit = require("@fastify/rate-limit");
const websocket = require("@fastify/websocket");
const OpenAI = require("openai");
const WebSocket = require("ws");

const { config } = require("./config");
const { AzureSearchVectorClient } = require("./azure-search");
const { AssistantService } = require("./assistant");
const { AzureOpenAIResponsesAssistant } = require("./azure-openai-responses");
const { SessionStore } = require("./session-store");
const { notifyHandoff } = require("./handoff");
const { AgentDirectory } = require("./agent-directory");
const { setupSse, writeSseEvent, endSse } = require("./sse");

const MAX_WS_MESSAGE_BYTES = 1_000_000;
const MAX_AUDIO_BYTES = 512_000;
const DEFAULT_HANDOFF_REPLY =
  "This topic is outside my available information. I will transfer your call to a human call center agent.";

function parseJsonSafe(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function tokenFromAuthHeader(headerValue) {
  if (!headerValue || typeof headerValue !== "string") {
    return "";
  }

  const [scheme, token] = headerValue.split(" ");
  if (!scheme || !token || scheme.toLowerCase() !== "bearer") {
    return "";
  }

  return token;
}

function isSecureEqual(a, b) {
  const aBuf = Buffer.from(String(a || ""));
  const bBuf = Buffer.from(String(b || ""));
  if (aBuf.length !== bBuf.length) {
    return false;
  }

  return crypto.timingSafeEqual(aBuf, bBuf);
}

function parseBooleanFlag(value) {
  if (Array.isArray(value)) {
    return parseBooleanFlag(value[0]);
  }
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return value === 1;
  }
  if (typeof value !== "string") {
    return false;
  }

  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function elapsedMs(start) {
  return Number((performance.now() - start).toFixed(2));
}

function firstValue(value) {
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
}

function buildDeepgramUrl(baseUrl, extraParams = {}) {
  const url = new URL(baseUrl);
  for (const [key, value] of Object.entries(extraParams)) {
    if (value === undefined || value === null || value === "") {
      continue;
    }
    url.searchParams.set(key, String(value));
  }
  return url.toString();
}

function queryParamFromRequest(request, key) {
  const fromQuery = firstValue(request.query?.[key]);
  if (typeof fromQuery === "string" && fromQuery.length > 0) {
    return fromQuery;
  }

  try {
    const rawUrl = request.raw?.url || request.url || "";
    const parsed = new URL(rawUrl, "http://localhost");
    return parsed.searchParams.get(key) || "";
  } catch {
    return "";
  }
}

function closeWs(socket, code, reason) {
  if (!socket) return;

  if (typeof socket.close === "function") {
    socket.close(code, reason);
    return;
  }

  if (socket.socket && typeof socket.socket.close === "function") {
    socket.socket.close(code, reason);
    return;
  }

  if (typeof socket.end === "function") {
    socket.end();
  }
}

function resolveWsConnection(connection) {
  if (connection && typeof connection.send === "function" && typeof connection.on === "function") {
    return connection;
  }

  if (connection?.socket && typeof connection.socket.send === "function" && typeof connection.socket.on === "function") {
    return connection.socket;
  }

  if (
    connection?.websocket &&
    typeof connection.websocket.send === "function" &&
    typeof connection.websocket.on === "function"
  ) {
    return connection.websocket;
  }

  return connection?.socket || connection;
}

function normalizeWsRouteArgs(firstArg, secondArg) {
  const firstLooksLikeSocket = firstArg && typeof firstArg.send === "function" && typeof firstArg.on === "function";
  const secondLooksLikeSocket = secondArg && typeof secondArg.send === "function" && typeof secondArg.on === "function";

  if (firstLooksLikeSocket) {
    return {
      socket: resolveWsConnection(firstArg),
      request: secondArg
    };
  }

  if (secondLooksLikeSocket) {
    return {
      socket: resolveWsConnection(secondArg),
      request: firstArg
    };
  }

  return {
    socket: resolveWsConnection(firstArg),
    request: secondArg
  };
}

function createPhraseBuffer(onFlush, options = {}) {
  const minWords = Number.isInteger(options.minWords) ? options.minWords : 10;
  const maxWords = Number.isInteger(options.maxWords) ? options.maxWords : 20;
  let buffer = "";

  const countWords = (value) => {
    const trimmed = value.trim();
    if (!trimmed) return 0;
    return trimmed.split(/\s+/).length;
  };

  const flushWords = (wordCount) => {
    const words = buffer.trim().split(/\s+/);
    if (!words.length) {
      return;
    }

    const take = Math.min(wordCount, words.length);
    const head = words.slice(0, take).join(" ");
    const tail = words.slice(take).join(" ");

    buffer = tail ? `${tail} ` : "";
    onFlush(head);
  };

  return {
    push(chunk) {
      if (typeof chunk !== "string" || !chunk) {
        return;
      }

      buffer += chunk;
      const words = countWords(buffer);
      if (words < minWords) {
        return;
      }

      const shouldFlushEarly = /[.!?]\s$/.test(buffer);
      if (shouldFlushEarly || words >= maxWords) {
        flushWords(shouldFlushEarly ? words : maxWords);
      }
    },
    flush() {
      const words = countWords(buffer);
      if (words === 0) {
        return;
      }
      flushWords(words);
    }
  };
}

function buildServer() {
  const app = Fastify({
    logger: {
      level: config.LOG_LEVEL,
      redact: {
        paths: [
          "req.headers.authorization",
          "req.headers.x-callbot-token",
          "req.headers.api-key",
          "headers.authorization",
          "headers.api-key"
        ],
        censor: "[REDACTED]"
      }
    },
    bodyLimit: 128 * 1024,
    disableRequestLogging: false,
    requestTimeout: 15_000
  });

  let vectorClient = null;
  let assistant;

  if (config.RAG_BACKEND === "azure_search") {
    const openai = new OpenAI({
      apiKey: config.OPENAI_API_KEY,
      timeout: 12_000,
      maxRetries: 2
    });
    vectorClient = new AzureSearchVectorClient(config, openai);
    assistant = new AssistantService(config, openai, vectorClient, app.log);
  } else {
    assistant = new AzureOpenAIResponsesAssistant(config, app.log);
  }

  const sessionStore = new SessionStore(config.MAX_HISTORY_TURNS);
  const agentDirectory = new AgentDirectory(config.AGENTS_STORE_PATH, app.log);

  app.decorate("assistant", assistant);
  app.decorate("vectorClient", vectorClient);
  app.decorate("sessionStore", sessionStore);
  app.decorate("agentDirectory", agentDirectory);

  app.register(helmet, {
    global: true,
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false
  });

  app.register(rateLimit, {
    global: true,
    max: config.RATE_LIMIT_MAX,
    timeWindow: "1 minute",
    allowList: ["127.0.0.1", "::1"]
  });

  app.register(websocket, {
    options: {
      maxPayload: MAX_WS_MESSAGE_BYTES
    }
  });

  const requireApiToken = async (request, reply) => {
    const incoming = tokenFromAuthHeader(request.headers.authorization);

    if (!config.SERVICE_API_TOKEN || !isSecureEqual(incoming, config.SERVICE_API_TOKEN)) {
      reply.code(401);
      throw new Error("Unauthorized");
    }
  };

  app.get("/health", async () => ({ status: "ok", service: "callbot-node" }));
  app.get("/favicon.ico", async (_request, reply) => reply.code(204).send());

  const resolveVectorStoreId = async (body) => {
    if (body?.vectorStoreId) {
      return body.vectorStoreId;
    }

    const fromAgent = await app.agentDirectory.resolveVectorStoreId({
      agentId: body?.agentId,
      hospitalCode: body?.hospitalCode
    });

    return fromAgent || config.AZURE_OPENAI_VECTOR_STORE_ID || null;
  };

  app.post(
    "/api/search",
    {
      preHandler: requireApiToken,
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["text"],
          properties: {
            text: { type: "string", minLength: 1, maxLength: 2000 },
            topK: { type: "integer", minimum: 1, maximum: 20 },
            minScore: { type: "number", minimum: 0, maximum: 10 },
            agentId: { type: "string", minLength: 8, maxLength: 128 },
            hospitalCode: { type: "string", minLength: 2, maxLength: 64 },
            vectorStoreId: { type: "string", minLength: 3, maxLength: 128 }
          }
        }
      }
    },
    async (request, reply) => {
      if (!app.vectorClient) {
        reply.code(400);
        return {
          error: "RAG_BACKEND is not azure_search. Use /api/respond with vectorStoreId/agentId/hospitalCode."
        };
      }

      const queryText = request.body.text;
      const topK = request.body.topK ?? config.AZURE_SEARCH_TOP_K;
      const minScore = request.body.minScore ?? config.RAG_MIN_SCORE;

      try {
        const docs = await app.vectorClient.retrieve(queryText, { topK });
        const hits = docs
          .filter((doc) => Number.isFinite(doc.score) && doc.score >= minScore)
          .map((doc) => ({
            id: doc.id,
            title: doc.title,
            score: doc.score,
            content: doc.content.slice(0, 700)
          }));

        return {
          query: queryText,
          topK,
          minScore,
          totalHits: hits.length,
          hits
        };
      } catch (error) {
        app.log.error({ err: error }, "Search endpoint failed");
        reply.code(502);
        return {
          error: "Azure Search query failed"
        };
      }
    }
  );

  const respondBodySchema = {
    type: "object",
    additionalProperties: false,
    required: ["text"],
    properties: {
      text: { type: "string", minLength: 1, maxLength: 2000 },
      sessionId: { type: "string", minLength: 8, maxLength: 128 },
      agentId: { type: "string", minLength: 8, maxLength: 128 },
      hospitalCode: { type: "string", minLength: 2, maxLength: 64 },
      vectorStoreId: { type: "string", minLength: 3, maxLength: 128 },
      no_cache: { type: "string", maxLength: 8 }
    }
  };

  const respondQuerySchema = {
    type: "object",
    additionalProperties: false,
    required: ["text"],
    properties: {
      text: { type: "string", minLength: 1, maxLength: 2000 },
      sessionId: { type: "string", minLength: 8, maxLength: 128 },
      agentId: { type: "string", minLength: 8, maxLength: 128 },
      hospitalCode: { type: "string", minLength: 2, maxLength: 64 },
      vectorStoreId: { type: "string", minLength: 3, maxLength: 128 }
    }
  };

  const handleRespond = async (request, { debug = false, body = request.body } = {}) => {
    const sessionId = body.sessionId || crypto.randomUUID();
    const history = app.sessionStore.get(sessionId).history;
    const vectorStoreId = await resolveVectorStoreId(body);
    const bypassCache =
      parseBooleanFlag(request.headers["x-bypass-cache"]) || parseBooleanFlag(request.query?.no_cache);

    let result;
    try {
      result = await app.assistant.generateReply({
        userText: body.text,
        history,
        vectorStoreId,
        bypassCache,
        debug
      });
    } catch (error) {
      app.log.error({ err: error }, "Assistant generation failed");
      result = {
        decision: "handoff",
        reply: DEFAULT_HANDOFF_REPLY,
        citations: []
      };
    }

    app.sessionStore.addTurn(sessionId, "user", body.text);
    app.sessionStore.addTurn(sessionId, "assistant", result.reply);

    if (result.decision === "handoff") {
      await notifyHandoff(
        config,
        {
          sessionId,
          reason: "out_of_scope_or_policy",
          text: body.text,
          createdAt: new Date().toISOString()
        },
        app.log
      );
    }

    if (!debug) {
      return {
        sessionId,
        decision: result.decision,
        reply: result.reply,
        citations: result.citations
      };
    }

    return {
      sessionId,
      ...result
    };
  };

  const handleRespondStream = async (request, reply, { body }) => {
    const startedAt = performance.now();
    const sessionId = body.sessionId || crypto.randomUUID();
    const history = app.sessionStore.get(sessionId).history;
    const vectorStoreId = await resolveVectorStoreId(body);
    const bypassCache =
      parseBooleanFlag(request.headers["x-bypass-cache"]) || parseBooleanFlag(request.query?.no_cache);

    setupSse(reply);

    const abortController = new AbortController();
    let clientDisconnected = false;

    const onClientClose = () => {
      if (reply.raw.writableEnded) {
        return;
      }
      clientDisconnected = true;
      abortController.abort(new Error("Client disconnected"));
    };

    request.raw.on("aborted", onClientClose);
    request.raw.on("close", onClientClose);

    let retrievalDone = false;
    let retrievalMs = null;
    let llmFirstTokenMs = null;
    const retrievalStart = performance.now();

    const sendEvent = (eventName, payload) => {
      if (clientDisconnected || reply.raw.writableEnded || reply.raw.destroyed) {
        return;
      }
      writeSseEvent(reply, eventName, payload);
    };

    const markRetrievalDone = (citations = []) => {
      if (retrievalDone) {
        return;
      }
      retrievalDone = true;
      retrievalMs = elapsedMs(retrievalStart);
      sendEvent("retrieval", { status: "done", citations });
    };

    const phraseBuffer = createPhraseBuffer((text) => {
      if (llmFirstTokenMs === null) {
        llmFirstTokenMs = elapsedMs(startedAt);
      }
      sendEvent("token", { text });
    });

    sendEvent("meta", { sessionId });
    sendEvent("retrieval", { status: "start" });

    try {
      const result = await app.assistant.generateReplyStream({
        userText: body.text,
        history,
        vectorStoreId,
        bypassCache,
        signal: abortController.signal,
        onRetrievalDone: (payload) => {
          const citations = Array.isArray(payload?.citations) ? payload.citations : [];
          markRetrievalDone(citations);
        },
        onToken: (delta) => {
          if (!retrievalDone) {
            markRetrievalDone([]);
          }
          phraseBuffer.push(delta);
        }
      });

      if (!retrievalDone) {
        const citations = Array.isArray(result?.citations) ? result.citations : [];
        markRetrievalDone(citations);
      }

      phraseBuffer.flush();

      app.sessionStore.addTurn(sessionId, "user", body.text);
      app.sessionStore.addTurn(sessionId, "assistant", result.reply);

      if (result.decision === "handoff") {
        await notifyHandoff(
          config,
          {
            sessionId,
            reason: "out_of_scope_or_policy",
            text: body.text,
            createdAt: new Date().toISOString()
          },
          app.log
        );
      }

      sendEvent("final", {
        decision: result.decision,
        reply: result.reply,
        citations: result.citations
      });

      app.log.info(
        {
          sessionId,
          retrieval_ms: retrievalMs,
          llm_first_token_ms: llmFirstTokenMs,
          total_ms: elapsedMs(startedAt)
        },
        "Respond stream completed"
      );
    } catch (error) {
      if (abortController.signal.aborted || clientDisconnected) {
        app.log.info(
          {
            sessionId,
            retrieval_ms: retrievalMs,
            llm_first_token_ms: llmFirstTokenMs,
            total_ms: elapsedMs(startedAt)
          },
          "Respond stream aborted"
        );
      } else {
        app.log.error({ err: error }, "Respond stream failed");

        if (!retrievalDone) {
          markRetrievalDone([]);
        }

        const fallback = {
          decision: "handoff",
          reply: DEFAULT_HANDOFF_REPLY,
          citations: []
        };

        app.sessionStore.addTurn(sessionId, "user", body.text);
        app.sessionStore.addTurn(sessionId, "assistant", fallback.reply);
        await notifyHandoff(
          config,
          {
            sessionId,
            reason: "out_of_scope_or_policy",
            text: body.text,
            createdAt: new Date().toISOString()
          },
          app.log
        );

        sendEvent("final", fallback);
      }
    } finally {
      request.raw.off("aborted", onClientClose);
      request.raw.off("close", onClientClose);
      endSse(reply);
    }
  };

  app.post(
    "/api/respond",
    {
      preHandler: requireApiToken,
      schema: {
        body: respondBodySchema
      }
    },
    async (request, reply) => {
      if (parseBooleanFlag(request.headers["x-stream"])) {
        await handleRespondStream(request, reply, { body: request.body });
        return reply;
      }

      return handleRespond(request, { debug: false, body: request.body });
    }
  );

  // Quick test:
  // curl -N -H "Authorization: Bearer $SERVICE_API_TOKEN" \
  //   "http://localhost:8765/api/respond/stream?text=What+are+the+visiting+hours%3F"
  app.get(
    "/api/respond/stream",
    {
      preHandler: requireApiToken,
      schema: {
        querystring: respondQuerySchema
      }
    },
    async (request, reply) => {
      await handleRespondStream(request, reply, { body: request.query });
      return reply;
    }
  );

  app.post(
    "/api/respond/debug",
    {
      preHandler: requireApiToken,
      schema: {
        body: respondBodySchema
      }
    },
    async (request) => handleRespond(request, { debug: true })
  );

  app.get("/deepgram-test", async (_request, reply) => {
    reply.type("text/html");
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Deepgram Streaming Test</title>
  <style>
    body { font-family: Arial, sans-serif; margin: 24px; line-height: 1.4; }
    .row { display: flex; gap: 8px; margin-bottom: 10px; flex-wrap: wrap; }
    input, button { padding: 8px; font-size: 14px; }
    input { min-width: 280px; }
    #events { white-space: pre-wrap; border: 1px solid #ddd; padding: 12px; height: 320px; overflow: auto; background: #fafafa; }
    #live { white-space: pre-wrap; border: 1px solid #ddd; padding: 12px; height: 100px; overflow: auto; background: #fff; }
  </style>
</head>
<body>
  <h2>Deepgram + Assistant Streaming Test</h2>
  <p>Use this page to test microphone -> Deepgram -> assistant streaming without Twilio.</p>
  <div class="row">
    <input id="token" placeholder="INBOUND_WS_AUTH_TOKEN">
    <input id="vectorStoreId" placeholder="Vector Store ID (optional)">
  </div>
  <div class="row">
    <button id="startBtn">Start Mic</button>
    <button id="stopBtn" disabled>Stop</button>
    <button id="clearBtn">Clear Logs</button>
  </div>
  <p><strong>Live assistant stream:</strong></p>
  <div id="live"></div>
  <p><strong>Event log:</strong></p>
  <div id="events"></div>
<script>
  const eventsEl = document.getElementById("events");
  const liveEl = document.getElementById("live");
  const tokenEl = document.getElementById("token");
  const vectorStoreIdEl = document.getElementById("vectorStoreId");
  const startBtn = document.getElementById("startBtn");
  const stopBtn = document.getElementById("stopBtn");
  const clearBtn = document.getElementById("clearBtn");

  let ws = null;
  let stream = null;
  let audioContext = null;
  let sourceNode = null;
  let processorNode = null;
  let muteNode = null;

  const defaultVectorStoreId = ${JSON.stringify(config.AZURE_OPENAI_VECTOR_STORE_ID || "")};
  vectorStoreIdEl.value = defaultVectorStoreId;
  tokenEl.value = localStorage.getItem("dg_test_token") || "";

  function log(line) {
    const timestamp = new Date().toISOString();
    eventsEl.textContent += "[" + timestamp + "] " + line + "\\n";
    eventsEl.scrollTop = eventsEl.scrollHeight;
  }

  function downsampleToInt16(float32, inputRate, outputRate) {
    if (outputRate >= inputRate) {
      const out = new Int16Array(float32.length);
      for (let i = 0; i < float32.length; i += 1) {
        const s = Math.max(-1, Math.min(1, float32[i]));
        out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
      }
      return out;
    }

    const ratio = inputRate / outputRate;
    const newLength = Math.round(float32.length / ratio);
    const out = new Int16Array(newLength);
    let outOffset = 0;
    let inOffset = 0;

    while (outOffset < out.length) {
      const nextInOffset = Math.round((outOffset + 1) * ratio);
      let sum = 0;
      let count = 0;
      for (let i = inOffset; i < nextInOffset && i < float32.length; i += 1) {
        sum += float32[i];
        count += 1;
      }
      const sample = count > 0 ? sum / count : 0;
      const clipped = Math.max(-1, Math.min(1, sample));
      out[outOffset] = clipped < 0 ? clipped * 0x8000 : clipped * 0x7fff;
      outOffset += 1;
      inOffset = nextInOffset;
    }

    return out;
  }

  async function startMic() {
    const token = tokenEl.value.trim();
    if (!token) {
      alert("Enter INBOUND_WS_AUTH_TOKEN first.");
      return;
    }

    localStorage.setItem("dg_test_token", token);
    const vectorStoreId = vectorStoreIdEl.value.trim();
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = new URL(protocol + "//" + window.location.host + "/deepgram-browser");
    wsUrl.searchParams.set("token", token);
    if (vectorStoreId) {
      wsUrl.searchParams.set("vectorStoreId", vectorStoreId);
    }

    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    audioContext = new (window.AudioContext || window.webkitAudioContext)();
    sourceNode = audioContext.createMediaStreamSource(stream);
    processorNode = audioContext.createScriptProcessor(4096, 1, 1);
    muteNode = audioContext.createGain();
    muteNode.gain.value = 0;

    ws = new WebSocket(wsUrl);
    ws.binaryType = "arraybuffer";

    ws.onopen = () => {
      log("WebSocket connected");
      ws.send(JSON.stringify({ event: "start" }));
    };

    ws.onmessage = (event) => {
      let parsed = null;
      try {
        parsed = JSON.parse(event.data);
      } catch {
        log("raw: " + String(event.data));
        return;
      }

      if (parsed.event === "assistant_token" && parsed.text) {
        liveEl.textContent += parsed.text + " ";
      }

      if (parsed.event === "assistant_response") {
        liveEl.textContent = "";
      }

      log(JSON.stringify(parsed));
    };

    ws.onerror = () => {
      log("WebSocket error");
    };

    ws.onclose = () => {
      log("WebSocket closed");
      stopMic();
    };

    processorNode.onaudioprocess = (evt) => {
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        return;
      }
      const input = evt.inputBuffer.getChannelData(0);
      const pcm = downsampleToInt16(input, audioContext.sampleRate, 16000);
      ws.send(pcm.buffer);
    };

    sourceNode.connect(processorNode);
    processorNode.connect(muteNode);
    muteNode.connect(audioContext.destination);

    startBtn.disabled = true;
    stopBtn.disabled = false;
  }

  async function stopMic() {
    startBtn.disabled = false;
    stopBtn.disabled = true;

    if (processorNode) {
      processorNode.disconnect();
      processorNode.onaudioprocess = null;
      processorNode = null;
    }
    if (sourceNode) {
      sourceNode.disconnect();
      sourceNode = null;
    }
    if (muteNode) {
      muteNode.disconnect();
      muteNode = null;
    }
    if (audioContext) {
      await audioContext.close();
      audioContext = null;
    }
    if (stream) {
      for (const track of stream.getTracks()) {
        track.stop();
      }
      stream = null;
    }
    if (ws) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ event: "stop" }));
      }
      ws.close();
      ws = null;
    }
  }

  startBtn.addEventListener("click", () => startMic().catch((err) => log("start failed: " + err.message)));
  stopBtn.addEventListener("click", () => stopMic().catch((err) => log("stop failed: " + err.message)));
  clearBtn.addEventListener("click", () => {
    eventsEl.textContent = "";
    liveEl.textContent = "";
  });
</script>
</body>
</html>`;
  });

  app.after(() => {
    app.get(
      "/deepgram-browser",
      { websocket: true },
      (firstArg, secondArg) => {
        const { socket, request } = normalizeWsRouteArgs(firstArg, secondArg);
        try {
          const queryToken = queryParamFromRequest(request, "token");
          const headerToken = firstValue(request.headers["x-callbot-token"]);
          const incomingToken = queryToken || headerToken;

          if (!config.INBOUND_WS_AUTH_TOKEN || !isSecureEqual(incomingToken, config.INBOUND_WS_AUTH_TOKEN)) {
            closeWs(socket, 1008, "Unauthorized websocket token");
            return;
          }

          if (!config.DEEPGRAM_API_KEY) {
            closeWs(socket, 1011, "Deepgram key missing");
            return;
          }

          const sessionId = crypto.randomUUID();
          const vectorStoreId =
            queryParamFromRequest(request, "vectorStoreId") || config.AZURE_OPENAI_VECTOR_STORE_ID || null;
          const deepgramListenUrl = buildDeepgramUrl(config.DEEPGRAM_LISTEN_URL, {
            encoding: "linear16",
            sample_rate: 16000,
            channels: 1,
            interim_results: true,
            punctuate: true
          });

      const deepgramSocket = new WebSocket(deepgramListenUrl, {
        headers: {
          Authorization: `Token ${config.DEEPGRAM_API_KEY}`
        },
        handshakeTimeout: 7_000,
        maxPayload: MAX_WS_MESSAGE_BYTES
      });

      let closed = false;
      let queue = Promise.resolve();
      let activeReplyAbortController = null;

      const sendSocketEvent = (payload) => {
        if (socket.readyState !== WebSocket.OPEN) {
          return;
        }

        socket.send(JSON.stringify(payload));
      };

      const safeClose = () => {
        if (closed) return;
        closed = true;

        if (activeReplyAbortController) {
          activeReplyAbortController.abort(new Error("Websocket closed"));
          activeReplyAbortController = null;
        }

        if (deepgramSocket.readyState === WebSocket.OPEN || deepgramSocket.readyState === WebSocket.CONNECTING) {
          deepgramSocket.close();
        }

        if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
          closeWs(socket);
        }
      };

      const handleTranscript = async (transcript) => {
        const startedAt = performance.now();
        app.sessionStore.addTurn(sessionId, "user", transcript);
        const history = app.sessionStore.get(sessionId).history;
        let retrievalDone = false;
        let retrievalMs = null;
        let llmFirstTokenMs = null;
        const retrievalStart = performance.now();

        const markRetrievalDone = (citations = []) => {
          if (retrievalDone) {
            return;
          }
          retrievalDone = true;
          retrievalMs = elapsedMs(retrievalStart);
          sendSocketEvent({
            event: "assistant_retrieval",
            sessionId,
            status: "done",
            citations
          });
        };

        const phraseBuffer = createPhraseBuffer((text) => {
          if (llmFirstTokenMs === null) {
            llmFirstTokenMs = elapsedMs(startedAt);
          }

          sendSocketEvent({
            event: "assistant_token",
            sessionId,
            text
          });
        });

        sendSocketEvent({
          event: "assistant_retrieval",
          sessionId,
          status: "start"
        });

        let result;
        activeReplyAbortController = new AbortController();
        try {
          result = await app.assistant.generateReplyStream({
            userText: transcript,
            history,
            vectorStoreId,
            signal: activeReplyAbortController.signal,
            onRetrievalDone: (payload) => {
              const citations = Array.isArray(payload?.citations) ? payload.citations : [];
              markRetrievalDone(citations);
            },
            onToken: (delta) => {
              if (!retrievalDone) {
                markRetrievalDone([]);
              }
              phraseBuffer.push(delta);
            }
          });
        } catch (error) {
          if (activeReplyAbortController.signal.aborted) {
            return;
          }

          app.log.error({ err: error }, "Assistant failed during deepgram browser session");
          result = {
            decision: "handoff",
            reply: DEFAULT_HANDOFF_REPLY,
            citations: []
          };
        } finally {
          activeReplyAbortController = null;
        }

        if (!retrievalDone) {
          const citations = Array.isArray(result?.citations) ? result.citations : [];
          markRetrievalDone(citations);
        }
        phraseBuffer.flush();

        app.sessionStore.addTurn(sessionId, "assistant", result.reply);

        sendSocketEvent({
          event: "assistant_response",
          sessionId,
          decision: result.decision,
          text: result.reply,
          citations: result.citations
        });
        sendSocketEvent({
          event: "assistant_metrics",
          sessionId,
          retrieval_ms: retrievalMs,
          llm_first_token_ms: llmFirstTokenMs,
          total_ms: elapsedMs(startedAt)
        });
        app.log.info(
          {
            sessionId,
            retrieval_ms: retrievalMs,
            llm_first_token_ms: llmFirstTokenMs,
            total_ms: elapsedMs(startedAt)
          },
          "Deepgram browser assistant response completed"
        );

        if (result.decision === "handoff") {
          await notifyHandoff(
            config,
            {
              sessionId,
              reason: "out_of_scope_or_policy",
              text: transcript,
              createdAt: new Date().toISOString()
            },
            app.log
          );
        }
      };

      deepgramSocket.on("open", () => {
        sendSocketEvent({
          event: "ready",
          sessionId
        });
      });

      deepgramSocket.on("message", (raw) => {
        const parsed = parseJsonSafe(raw.toString("utf8"));
        if (!parsed) return;

        const transcript = parsed?.channel?.alternatives?.[0]?.transcript?.trim();
        const isFinal = Boolean(parsed.is_final || parsed.speech_final);

        if (!transcript) {
          return;
        }

        sendSocketEvent({
          event: isFinal ? "transcript_final" : "transcript_partial",
          sessionId,
          text: transcript
        });

        if (!isFinal) {
          return;
        }

        queue = queue
          .then(() => handleTranscript(transcript))
          .catch((error) => {
            app.log.error({ err: error }, "Deepgram browser transcript queue failed");
          });
      });

      deepgramSocket.on("error", (error) => {
        app.log.error({ err: error }, "Deepgram browser websocket error");
        safeClose();
      });

      deepgramSocket.on("close", () => {
        safeClose();
      });

      socket.on("message", (raw, isBinary) => {
        if (isBinary) {
          if (raw.length > MAX_AUDIO_BYTES || deepgramSocket.readyState !== WebSocket.OPEN) {
            return;
          }
          deepgramSocket.send(raw);
          return;
        }

        const message = raw.toString("utf8");
        if (Buffer.byteLength(message, "utf8") > MAX_WS_MESSAGE_BYTES) {
          closeWs(socket, 1009, "Message too large");
          return;
        }

        const parsed = parseJsonSafe(message);
        if (!parsed || typeof parsed !== "object") {
          return;
        }

        if (parsed.event === "audio" && deepgramSocket.readyState === WebSocket.OPEN) {
          const payload = parsed.audio;
          if (typeof payload !== "string" || payload.length > MAX_WS_MESSAGE_BYTES) {
            return;
          }

          const audio = Buffer.from(payload, "base64");
          if (!audio.length || audio.length > MAX_AUDIO_BYTES) {
            return;
          }

          deepgramSocket.send(audio);
          return;
        }

        if (parsed.event === "stop") {
          safeClose();
        }
      });

          socket.on("error", (error) => {
            app.log.error({ err: error }, "Deepgram browser inbound websocket error");
            safeClose();
          });

          socket.on("close", () => {
            safeClose();
          });
        } catch (error) {
          app.log.error({ err: error }, "Deepgram browser websocket setup failed");
          closeWs(socket, 1011, "Internal websocket setup error");
        }
      }
    );

    app.get(
      "/twilio-media",
      { websocket: true },
      (firstArg, secondArg) => {
        const { socket, request } = normalizeWsRouteArgs(firstArg, secondArg);
        try {
          const incomingToken = request.headers["x-callbot-token"];
          const headerToken = Array.isArray(incomingToken) ? incomingToken[0] : incomingToken;

      if (!config.INBOUND_WS_AUTH_TOKEN || !isSecureEqual(headerToken, config.INBOUND_WS_AUTH_TOKEN)) {
        closeWs(socket, 1008, "Unauthorized websocket token");
        return;
      }

      if (!config.DEEPGRAM_API_KEY) {
        closeWs(socket, 1011, "Deepgram key missing");
        return;
      }

      const sessionId = crypto.randomUUID();
      let streamSid = "";
      const defaultVectorStoreId = config.AZURE_OPENAI_VECTOR_STORE_ID || null;

      const deepgramSocket = new WebSocket(config.DEEPGRAM_LISTEN_URL, {
        headers: {
          Authorization: `Token ${config.DEEPGRAM_API_KEY}`
        },
        handshakeTimeout: 7_000,
        maxPayload: MAX_WS_MESSAGE_BYTES
      });

      let closed = false;
      let queue = Promise.resolve();
      let activeReplyAbortController = null;

      const sendSocketEvent = (payload) => {
        if (socket.readyState !== WebSocket.OPEN) {
          return;
        }

        socket.send(JSON.stringify(payload));
      };

      const safeClose = () => {
        if (closed) return;
        closed = true;

        if (activeReplyAbortController) {
          activeReplyAbortController.abort(new Error("Websocket closed"));
          activeReplyAbortController = null;
        }

        if (deepgramSocket.readyState === WebSocket.OPEN || deepgramSocket.readyState === WebSocket.CONNECTING) {
          deepgramSocket.close();
        }

        if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
          closeWs(socket);
        }
      };

      const handleTranscript = async (transcript) => {
        const startedAt = performance.now();
        app.sessionStore.addTurn(sessionId, "user", transcript);
        const history = app.sessionStore.get(sessionId).history;
        let retrievalDone = false;
        let retrievalMs = null;
        let llmFirstTokenMs = null;
        const retrievalStart = performance.now();

        const markRetrievalDone = (citations = []) => {
          if (retrievalDone) {
            return;
          }
          retrievalDone = true;
          retrievalMs = elapsedMs(retrievalStart);
          sendSocketEvent({
            event: "assistant_retrieval",
            streamSid,
            sessionId,
            status: "done",
            citations
          });
        };

        const phraseBuffer = createPhraseBuffer((text) => {
          if (llmFirstTokenMs === null) {
            llmFirstTokenMs = elapsedMs(startedAt);
          }

          sendSocketEvent({
            event: "assistant_token",
            streamSid,
            sessionId,
            text
          });
        });

        sendSocketEvent({
          event: "assistant_retrieval",
          streamSid,
          sessionId,
          status: "start"
        });

        let result;
        activeReplyAbortController = new AbortController();
        try {
          result = await app.assistant.generateReplyStream({
            userText: transcript,
            history,
            vectorStoreId: defaultVectorStoreId,
            signal: activeReplyAbortController.signal,
            onRetrievalDone: (payload) => {
              const citations = Array.isArray(payload?.citations) ? payload.citations : [];
              markRetrievalDone(citations);
            },
            onToken: (delta) => {
              if (!retrievalDone) {
                markRetrievalDone([]);
              }
              phraseBuffer.push(delta);
            }
          });
        } catch (error) {
          if (activeReplyAbortController.signal.aborted) {
            return;
          }

          app.log.error({ err: error }, "Assistant failed during websocket session");
          result = {
            decision: "handoff",
            reply: DEFAULT_HANDOFF_REPLY,
            citations: []
          };
        } finally {
          activeReplyAbortController = null;
        }

        if (!retrievalDone) {
          const citations = Array.isArray(result?.citations) ? result.citations : [];
          markRetrievalDone(citations);
        }
        phraseBuffer.flush();

        app.sessionStore.addTurn(sessionId, "assistant", result.reply);

        sendSocketEvent({
          event: "assistant_response",
          streamSid,
          sessionId,
          decision: result.decision,
          text: result.reply,
          citations: result.citations
        });
        sendSocketEvent({
          event: "assistant_metrics",
          streamSid,
          sessionId,
          retrieval_ms: retrievalMs,
          llm_first_token_ms: llmFirstTokenMs,
          total_ms: elapsedMs(startedAt)
        });

        app.log.info(
          {
            sessionId,
            streamSid,
            retrieval_ms: retrievalMs,
            llm_first_token_ms: llmFirstTokenMs,
            total_ms: elapsedMs(startedAt)
          },
          "Websocket assistant response completed"
        );

        if (result.decision === "handoff") {
          if (socket.readyState === WebSocket.OPEN && streamSid) {
            socket.send(
              JSON.stringify({
                event: "mark",
                streamSid,
                mark: { name: "transfer_to_human" }
              })
            );
          }

          await notifyHandoff(
            config,
            {
              sessionId,
              streamSid,
              reason: "out_of_scope_or_policy",
              text: transcript,
              createdAt: new Date().toISOString()
            },
            app.log
          );
        }
      };

      deepgramSocket.on("message", (raw) => {
        const parsed = parseJsonSafe(raw.toString("utf8"));
        if (!parsed) return;

        const transcript = parsed?.channel?.alternatives?.[0]?.transcript?.trim();
        const isFinal = Boolean(parsed.is_final || parsed.speech_final);

        if (!isFinal || !transcript) {
          return;
        }

        queue = queue
          .then(() => handleTranscript(transcript))
          .catch((error) => {
            app.log.error({ err: error }, "Transcript queue failed");
          });
      });

      deepgramSocket.on("error", (error) => {
        app.log.error({ err: error }, "Deepgram websocket error");
        safeClose();
      });

      deepgramSocket.on("close", () => {
        safeClose();
      });

      socket.on("message", (raw, isBinary) => {
        if (isBinary) {
          return;
        }

        const message = raw.toString("utf8");
        if (Buffer.byteLength(message, "utf8") > MAX_WS_MESSAGE_BYTES) {
          closeWs(socket, 1009, "Message too large");
          return;
        }

        const parsed = parseJsonSafe(message);
        if (!parsed || typeof parsed !== "object") {
          return;
        }

        if (parsed.event === "start") {
          streamSid = parsed.start?.streamSid || streamSid;
          return;
        }

        if (parsed.event === "media" && deepgramSocket.readyState === WebSocket.OPEN) {
          const payload = parsed.media?.payload;
          if (typeof payload !== "string" || payload.length > MAX_WS_MESSAGE_BYTES) {
            return;
          }

          const audio = Buffer.from(payload, "base64");
          if (!audio.length || audio.length > MAX_AUDIO_BYTES) {
            return;
          }

          deepgramSocket.send(audio);
          return;
        }

        if (parsed.event === "stop") {
          safeClose();
        }
      });

      socket.on("error", (error) => {
        app.log.error({ err: error }, "Inbound websocket error");
        safeClose();
      });

          socket.on("close", () => {
            safeClose();
          });
        } catch (error) {
          app.log.error({ err: error }, "Twilio websocket setup failed");
          closeWs(socket, 1011, "Internal websocket setup error");
        }
      }
    );
  });

  app.addHook("onClose", async () => {
    app.sessionStore.close();
  });

  return app;
}

module.exports = { buildServer };
