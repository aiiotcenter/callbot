const dotenv = require("dotenv");
const { z } = require("zod");

dotenv.config();

const envSchema = z
  .object({
    RAG_BACKEND: z.enum(["azure_search", "azure_openai_responses"]).default("azure_openai_responses"),

    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    HOST: z.string().default("0.0.0.0"),
    PORT: z.coerce.number().int().min(1).max(65535).default(8765),
    LOG_LEVEL: z
      .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
      .default("info"),

    SERVICE_API_TOKEN: z.string().min(32).optional(),
    INBOUND_WS_AUTH_TOKEN: z.string().min(32).optional(),

    OPENAI_API_KEY: z.string().optional(),
    OPENAI_MODEL: z.string().default("gpt-4.1-mini"),
    OPENAI_EMBEDDING_MODEL: z.string().default("text-embedding-3-small"),

    AZURE_SEARCH_ENDPOINT: z.string().optional(),
    AZURE_SEARCH_API_KEY: z.string().optional(),
    AZURE_SEARCH_INDEX_NAME: z.string().optional(),
    AZURE_SEARCH_API_VERSION: z.string().default("2024-07-01"),
    AZURE_SEARCH_VECTOR_FIELD: z.string().default("contentVector"),
    AZURE_SEARCH_CONTENT_FIELD: z.string().default("content"),
    AZURE_SEARCH_TITLE_FIELD: z.string().default("title"),
    AZURE_SEARCH_ID_FIELD: z.string().default("id"),
    AZURE_SEARCH_TOP_K: z.coerce.number().int().min(1).max(20).default(5),
    RAG_MIN_SCORE: z.coerce.number().min(0).max(10).default(0.5),

    OPENAI_ENDPOINT: z.string().optional(),
    AZURE_OPENAI_ENDPOINT: z.string().optional(),
    AZURE_OPENAI_API_KEY: z.string().optional(),
    AZURE_OPENAI_RESPONSES_API_VERSION: z.string().default("2025-04-01-preview"),
    AZURE_OPENAI_CHAT_DEPLOYMENT: z.string().min(1).optional(),
    AZURE_OPENAI_FILE_SEARCH_TOP_K: z.coerce.number().int().min(1).max(20).default(3),
    AZURE_OPENAI_MAX_OUTPUT_TOKENS: z.coerce.number().int().min(32).max(800).default(120),
    AZURE_OPENAI_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(2000).max(30000).default(8000),
    AZURE_OPENAI_HISTORY_TURNS: z.coerce.number().int().min(0).max(10).default(2),
    AZURE_OPENAI_CACHE_TTL_MS: z.coerce.number().int().min(0).max(600000).default(120000),
    AZURE_OPENAI_CACHE_MAX_ENTRIES: z.coerce.number().int().min(10).max(5000).default(500),
    AZURE_OPENAI_VECTOR_STORE_ID: z.string().min(1).optional(),
    AGENTS_STORE_PATH: z.string().default("/app/agents/agents.json"),

    MAX_USER_TEXT_CHARS: z.coerce.number().int().min(50).max(2000).default(600),
    MAX_HISTORY_TURNS: z.coerce.number().int().min(1).max(25).default(10),

    RATE_LIMIT_MAX: z.coerce.number().int().min(1).max(1000).default(60),

    DEEPGRAM_API_KEY: z.string().min(20).optional(),
    DEEPGRAM_LISTEN_URL: z
      .string()
      .default("wss://api.deepgram.com/v1/listen?punctuate=true&interim_results=false"),

    HUMAN_HANDOFF_WEBHOOK_URL: z.url().optional()
  })
  .superRefine((data, ctx) => {
    const isValidUrl = (value) => {
      try {
        // eslint-disable-next-line no-new
        new URL(value);
        return true;
      } catch {
        return false;
      }
    };

    if (data.NODE_ENV === "production") {
      if (!data.SERVICE_API_TOKEN) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "SERVICE_API_TOKEN is required in production"
        });
      }
      if (!data.INBOUND_WS_AUTH_TOKEN) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "INBOUND_WS_AUTH_TOKEN is required in production"
        });
      }
    }

    if (data.RAG_BACKEND === "azure_search") {
      if (!data.OPENAI_API_KEY || data.OPENAI_API_KEY.length < 20) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "OPENAI_API_KEY is required when RAG_BACKEND=azure_search",
          path: ["OPENAI_API_KEY"]
        });
      }
      if (!data.AZURE_SEARCH_ENDPOINT || !isValidUrl(data.AZURE_SEARCH_ENDPOINT)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "AZURE_SEARCH_ENDPOINT must be a valid URL when RAG_BACKEND=azure_search",
          path: ["AZURE_SEARCH_ENDPOINT"]
        });
      }
      if (!data.AZURE_SEARCH_API_KEY || data.AZURE_SEARCH_API_KEY.length < 20) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "AZURE_SEARCH_API_KEY is required when RAG_BACKEND=azure_search",
          path: ["AZURE_SEARCH_API_KEY"]
        });
      }
      if (!data.AZURE_SEARCH_INDEX_NAME || data.AZURE_SEARCH_INDEX_NAME.length < 1) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "AZURE_SEARCH_INDEX_NAME is required when RAG_BACKEND=azure_search",
          path: ["AZURE_SEARCH_INDEX_NAME"]
        });
      }
    }

    if (data.RAG_BACKEND === "azure_openai_responses") {
      if (!data.AZURE_OPENAI_API_KEY || data.AZURE_OPENAI_API_KEY.length < 20) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "AZURE_OPENAI_API_KEY is required when RAG_BACKEND=azure_openai_responses",
          path: ["AZURE_OPENAI_API_KEY"]
        });
      }
      if (!data.AZURE_OPENAI_ENDPOINT && !data.OPENAI_ENDPOINT) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Set AZURE_OPENAI_ENDPOINT or OPENAI_ENDPOINT when RAG_BACKEND=azure_openai_responses",
          path: ["AZURE_OPENAI_ENDPOINT"]
        });
      } else {
        const endpoint = data.AZURE_OPENAI_ENDPOINT || data.OPENAI_ENDPOINT;
        if (!isValidUrl(endpoint)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "AZURE_OPENAI_ENDPOINT/OPENAI_ENDPOINT must be a valid URL",
            path: ["AZURE_OPENAI_ENDPOINT"]
          });
        }
      }
    }
  });

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  const message = parsed.error.issues.map((i) => `- ${i.path.join(".") || "env"}: ${i.message}`).join("\n");
  throw new Error(`Invalid environment configuration:\n${message}`);
}

const config = Object.freeze({
  ...parsed.data,
  AZURE_OPENAI_ENDPOINT: parsed.data.AZURE_OPENAI_ENDPOINT || parsed.data.OPENAI_ENDPOINT || "",
  AZURE_OPENAI_CHAT_DEPLOYMENT: parsed.data.AZURE_OPENAI_CHAT_DEPLOYMENT || parsed.data.OPENAI_MODEL
});

module.exports = { config };
