const { MEDICAL_ADVICE_PATTERN, handoffMessageFor, sanitizeUserText, stripQueryNoiseTokens } = require("./policy");

const SYSTEM_POLICY = [
  "You are a callbot assistant for Near East University Hospital.",
  "Answer ONLY using the provided knowledge snippets.",
  "Never invent facts, never use outside knowledge.",
  "If the user asks for medical treatment advice, diagnosis, medication, dosage, or any clinical recommendation, choose handoff.",
  "If the snippets are insufficient or unrelated, choose handoff.",
  "When answering, be concise, calm, and non-alarmist.",
  "Reply in the same language as the user (Turkish if the user writes/speaks Turkish).",
  "If handoff is needed, reply that the call will be transferred to a human call center agent.",
  "Output only valid JSON with fields: decision, reply, citations."
].join(" ");

const SYSTEM_POLICY_STREAM = [
  "You are a callbot assistant for Near East University Hospital.",
  "Answer ONLY using the provided knowledge snippets.",
  "Never invent facts, never use outside knowledge.",
  "If the snippets are insufficient or unrelated, say you will transfer to a human call center agent.",
  "If the user asks for medical treatment advice, diagnosis, medication, dosage, or any clinical recommendation, say you will transfer.",
  "When answering, be concise, calm, and non-alarmist.",
  "Reply in the same language as the user (Turkish if the user writes/speaks Turkish).",
  "Output only the assistant reply text. Do not output JSON."
].join(" ");

