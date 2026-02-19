const { MEDICAL_ADVICE_PATTERN, handoffMessageFor, sanitizeUserText, stripQueryNoiseTokens } = require("./policy");

const SYSTEM_POLICY = [
  "You are a callbot assistant for Near East University Hospital.",
  "You must answer ONLY from the uploaded hospital documents available through file search.",
  "Never invent facts and never use outside knowledge.",
  "If context is missing or unrelated, reply with transfer to human call center.",
  "If asked for treatment advice, diagnosis, medication, dosage, or clinical recommendations, reply with transfer.",
  "Reply in user's language (Turkish for Turkish users).",
  "Keep a calm and concise tone."
].join(" ");

const NO_CONTEXT_REPLY_PATTERN =
  /\b(i don't have|i do not have|outside my available information|out of scope|bilgim yok|kapsam(?:ımın)? dışında|bilgiye ulaşılamadı|bulunamadı|bulamadım|mevcut değil|dokümanda yer almıyor)\b/i;
const TRANSFER_REPLY_PATTERN = /\b(transfer|call center|çağrı merkezi|aktarıyorum|yönlendir(?:in|iyorum))\b/i;

function elapsedMs(start) {
  return Number((performance.now() - start).toFixed(2));
}

function combineSignalWithTimeout(signal, timeoutMs) {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([timeoutSignal, signal]) : timeoutSignal;
}

function parseSseEventBlock(block) {
  const lines = block.split(/\r?\n/);
  let eventType = "message";
  const dataLines = [];

  for (const line of lines) {
    if (line.startsWith("event:")) {
      eventType = line.slice(6).trim();
      continue;
    }

    if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trim());
    }
  }

  if (!dataLines.length) {
    return null;
  }

  const data = dataLines.join("\n").trim();
  if (!data) {
    return null;
  }

  if (data === "[DONE]") {
    return { eventType, done: true, json: null };
  }

  try {
    return {
      eventType,
      done: false,
      json: JSON.parse(data)
    };
  } catch {
    return {
      eventType,
      done: false,
      json: null
    };
  }
}

async function* readSseEvents(stream, signal) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      if (signal?.aborted) {
        throw signal.reason || new Error("Streaming aborted");
      }

      const { value, done } = await reader.read();
      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });

      while (true) {
        const separatorIndex = buffer.search(/\r?\n\r?\n/);
        if (separatorIndex === -1) {
          break;
        }

        const rawBlock = buffer.slice(0, separatorIndex);
        const separatorMatch = buffer.slice(separatorIndex).match(/^\r?\n\r?\n/);
        const separatorLength = separatorMatch ? separatorMatch[0].length : 2;
        buffer = buffer.slice(separatorIndex + separatorLength);

        const parsed = parseSseEventBlock(rawBlock);
        if (parsed) {
          yield parsed;
        }
      }
    }

    buffer += decoder.decode();
    const parsed = parseSseEventBlock(buffer.trim());
    if (parsed) {
      yield parsed;
    }
  } finally {
    reader.releaseLock();
  }
}

function extractOutputText(responseJson) {
  if (typeof responseJson?.output_text === "string" && responseJson.output_text.trim()) {
    return responseJson.output_text.trim();
  }

  const output = Array.isArray(responseJson?.output) ? responseJson.output : [];
  const collected = [];

  for (const item of output) {
    if (typeof item?.text === "string") {
      collected.push(item.text);
    }

    const content = Array.isArray(item?.content) ? item.content : [];
    for (const part of content) {
      if (typeof part?.text === "string") {
        collected.push(part.text);
      }
      if (typeof part?.output_text === "string") {
        collected.push(part.output_text);
      }
    }
  }

  return collected.join("\n").trim();
}

