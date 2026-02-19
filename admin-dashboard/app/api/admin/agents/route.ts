import { NextResponse } from "next/server";
import { z } from "zod";

import { requireAdminAuth } from "@/lib/auth";
import { createVectorStore } from "@/lib/azure-openai";
import { createAgent, listAgents } from "@/lib/store";

const createAgentSchema = z.object({
  name: z.string().min(2).max(120),
  slug: z
    .string()
    .min(2)
    .max(60)
    .regex(/^[a-z0-9-]+$/),
  hospitalCode: z
    .string()
    .min(2)
    .max(40)
    .regex(/^[A-Z0-9_-]+$/),
  description: z.string().max(300).default("")
});

export async function GET() {
  if (!(await requireAdminAuth())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const agents = await listAgents();
  return NextResponse.json({ agents });
}

export async function POST(request: Request) {
  if (!(await requireAdminAuth())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const payload = await request.json();
    const parsed = createAgentSchema.safeParse(payload);

    if (!parsed.success) {
      return NextResponse.json({ error: "Invalid payload", details: parsed.error.issues }, { status: 400 });
    }

    const vectorStoreId = await createVectorStore(parsed.data.name, {
      agent_slug: parsed.data.slug,
      hospital_code: parsed.data.hospitalCode
    });

    const agent = await createAgent({
      ...parsed.data,
      vectorStoreId
    });

    return NextResponse.json({ agent }, { status: 201 });
  } catch (error) {
    console.error("create-agent failed", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unexpected error" },
      { status: 500 }
    );
  }
}
