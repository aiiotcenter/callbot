"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";

import type { AgentRecord } from "@/types/admin";

type AgentsResponse = { agents: AgentRecord[]; error?: string };
type CreateAgentResponse = { agent?: AgentRecord; error?: string };
type UploadResponse = {
  file?: {
    id: string;
    name: string;
    mimeType: string;
    sizeBytes: number;
    azureFileId: string;
    azureVectorStoreFileId: string;
    uploadedAt: string;
  };
  error?: string;
};

type ApiPayload = {
  error?: string;
  [key: string]: unknown;
};

function bytesToReadable(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

async function readApiPayload(response: Response): Promise<ApiPayload> {
  const raw = await response.text();
  if (!raw) return {};

  try {
    return JSON.parse(raw) as ApiPayload;
  } catch {
    return { error: `Unexpected response format (HTTP ${response.status})` };
  }
}

export default function DashboardClient() {
  const router = useRouter();

  const [agents, setAgents] = useState<AgentRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedAgentId, setSelectedAgentId] = useState("");
  const [notice, setNotice] = useState<{ kind: "ok" | "error" | "warn"; message: string } | null>(null);

  const [creatingAgent, setCreatingAgent] = useState(false);
  const [uploadingFile, setUploadingFile] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);

  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [hospitalCode, setHospitalCode] = useState("");
  const [description, setDescription] = useState("");

  const selectedAgent = useMemo(
    () => agents.find((agent) => agent.id === selectedAgentId) ?? null,
    [agents, selectedAgentId]
  );

  const refreshAgents = async (): Promise<string | null> => {
    try {
      const response = await fetch("/api/admin/agents", {
        method: "GET",
        cache: "no-store"
      });

      if (response.status === 401) {
        router.push("/login");
        return "Unauthorized";
      }

      const payload = (await readApiPayload(response)) as AgentsResponse;
      if (!response.ok) {
        return payload.error || `Failed to load agents (HTTP ${response.status})`;
      }

      setAgents(payload.agents || []);
      if (!selectedAgentId && payload.agents.length > 0) {
        setSelectedAgentId(payload.agents[0].id);
      }

      return null;
    } catch (error) {
      return error instanceof Error ? error.message : "Failed to load agents";
    }
  };

  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        const error = await refreshAgents();
        if (error && error !== "Unauthorized") {
          setNotice({ kind: "error", message: error });
        }
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const onCreateAgent = async (event: FormEvent) => {
    event.preventDefault();
    setCreatingAgent(true);
    setNotice(null);

    try {
      const response = await fetch("/api/admin/agents", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          name,
          slug,
          hospitalCode,
          description
        })
      });

      const payload = (await readApiPayload(response)) as CreateAgentResponse;
      if (!response.ok || !payload.agent) {
        setNotice({ kind: "error", message: payload.error || `Failed to create agent (HTTP ${response.status})` });
        return;
      }

      setName("");
      setSlug("");
      setHospitalCode("");
      setDescription("");
      const refreshError = await refreshAgents();
      setSelectedAgentId(payload.agent.id);
      if (refreshError && refreshError !== "Unauthorized") {
        setNotice({
          kind: "warn",
          message: `Agent created, but refresh failed: ${refreshError}`
        });
      } else {
        setNotice({ kind: "ok", message: `Agent ${payload.agent.name} created.` });
      }
    } catch (error) {
      setNotice({ kind: "error", message: error instanceof Error ? error.message : "Failed to create agent" });
    } finally {
      setCreatingAgent(false);
    }
  };

  const onUploadFile = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;

    if (!selectedAgent) {
      setNotice({ kind: "warn", message: "Create or select an agent first." });
      return;
    }

    const fileInput = form.elements.namedItem("file") as HTMLInputElement | null;
    const file = fileInput?.files?.[0];

    if (!file) {
      setNotice({ kind: "warn", message: "Choose a file before upload." });
      return;
    }

    setUploadingFile(true);
    setNotice(null);

    try {
      const formData = new FormData();
      formData.set("file", file);

      const response = await fetch(`/api/admin/agents/${selectedAgent.id}/files`, {
        method: "POST",
        body: formData
      });

      const payload = (await readApiPayload(response)) as UploadResponse;
      if (!response.ok || !payload.file) {
        setNotice({ kind: "error", message: payload.error || `Upload failed (HTTP ${response.status})` });
        return;
      }

      const refreshError = await refreshAgents();
      if (refreshError && refreshError !== "Unauthorized") {
        setNotice({
          kind: "warn",
          message: `${payload.file.name} uploaded, but list refresh failed: ${refreshError}`
        });
      } else {
        setNotice({ kind: "ok", message: `${payload.file.name} uploaded successfully.` });
      }
      form.reset();
    } catch (error) {
      setNotice({ kind: "error", message: error instanceof Error ? error.message : "Upload request failed" });
    } finally {
      setUploadingFile(false);
    }
  };

  const onLogout = async () => {
    setLoggingOut(true);
    await fetch("/api/admin/auth/logout", { method: "POST" });
    router.push("/login");
    router.refresh();
  };

  return (
    <main className="page-shell">
      <section className="panel topbar">
        <h1>Hospital Multi-Agent Control</h1>
        <button className="secondary" onClick={onLogout} disabled={loggingOut}>
          {loggingOut ? "Signing out..." : "Sign out"}
        </button>
      </section>

      <section className="grid">
        <div className="panel section">
          <h2>Create Agent</h2>
          <form onSubmit={onCreateAgent}>
            <label>
              Agent Name
              <input value={name} onChange={(event) => setName(event.target.value)} placeholder="NEU Main Hospital" required />
            </label>
            <label>
              Agent Slug
              <input
                value={slug}
                onChange={(event) => setSlug(event.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""))}
                placeholder="neu-main"
                required
              />
            </label>
            <label>
              Hospital Code
              <input
                value={hospitalCode}
                onChange={(event) => setHospitalCode(event.target.value.toUpperCase().replace(/[^A-Z0-9_-]/g, ""))}
                placeholder="NEU_MAIN"
                required
              />
            </label>
            <label>
              Description
              <textarea
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                placeholder="Hospital routing notes, specialty lines, and operating hours scope"
              />
            </label>
            <button type="submit" disabled={creatingAgent}>
              {creatingAgent ? "Creating..." : "Create Agent + Vector Store"}
            </button>
          </form>

          <h2 style={{ marginTop: 20 }}>Agents</h2>
          {loading ? <p className="muted">Loading agents...</p> : null}
          <div className="agent-list">
            {agents.map((agent) => (
              <div
                key={agent.id}
                className={`agent-card ${selectedAgentId === agent.id ? "active" : ""}`}
                onClick={() => setSelectedAgentId(agent.id)}
              >
                <h3>{agent.name}</h3>
                <div className="agent-meta">
                  {agent.hospitalCode} | {agent.slug}
                </div>
                <div className="agent-meta">Vector Store: {agent.vectorStoreId}</div>
                <div className="agent-meta">Files: {agent.files.length}</div>
              </div>
            ))}
            {!loading && agents.length === 0 ? <p className="muted">No agents yet.</p> : null}
          </div>
        </div>

        <div className="panel section">
          <h2>Upload Hospital Files</h2>
          {selectedAgent ? (
            <div className="panel-strong section" style={{ marginBottom: 14 }}>
              <strong>{selectedAgent.name}</strong>
              <p className="muted" style={{ margin: "6px 0 0" }}>
                Upload files only for this hospital. Files are sent to Azure OpenAI and attached to this agent's vector
                store.
              </p>
            </div>
          ) : (
            <div className="notice warn">Select an agent from the left panel first.</div>
          )}

          <form onSubmit={onUploadFile}>
            <label>
              File
              <input name="file" type="file" accept=".pdf,.txt,.md,.docx" disabled={!selectedAgent || uploadingFile} />
            </label>
            <button type="submit" disabled={!selectedAgent || uploadingFile}>
              {uploadingFile ? "Uploading..." : "Upload to Azure AI"}
            </button>
          </form>

          <h2 style={{ marginTop: 20 }}>Uploaded Files</h2>
          <div className="file-list">
            {(selectedAgent?.files || []).map((file) => (
              <div className="file-row" key={file.id}>
                <strong>{file.name}</strong>
                <br />
                <small>
                  {file.mimeType} | {bytesToReadable(file.sizeBytes)} | {new Date(file.uploadedAt).toLocaleString()}
                </small>
                <br />
                <small>Azure file: {file.azureFileId}</small>
              </div>
            ))}
            {selectedAgent && selectedAgent.files.length === 0 ? (
              <p className="muted">No files uploaded for this agent yet.</p>
            ) : null}
          </div>
        </div>
      </section>

      {notice ? <div className={`notice ${notice.kind === "error" ? "error" : notice.kind}`}>{notice.message}</div> : null}
    </main>
  );
}
