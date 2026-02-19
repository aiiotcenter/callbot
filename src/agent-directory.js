const fs = require("node:fs/promises");

class AgentDirectory {
  constructor(storePath, logger) {
    this.storePath = storePath;
    this.logger = logger;
  }

  async listAgents() {
    try {
      const raw = await fs.readFile(this.storePath, "utf8");
      const parsed = JSON.parse(raw);
      const agents = Array.isArray(parsed?.agents) ? parsed.agents : [];
      return agents;
    } catch (error) {
      this.logger?.debug({ err: error, path: this.storePath }, "Agent store read skipped");
      return [];
    }
  }

  async resolveVectorStoreId({ agentId, hospitalCode }) {
    if (!agentId && !hospitalCode) {
      return null;
    }

    const agents = await this.listAgents();

    if (agentId) {
      const byId = agents.find((agent) => agent?.id === agentId);
      if (byId?.vectorStoreId) {
        return byId.vectorStoreId;
      }
    }

    if (hospitalCode) {
      const byHospital = agents.find((agent) => agent?.hospitalCode === hospitalCode);
      if (byHospital?.vectorStoreId) {
        return byHospital.vectorStoreId;
      }
    }

    return null;
  }
}

module.exports = { AgentDirectory };
