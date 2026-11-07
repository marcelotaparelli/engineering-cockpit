/**
 * In-process fan-out for the browser stream. Durable state lives in the RuntimeStore journal;
 * subscribers are only *woken* for it and pull by cursor, so a slow or reconnecting client never
 * misses a durable event. Live events (deltas, items) are transient and may be dropped.
 */
export interface LiveEvent {
  projectId: string;
  sessionId: string;
  runId: string | null;
  kind: "delta" | "item" | "status" | "error" | "notice" | "approval";
  data: Record<string, unknown>;
}

export interface HubSubscriber {
  projects: ReadonlySet<string>;
  onLive(event: LiveEvent): void;
  onJournal(): void;
}

export class EventHub {
  readonly #subscribers = new Set<HubSubscriber>();

  subscribe(subscriber: HubSubscriber): () => void {
    this.#subscribers.add(subscriber);
    return () => { this.#subscribers.delete(subscriber); };
  }

  live(event: LiveEvent): void {
    for (const subscriber of this.#subscribers) {
      if (!subscriber.projects.has(event.projectId)) continue;
      try { subscriber.onLive(event); } catch { /* subscriber failures are isolated */ }
    }
  }

  journal(): void {
    for (const subscriber of this.#subscribers) {
      try { subscriber.onJournal(); } catch { /* subscriber failures are isolated */ }
    }
  }

  get size(): number { return this.#subscribers.size; }
}
