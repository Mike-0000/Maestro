/**
 * Loopback ports that belong to Chorus's own servers (browser control, git credentials, OAuth).
 * Model-driven browsers may never load them, even when an allowlisted origin shares the port.
 */
const reserved = new Set<number>();

export function reserveLoopbackPort(port: number): () => void {
  if (port > 0) reserved.add(port);
  return () => reserved.delete(port);
}

export function reservedLoopbackPorts(): number[] {
  return [...reserved];
}
