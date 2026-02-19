import "server-only";

import { z } from "zod";

const envSchema = z
  .object({
    ADMIN_DASHBOARD_PASSWORD: z.string().min(12),
    ADMIN_SESSION_SECRET: z.string().min(32),
    AZURE_OPENAI_ENDPOINT: z.string().url().optional(),
    OPENAI_ENDPOINT: z.string().url().optional(),
    AZURE_OPENAI_API_KEY: z.string().min(20),
    AZURE_OPENAI_API_VERSION: z.string().default("2024-08-01-preview")
  })
  .superRefine((value, ctx) => {
    if (!value.AZURE_OPENAI_ENDPOINT && !value.OPENAI_ENDPOINT) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Provide AZURE_OPENAI_ENDPOINT or OPENAI_ENDPOINT",
        path: ["AZURE_OPENAI_ENDPOINT"]
      });
    }
  });

export function getServerEnv() {
  const parsed = envSchema.safeParse(process.env);

  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid admin-dashboard environment: ${details}`);
  }

  return {
    ...parsed.data,
    AZURE_OPENAI_ENDPOINT: parsed.data.AZURE_OPENAI_ENDPOINT || parsed.data.OPENAI_ENDPOINT || ""
  };
}
