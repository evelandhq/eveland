export type AgentCatalogCapabilities = {
  eveChat: true;
};

export type AgentCatalogEntry = {
  projectId: string;
  name: string;
  description: string | null;
  url: string;
  capabilities: AgentCatalogCapabilities;
};

export type AgentCatalogRecord = Omit<AgentCatalogEntry, "url"> & {
  hostname: string;
};

export type AgentCatalogResponse = {
  agents: AgentCatalogEntry[];
};
