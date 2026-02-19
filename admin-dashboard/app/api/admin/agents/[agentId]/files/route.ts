import { NextResponse } from "next/server";

import { requireAdminAuth } from "@/lib/auth";
import { attachFileToVectorStore, uploadFileToAzure } from "@/lib/azure-openai";
import { addAgentFile, getAgent } from "@/lib/store";

const MAX_FILE_BYTES = 25 * 1024 * 1024;
const ALLOWED_MIME_TYPES = new Set([
  "application/pdf",
  "text/plain",
  "text/markdown",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
]);

export async function GET(_: Request, context: { params: Promise<{ agentId: string }> }) {
  if (!(await requireAdminAuth())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { agentId } = await context.params;
  const agent = await getAgent(agentId);

  if (!agent) {
    return NextResponse.json({ error: "Agent not found" }, { status: 404 });
  }

  return NextResponse.json({ files: agent.files });
}

export async function POST(request: Request, context: { params: Promise<{ agentId: string }> }) {
  if (!(await requireAdminAuth())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const { agentId } = await context.params;
    const agent = await getAgent(agentId);

    if (!agent) {
      return NextResponse.json({ error: "Agent not found" }, { status: 404 });
    }

    const form = await request.formData();
    const file = form.get("file");

    if (!(file instanceof File)) {
      return NextResponse.json({ error: "Missing file" }, { status: 400 });
    }

    if (file.size <= 0 || file.size > MAX_FILE_BYTES) {
      return NextResponse.json(
        { error: `File size must be between 1 byte and ${MAX_FILE_BYTES} bytes` },
        { status: 400 }
      );
    }

    if (!ALLOWED_MIME_TYPES.has(file.type)) {
      return NextResponse.json(
        { error: `Unsupported file type: ${file.type || "unknown"}` },
        { status: 400 }
      );
    }

    const azureFileId = await uploadFileToAzure(file);
    const azureVectorStoreFileId = await attachFileToVectorStore(agent.vectorStoreId, azureFileId);

    const created = await addAgentFile(agent.id, {
      name: file.name,
      mimeType: file.type,
      sizeBytes: file.size,
      azureFileId,
      azureVectorStoreFileId
    });

    return NextResponse.json({ file: created }, { status: 201 });
  } catch (error) {
    console.error("upload-file failed", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unexpected error" },
      { status: 500 }
    );
  }
}
