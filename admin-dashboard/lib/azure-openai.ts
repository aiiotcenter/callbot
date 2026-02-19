import "server-only";

import { getServerEnv } from "./env";

type AzureErrorBody = {
  error?: {
    message?: string;
  };
};

function baseEndpoint() {
  return getServerEnv().AZURE_OPENAI_ENDPOINT.replace(/\/$/, "");
}

async function azureRequest(pathname: string, init?: RequestInit) {
  const env = getServerEnv();
  const url = `${baseEndpoint()}${pathname}?api-version=${encodeURIComponent(env.AZURE_OPENAI_API_VERSION)}`;

  const response = await fetch(url, {
    ...init,
    headers: {
      "api-key": env.AZURE_OPENAI_API_KEY,
      ...(init?.headers || {})
    },
    cache: "no-store"
  });

  if (!response.ok) {
    let details = response.statusText;

    try {
      const body = (await response.json()) as AzureErrorBody;
      details = body.error?.message || details;
    } catch {
      const text = await response.text();
      details = text || details;
    }

    throw new Error(`Azure OpenAI request failed (${response.status}): ${details}`);
  }

  return response;
}

export async function createVectorStore(name: string, metadata: Record<string, string>) {
  const response = await azureRequest("/openai/vector_stores", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      name,
      metadata
    })
  });

  const body = (await response.json()) as { id: string };
  if (!body.id) {
    throw new Error("Vector store creation response did not include id");
  }

  return body.id;
}

export async function uploadFileToAzure(file: File) {
  const form = new FormData();
  form.set("purpose", "assistants");
  form.set("file", file, file.name);

  const response = await azureRequest("/openai/files", {
    method: "POST",
    body: form
  });

  const body = (await response.json()) as { id: string };
  if (!body.id) {
    throw new Error("File upload response did not include id");
  }

  return body.id;
}

export async function attachFileToVectorStore(vectorStoreId: string, fileId: string) {
  const response = await azureRequest(`/openai/vector_stores/${encodeURIComponent(vectorStoreId)}/files`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ file_id: fileId })
  });

  const body = (await response.json()) as { id: string };
  if (!body.id) {
    throw new Error("Vector store file attach response did not include id");
  }

  return body.id;
}