const NO_CONTEXT_REPLY_PATTERN =
  /\b(i don't have|i do not have|outside my available information|out of scope|bilgim yok|kapsam(?:ımın)? dışında|bilgiye ulaşılamadı|bulunamadı|bulamadım|mevcut değil|dokümanda yer almıyor)\b/i;
const TRANSFER_REPLY_PATTERN = /\b(transfer|call center|çağrı merkezi|aktarıyorum|yönlendir(?:in|iyorum))\b/i;

function elapsedMs(start) {
  return Number((performance.now() - start).toFixed(2));
}

class AssistantService {
  constructor(config, openai, vectorClient, logger) {
    this.config = config;
    this.openai = openai;
    this.vectorClient = vectorClient;
    this.logger = logger;
  }

  buildContext(docs) {
    return docs
      .map((doc, index) => {
        const clippedContent = doc.content.slice(0, 1200);
        return `[${index + 1}] id=${doc.id} | title=${doc.title} | score=${doc.score.toFixed(3)}\n${clippedContent}`;
      })
      .join("\n\n");
  }

  buildPromptInput(cleanText, history, filteredDocs) {
    const safeHistory = (Array.isArray(history) ? history : [])
      .slice(-this.config.MAX_HISTORY_TURNS * 2)
      .map((m) => `${m.role}: ${sanitizeUserText(m.content, 400)}`)
      .join("\n");

    const context = this.buildContext(filteredDocs);
    return [
      `Conversation history:\n${safeHistory || "(empty)"}`,
      `Knowledge snippets:\n${context}`,
      `User message:\n${cleanText}`,
      "If answer is not fully grounded in snippets, choose handoff."
    ].join("\n\n");
  }

  async generateReply({ userText, history, debug = false }) {
    const totalStart = performance.now();
    const cleanStart = performance.now();
    const cleanText = sanitizeUserText(stripQueryNoiseTokens(userText), this.config.MAX_USER_TEXT_CHARS);
    const metrics = {
      cache_hit: false,
      cache_bypass: false,
      inflight_joined: false,
      clean_ms: elapsedMs(cleanStart),
      retrieve_ms: null,
      openai_ms: null
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

    if (!cleanText) {
      return withDebug({
        decision: "handoff",
        reply: handoffMessageFor(userText),
        citations: []
      });
    }

    if (MEDICAL_ADVICE_PATTERN.test(cleanText)) {
      return withDebug({
        decision: "handoff",
        reply: handoffMessageFor(cleanText),
        citations: []
      });
    }

    let docs = [];
    try {
      const retrieveStart = performance.now();
      docs = await this.vectorClient.retrieve(cleanText);
      metrics.retrieve_ms = elapsedMs(retrieveStart);
    } catch (error) {
      this.logger.error({ err: error }, "Vector retrieval failed");
      return withDebug({
        decision: "handoff",
        reply: handoffMessageFor(cleanText),
        citations: []
      });
    }

    const filteredDocs = docs
      .filter((d) => Number.isFinite(d.score) && d.score >= this.config.RAG_MIN_SCORE)
      .slice(0, this.config.AZURE_SEARCH_TOP_K);

    if (!filteredDocs.length) {
      return withDebug({
        decision: "handoff",
        reply: handoffMessageFor(cleanText),
        citations: []
      });
    }

    const promptInput = this.buildPromptInput(cleanText, history, filteredDocs);

    const openAiStart = performance.now();
    const completion = await this.openai.chat.completions.create({
      model: this.config.OPENAI_MODEL,
      temperature: 0.1,
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "hospital_callbot_response",
          strict: true,
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              decision: {
                type: "string",
                enum: ["answer", "handoff"]
              },
              reply: {
                type: "string"
              },
              citations: {
                type: "array",
                items: {
                  type: "string"
                }
              }
            },
            required: ["decision", "reply", "citations"]
          }
        }
      },
      messages: [
        {
          role: "system",
          content: SYSTEM_POLICY
        },
        {
          role: "user",
          content: promptInput
        }
      ]
    });
    metrics.openai_ms = elapsedMs(openAiStart);

    const raw = completion.choices?.[0]?.message?.content ?? "";
    let parsed;

    try {
      parsed = JSON.parse(raw);
    } catch {
      return withDebug({
        decision: "handoff",
        reply: handoffMessageFor(cleanText),
        citations: []
      });
    }

    const allowedIds = new Set(filteredDocs.map((d) => d.id));
    const citations = Array.isArray(parsed.citations)
      ? parsed.citations.map((v) => String(v)).filter((id) => allowedIds.has(id))
      : [];

    const reply = sanitizeUserText(parsed.reply, 700);

    if (parsed.decision !== "answer" || !reply || citations.length === 0) {
      return withDebug({
        decision: "handoff",
        reply: handoffMessageFor(cleanText),
        citations: []
      });
    }

    if (MEDICAL_ADVICE_PATTERN.test(reply)) {
      return withDebug({
        decision: "handoff",
        reply: handoffMessageFor(cleanText),
        citations: []
      });
    }

    return withDebug({
      decision: "answer",
      reply,
      citations
    });
  }

  async generateReplyStream({ userText, history, signal, onRetrievalDone, onToken }) {
    const done = typeof onRetrievalDone === "function" ? onRetrievalDone : () => {};
    const token = typeof onToken === "function" ? onToken : () => {};

    const cleanText = sanitizeUserText(stripQueryNoiseTokens(userText), this.config.MAX_USER_TEXT_CHARS);
    if (!cleanText) {
      done({ citations: [] });
      return {
        decision: "handoff",
        reply: handoffMessageFor(userText),
        citations: []
      };
    }

    if (MEDICAL_ADVICE_PATTERN.test(cleanText)) {
      done({ citations: [] });
      return {
        decision: "handoff",
        reply: handoffMessageFor(cleanText),
        citations: []
      };
    }

    let docs = [];
    try {
      docs = await this.vectorClient.retrieve(cleanText, { signal });
    } catch (error) {
      if (signal?.aborted) {
        throw error;
      }
      this.logger.error({ err: error }, "Vector retrieval failed");
      done({ citations: [] });
      return {
        decision: "handoff",
        reply: handoffMessageFor(cleanText),
        citations: []
      };
    }

    const filteredDocs = docs
      .filter((d) => Number.isFinite(d.score) && d.score >= this.config.RAG_MIN_SCORE)
      .slice(0, this.config.AZURE_SEARCH_TOP_K);

    const retrievalCitations = filteredDocs.map((doc) => doc.id);
    done({ citations: retrievalCitations });

    if (!filteredDocs.length) {
      return {
        decision: "handoff",
        reply: handoffMessageFor(cleanText),
        citations: []
      };
    }

    const promptInput = this.buildPromptInput(cleanText, history, filteredDocs);
    let outputText = "";

    try {
      const stream = await this.openai.chat.completions.create({
        model: this.config.OPENAI_MODEL,
        temperature: 0.1,
        stream: true,
        messages: [
          {
            role: "system",
            content: SYSTEM_POLICY_STREAM
          },
          {
            role: "user",
            content: promptInput
          }
        ]
      }, {
        signal
      });

      for await (const chunk of stream) {
        if (signal?.aborted) {
          throw signal.reason || new Error("Streaming aborted");
        }

        const delta = chunk.choices?.[0]?.delta?.content;
        if (typeof delta !== "string" || !delta) {
          continue;
        }

        outputText += delta;
        token(delta);
      }
    } catch (error) {
      if (signal?.aborted) {
        throw error;
      }
      this.logger.error({ err: error }, "OpenAI streaming generation failed");
      return {
        decision: "handoff",
        reply: handoffMessageFor(cleanText),
        citations: []
      };
    }

    const reply = sanitizeUserText(outputText, 700);
    const looksLikeNoContext = NO_CONTEXT_REPLY_PATTERN.test(reply);
    const looksLikeTransferReply = TRANSFER_REPLY_PATTERN.test(reply);

    if (!reply || MEDICAL_ADVICE_PATTERN.test(reply) || looksLikeNoContext || looksLikeTransferReply) {
      return {
        decision: "handoff",
        reply: handoffMessageFor(cleanText),
        citations: []
      };
    }

    return {
      decision: "answer",
      reply,
      citations: retrievalCitations
    };
  }
}

module.exports = { AssistantService };
