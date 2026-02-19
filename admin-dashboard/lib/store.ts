import "server-only";

import crypto from "node:crypto";
import path from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";

import type { AgentFileRecord, AgentRecord, AgentsStore } from "@/types/admin";

const DATA_DIR = path.join(process.cwd(), "data");
const STORE_PATH = path.join(DATA_DIR, "agents.json");

let lock = Promise.resolve();

async function ensureStoreExists() {
  await mkdir(DATA_DIR, { recursive: true });

  try {
    await readFile(STORE_PATH, "utf8");
  } catch {
    const initial: AgentsStore = { agents: [] };
    await writeFile(STORE_PATH, JSON.stringify(initial, null, 2), "utf8");
  }
}

async function readStore(): Promise<AgentsStore> {
  await ensureStoreExists();
  const raw = await readFile(STORE_PATH, "utf8");

  try {
    const parsed = JSON.parse(raw) as AgentsStore;
    if (!parsed.agents || !Array.isArray(parsed.agents)) {
      return { agents: [] };
    }

    return parsed;
  } catch {
    return { agents: [] };
  }
}

async function writeStore(store: AgentsStore) {
  await writeFile(STORE_PATH, JSON.stringify(store, null, 2), "utf8");
}

function withStoreLock<T>(fn: () => Promise<T>) {
  const next = lock.then(fn);
  lock = next.then(
    () => undefined,
    () => undefined
  );
  return next;
}

export async function listAgents() {
  const store = await readStore();
  return store.agents;
}

export async function getAgent(agentId: string) {
  const store = await readStore();
  return store.agents.find((agent) => agent.id === agentId) ?? null;
}

export async function createAgent(input: {
  name: string;
  slug: string;
  hospitalCode: string;
  description: string;
  vectorStoreId: string;
}) {
  return withStoreLock(async () => {
    const store = await readStore();

    const duplicate = store.agents.find(
      (agent) => agent.slug === input.slug || agent.hospitalCode === input.hospitalCode
    );

    if (duplicate) {
      throw new Error("Agent slug or hospital code already exists");
    }

    const now = new Date().toISOString();
    const agent: AgentRecord = {
      id: crypto.randomUUID(),
      name: input.name,
      slug: input.slug,
      hospitalCode: input.hospitalCode,
      description: input.description,
      vectorStoreId: input.vectorStoreId,
      assistantId: null,
      createdAt: now,
      updatedAt: now,
      files: []
    };

    store.agents.push(agent);
    await writeStore(store);

    return agent;
  });
}

export async function addAgentFile(agentId: string, file: Omit<AgentFileRecord, "id" | "uploadedAt">) {
  return withStoreLock(async () => {
    const store = await readStore();
    const agent = store.agents.find((item) => item.id === agentId);

    if (!agent) {
      throw new Error("Agent not found");
    }

    const created: AgentFileRecord = {
      id: crypto.randomUUID(),
      uploadedAt: new Date().toISOString(),
      ...file
    };

    agent.files.push(created);
    agent.updatedAt = new Date().toISOString();

    await writeStore(store);
    return created;
  });
}
