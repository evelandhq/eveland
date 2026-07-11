export type AgentRoute = {
  slug: string;
  name: string;
  hostAddress: string;
  hostPort: number;
};

export type RouteSource = {
  lookup(slug: string): Promise<AgentRoute | null>;
  listAgents(): Promise<Array<{ slug: string; name: string }>>;
  /** onInvalidate(null) means "drop the whole cache". */
  subscribe(handlers: { onInvalidate: (slug: string | null) => void }): Promise<void>;
  close(): Promise<void>;
};