function cleanupAnswerText(value) {
  return String(value || "")
    .replace(/【[^】]*】/g, " ")
    .replace(/【[^】]*$/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractCitations(responseJson) {
  const refs = new Set();
  const output = Array.isArray(responseJson?.output) ? responseJson.output : [];

  const addRef = (value) => {
    if (value && String(value).trim()) {
      refs.add(String(value).trim());
    }
  };

  for (const item of output) {
    const content = Array.isArray(item?.content) ? item.content : [];
    for (const part of content) {
      const annotations = Array.isArray(part?.annotations) ? part.annotations : [];
      for (const annotation of annotations) {
        if (annotation?.type && annotation.type !== "file_citation") {
          continue;
        }
        addRef(annotation?.filename);
        addRef(annotation?.file_id);
      }
    }
  }

  return Array.from(refs).slice(0, 10);
}

class AzureOpenAIResponsesAssistant {
  constructor(config, logger) {
    this.config = config;
    this.logger = logger;
    this.cache = new Map();
    this.inflight = new Map();
  }

  cacheKey(vectorStoreId, text) {
    return `${vectorStoreId}::${text.toLowerCase()}`;
  }

  getCached(key) {
    const entry = this.cache.get(key);
    if (!entry) return null;
    if (Date.now() - entry.createdAt > this.config.AZURE_OPENAI_CACHE_TTL_MS) {
      this.cache.delete(key);
      return null;
    }
    return entry.value;
  }

  setCached(key, value) {
    if (this.config.AZURE_OPENAI_CACHE_TTL_MS <= 0) {
      return;
    }

    this.cache.set(key, {
      createdAt: Date.now(),
      value
    });

    while (this.cache.size > this.config.AZURE_OPENAI_CACHE_MAX_ENTRIES) {
      const oldestKey = this.cache.keys().next().value;
      this.cache.delete(oldestKey);
    }
  }

  buildRequestBody({ userText, history, vectorStoreId, stream = false }) {
    const historyTurns = (Array.isArray(history) ? history : [])
      .slice(-Math.min(this.config.MAX_HISTORY_TURNS, this.config.AZURE_OPENAI_HISTORY_TURNS) * 2)
      .map((m) => ({
        role: m.role === "assistant" ? "assistant" : "user",
        content: sanitizeUserText(m.content, 400)
      }));

    return {
      model: this.config.AZURE_OPENAI_CHAT_DEPLOYMENT,
      instructions: SYSTEM_POLICY,
      input: [...historyTurns, { role: "user", content: userText }],
      temperature: 0,
      max_output_tokens: this.config.AZURE_OPENAI_MAX_OUTPUT_TOKENS,
      stream,
      tools: [
        {
          type: "file_search",
          vector_store_ids: [vectorStoreId],
          max_num_results: this.config.AZURE_OPENAI_FILE_SEARCH_TOP_K
        }
      ]
    };
  }

  requestUrl() {
    const endpoint = this.config.AZURE_OPENAI_ENDPOINT.replace(/\/$/, "");
    return `${endpoint}/openai/responses?api-version=${encodeURIComponent(this.config.AZURE_OPENAI_RESPONSES_API_VERSION)}`;
  }

  async createResponse({ userText, history, vectorStoreId, signal }) {
    const response = await fetch(this.requestUrl(), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "api-key": this.config.AZURE_OPENAI_API_KEY
      },
      body: JSON.stringify(this.buildRequestBody({ userText, history, vectorStoreId, stream: false })),
      signal: combineSignalWithTimeout(signal, this.config.AZURE_OPENAI_REQUEST_TIMEOUT_MS)
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Azure OpenAI responses request failed (${response.status}): ${text.slice(0, 300)}`);
    }

    return response.json();
  }

  async createResponseStream({ userText, history, vectorStoreId, signal }) {
    const response = await fetch(this.requestUrl(), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "api-key": this.config.AZURE_OPENAI_API_KEY
      },
      body: JSON.stringify(this.buildRequestBody({ userText, history, vectorStoreId, stream: true })),
      signal: combineSignalWithTimeout(signal, this.config.AZURE_OPENAI_REQUEST_TIMEOUT_MS)
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Azure OpenAI streaming request failed (${response.status}): ${text.slice(0, 300)}`);
    }

    if (!response.body) {
      throw new Error("Azure OpenAI streaming request returned no response body");
    }

    return response.body;
  }

  async generateReply({ userText, history, vectorStoreId, bypassCache = false, debug = false }) {
    const totalStart = performance.now();
    const cleanStart = performance.now();
    const cleanText = sanitizeUserText(stripQueryNoiseTokens(userText), this.config.MAX_USER_TEXT_CHARS);
    const metrics = {
      cache_hit: false,
      cache_bypass: Boolean(bypassCache),
      inflight_joined: false,
      clean_ms: elapsedMs(cleanStart),
      azure_ms: null
    };

    const withDebug = (result) => {
      if (!debug) return result;
      return {
        ...result,
        debug: {
          ...metrics,
          total_ms: elapsedMs(totalStart)
        }
      };
    };

    if (!cleanText || MEDICAL_ADVICE_PATTERN.test(cleanText)) {
      return withDebug({
        decision: "handoff",
        reply: handoffMessageFor(cleanText || userText),
        citations: []
      });
    }

    if (!vectorStoreId) {
      return withDebug({
        decision: "handoff",
        reply: handoffMessageFor(cleanText),
        citations: []
      });
    }

    const key = this.cacheKey(vectorStoreId, cleanText);
    if (!bypassCache) {
      const cached = this.getCached(key);
      if (cached) {
        metrics.cache_hit = true;
        return withDebug(cached);
      }

      if (this.inflight.has(key)) {
        metrics.inflight_joined = true;
        const inflightResult = await this.inflight.get(key);
        return withDebug(inflightResult);
      }
    }

    const task = (async () => {
      let responseJson;
      try {
        const azureStart = performance.now();
        responseJson = await this.createResponse({ userText: cleanText, history, vectorStoreId });
        metrics.azure_ms = elapsedMs(azureStart);
      } catch (error) {
        metrics.azure_ms = metrics.azure_ms ?? 0;
        this.logger.error({ err: error }, "Azure OpenAI response generation failed");
        return {
          decision: "handoff",
          reply: handoffMessageFor(cleanText),
          citations: []
        };
      }

      const reply = sanitizeUserText(cleanupAnswerText(extractOutputText(responseJson)), 700);
      const citations = extractCitations(responseJson);

      if (!reply || MEDICAL_ADVICE_PATTERN.test(reply)) {
        return {
          decision: "handoff",
          reply: handoffMessageFor(cleanText),
          citations: []
        };
      }

      const looksLikeNoContext = NO_CONTEXT_REPLY_PATTERN.test(reply);
      const looksLikeTransferReply = TRANSFER_REPLY_PATTERN.test(reply);

      if (looksLikeNoContext || looksLikeTransferReply) {
        return {
          decision: "handoff",
          reply: handoffMessageFor(cleanText),
          citations: []
        };
      }

      return {
        decision: "answer",
        reply,
        citations
      };
    })();

    if (!bypassCache) {
      this.inflight.set(key, task);
    }

    try {
      const result = await task;
      if (!bypassCache && result?.decision === "answer") {
        this.setCached(key, result);
      }
      return withDebug(result);
    } finally {
      if (!bypassCache) {
        this.inflight.delete(key);
      }
    }
  }

  async generateReplyStream({ userText, history, vectorStoreId, signal, onRetrievalDone, onToken }) {
    const done = typeof onRetrievalDone === "function" ? onRetrievalDone : () => {};
    const token = typeof onToken === "function" ? onToken : () => {};

    const cleanText = sanitizeUserText(stripQueryNoiseTokens(userText), this.config.MAX_USER_TEXT_CHARS);
    if (!cleanText || MEDICAL_ADVICE_PATTERN.test(cleanText)) {
      done({ citations: [] });
      return {
        decision: "handoff",
        reply: handoffMessageFor(cleanText || userText),
        citations: []
      };
    }

    if (!vectorStoreId) {
      done({ citations: [] });
      return {
        decision: "handoff",
        reply: handoffMessageFor(cleanText),
        citations: []
      };
    }

    let retrievalDone = false;
    const markRetrievalDone = (citations = []) => {
      if (retrievalDone) {
        return;
      }
      retrievalDone = true;
      done({ citations });
    };

    let responseJson = null;
    let outputText = "";

    try {
      const stream = await this.createResponseStream({ userText: cleanText, history, vectorStoreId, signal });

      for await (const event of readSseEvents(stream, signal)) {
        if (event.done) {
          break;
        }

        const payload = event.json;
        if (!payload || typeof payload !== "object") {
          continue;
        }

        const eventType = payload.type || event.eventType;
        if (typeof eventType === "string" && eventType.includes("file_search") && /(?:done|completed)$/.test(eventType)) {
          markRetrievalDone([]);
          continue;
        }

        if (eventType === "response.output_text.delta") {
          markRetrievalDone([]);
          if (typeof payload.delta === "string" && payload.delta) {
            outputText += payload.delta;
            token(payload.delta);
          }
          continue;
        }

        if (eventType === "response.completed") {
          responseJson = payload.response || payload;
        }
      }
    } catch (error) {
      if (signal?.aborted) {
        throw error;
      }

      this.logger.error({ err: error }, "Azure OpenAI streaming response generation failed");
      markRetrievalDone([]);
      return {
        decision: "handoff",
        reply: handoffMessageFor(cleanText),
        citations: []
      };
    }

    markRetrievalDone([]);

    const streamReply = cleanupAnswerText(outputText);
    const finalReply = streamReply || extractOutputText(responseJson);
    const reply = sanitizeUserText(cleanupAnswerText(finalReply), 700);
    const citations = extractCitations(responseJson);

    if (!reply || MEDICAL_ADVICE_PATTERN.test(reply)) {
      return {
        decision: "handoff",
        reply: handoffMessageFor(cleanText),
        citations: []
      };
    }

    const looksLikeNoContext = NO_CONTEXT_REPLY_PATTERN.test(reply);
    const looksLikeTransferReply = TRANSFER_REPLY_PATTERN.test(reply);

    if (looksLikeNoContext || looksLikeTransferReply) {
      return {
        decision: "handoff",
        reply: handoffMessageFor(cleanText),
        citations: []
      };
    }

    return {
      decision: "answer",
      reply,
      citations
    };
  }
}

module.exports = { AzureOpenAIResponsesAssistant };
