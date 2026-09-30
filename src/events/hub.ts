import { randomUUID } from "node:crypto";

export type ChangeResourceKind = "collection" | "folder" | "request" | "environment" | "variable";
export type ChangeOperation = "created" | "updated" | "trashed" | "restored";

/**
 * Value-free notification that a shared resource changed. It never carries resource
 * contents (names, URLs, bodies, headers, variable values); clients refetch via the API.
 */
export interface ChangeEvent {
  kind: ChangeResourceKind;
  id: string;
  collectionId: string | null;
  operation: ChangeOperation;
  changedAt: string;
}

export interface SequencedChangeEvent extends ChangeEvent {
  eventId: string;
}

export type ChangeListener = (event: SequencedChangeEvent) => void;

export interface ReplayResult {
  /** False when the cursor is unknown (another process/restart) or older than the buffer. */
  complete: boolean;
  events: SequencedChangeEvent[];
}

export interface ChangeEventHubOptions {
  /** Number of recent events kept in memory for Last-Event-ID replay. */
  replayBufferSize?: number;
}

/**
 * In-process publish/subscribe hub. The MVP runs a single writable API process, so there is
 * no cross-instance fan-out; event IDs are scoped to this process via a random epoch.
 */
export class ChangeEventHub {
  readonly epoch = randomUUID();
  private sequence = 0;
  private readonly buffer: SequencedChangeEvent[] = [];
  private readonly bufferSize: number;
  private readonly listeners = new Set<ChangeListener>();
  private readonly closeHandlers = new Set<() => void>();
  private closed = false;

  constructor(options: ChangeEventHubOptions = {}) {
    this.bufferSize = Math.max(0, options.replayBufferSize ?? 1000);
  }

  get listenerCount(): number {
    return this.listeners.size;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  publish(event: ChangeEvent): SequencedChangeEvent {
    this.sequence += 1;
    // Copy only the known keys so callers cannot leak extra fields into the stream.
    const sequenced: SequencedChangeEvent = {
      eventId: `${this.epoch}:${this.sequence}`,
      kind: event.kind,
      id: event.id,
      collectionId: event.collectionId,
      operation: event.operation,
      changedAt: event.changedAt,
    };
    if (this.bufferSize > 0) {
      this.buffer.push(sequenced);
      if (this.buffer.length > this.bufferSize) this.buffer.shift();
    }
    for (const listener of [...this.listeners]) {
      try {
        listener(sequenced);
      } catch {
        // A failing subscriber must not affect the writer or other subscribers.
        this.listeners.delete(listener);
      }
    }
    return sequenced;
  }

  subscribe(listener: ChangeListener): () => void {
    if (this.closed) return () => {};
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Returns events published after `lastEventId`, if this process can still provide all of them. */
  replaySince(lastEventId: string): ReplayResult {
    const separator = lastEventId.lastIndexOf(":");
    const epoch = lastEventId.slice(0, separator);
    const seq = Number(lastEventId.slice(separator + 1));
    if (separator < 0 || epoch !== this.epoch || !Number.isSafeInteger(seq) || seq < 0 || seq > this.sequence) {
      return { complete: false, events: [] };
    }
    const oldestBuffered = this.sequence - this.buffer.length + 1;
    if (seq + 1 < oldestBuffered) return { complete: false, events: [] };
    return { complete: true, events: this.buffer.filter((e) => sequenceOf(e) > seq) };
  }

  /** Registers a callback invoked once when the hub closes (e.g. to end an SSE stream). */
  onClose(handler: () => void): () => void {
    this.closeHandlers.add(handler);
    return () => {
      this.closeHandlers.delete(handler);
    };
  }

  /** Ends all subscriptions and notifies close handlers (used on graceful shutdown). */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const handler of [...this.closeHandlers]) handler();
    this.closeHandlers.clear();
    this.listeners.clear();
  }
}

function sequenceOf(event: SequencedChangeEvent): number {
  return Number(event.eventId.slice(event.eventId.lastIndexOf(":") + 1));
}
