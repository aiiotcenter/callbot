export type AgentFileRecord = {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  azureFileId: string;
  azureVectorStoreFileId: string;
  uploadedAt: string;
};

export type AgentRecord = {
  id: string;
  name: string;
  slug: string;
  hospitalCode: string;
  description: string;
  vectorStoreId: string;
  assistantId: string | null;
  createdAt: string;
  updatedAt: string;
  files: AgentFileRecord[];
};

export type AgentsStore = {
  agents: AgentRecord[];
};
