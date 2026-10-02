import { randomUUID } from "node:crypto";

export type ChangeResourceKind = "collection" | "folder" | "request" | "environment" | "variable";
export type ChangeOperation = "created" | "updated" | "trashed" | "restored" | "move";

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

/**
 * Who receives an event: everyone working in one team, or one person whichever team they are in
 * (their private variables are not tied to a team).
 */
export type ChangeAudience = { teamId: string } | { userId: string };

/** The stream a subscriber has open: who they are and the team they are watching. */
export interface ChangeSubscriber {
  userId: string;
  teamId: string;
}

interface BufferedChangeEvent {
  event: SequencedChangeEvent;
  audience: ChangeAudience;
}

interface Listener {
  callback: ChangeListener;
  subscriber: ChangeSubscriber;
  onRevoke?: () => void;
}

function reaches(audience: ChangeAudience, subscriber: ChangeSubscriber): boolean {
  return "teamId" in audience ? audience.teamId === subscriber.teamId : audience.userId === subscriber.userId;
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
  private readonly buffer: BufferedChangeEvent[] = [];
  private readonly bufferSize: number;
  private readonly listeners = new Set<Listener>();
  private readonly observers = new Set<ChangeListener>();
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

  /** Announces a change to everyone watching `teamId`. */
  publish(teamId: string, event: ChangeEvent): SequencedChangeEvent {
    return this.publishForAudience(event, { teamId });
  }

  publishToUser(userId: string, event: ChangeEvent): SequencedChangeEvent {
    return this.publishForAudience(event, { userId });
  }

  private publishForAudience(event: ChangeEvent, audience: ChangeAudience): SequencedChangeEvent {
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
      this.buffer.push({ event: sequenced, audience });
      if (this.buffer.length > this.bufferSize) this.buffer.shift();
    }
    for (const listener of [...this.listeners]) {
      if (!reaches(audience, listener.subscriber)) continue;
      try {
        listener.callback(sequenced);
      } catch {
        // A failing subscriber must not affect the writer or other subscribers.
        this.listeners.delete(listener);
      }
    }
    for (const observer of [...this.observers]) {
      try {
        observer(sequenced);
      } catch {
        this.observers.delete(observer);
      }
    }
    return sequenced;
  }

  /**
   * `onRevoke` runs when the subscriber loses access to the team (see `revoke`); the stream should
   * end there, because a team's events must not keep flowing to someone no longer in it.
   */
  subscribe(listener: ChangeListener, subscriber: ChangeSubscriber, onRevoke?: () => void): () => void {
    if (this.closed) return () => {};
    const entry: Listener = { callback: listener, subscriber, onRevoke };
    this.listeners.add(entry);
    return () => {
      this.listeners.delete(entry);
    };
  }

  /** Ends the subscriptions of one member of a team, or of everyone in it when `userId` is omitted. */
  revoke(teamId: string, userId?: string): void {
    for (const listener of [...this.listeners]) {
      const { subscriber } = listener;
      if (subscriber.teamId !== teamId || (userId !== undefined && subscriber.userId !== userId)) continue;
      this.listeners.delete(listener);
      try {
        listener.onRevoke?.();
      } catch {
        // Ending one stream must not stop the others from being ended.
      }
    }
  }

  observe(listener: ChangeListener): () => void {
    if (this.closed) return () => {};
    this.observers.add(listener);
    return () => {
      this.observers.delete(listener);
    };
  }

  /** Returns events published after `lastEventId`, if this process can still provide all of them. */
  replaySince(lastEventId: string, subscriber: ChangeSubscriber): ReplayResult {
    const separator = lastEventId.lastIndexOf(":");
    const epoch = lastEventId.slice(0, separator);
    const seq = Number(lastEventId.slice(separator + 1));
    if (separator < 0 || epoch !== this.epoch || !Number.isSafeInteger(seq) || seq < 0 || seq > this.sequence) {
      return { complete: false, events: [] };
    }
    const oldestBuffered = this.sequence - this.buffer.length + 1;
    if (seq + 1 < oldestBuffered) return { complete: false, events: [] };
    return {
      complete: true,
      events: this.buffer
        .filter((entry) => sequenceOf(entry.event) > seq)
        .filter((entry) => reaches(entry.audience, subscriber))
        .map((entry) => entry.event),
    };
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
    this.observers.clear();
  }
}

function sequenceOf(event: SequencedChangeEvent): number {
  return Number(event.eventId.slice(event.eventId.lastIndexOf(":") + 1));
}
