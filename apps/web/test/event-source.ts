/**
 * Stands in for the browser's EventSource, which happy-dom lacks: tests open
 * one, push events through it and break it, as via and the network would.
 * Every EventSource the app makes is kept, newest last, until the test ends.
 */
import { AdminState } from "@via/server/admin-api";
import { Schema } from "effect";

export const sources: Array<FakeEventSource> = [];

export class FakeEventSource extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  readonly url: string;
  readyState: number = FakeEventSource.CONNECTING;
  onerror: ((event: Event) => void) | null = null;

  constructor(url: string | URL) {
    super();
    this.url = String(url);
    sources.push(this);
  }

  close() {
    this.readyState = FakeEventSource.CLOSED;
  }

  /** via sends `state`, as `/admin/events` does. */
  push(state: typeof AdminState.Type) {
    this.readyState = FakeEventSource.OPEN;
    this.dispatchEvent(
      new MessageEvent("state", {
        data: Schema.encodeSync(Schema.fromJsonString(AdminState))(state),
      }),
    );
  }

  /** via says the usage history changed, as `/admin/events` does. */
  history() {
    this.readyState = FakeEventSource.OPEN;
    this.dispatchEvent(new MessageEvent("history", { data: "changed" }));
  }

  /** The connection drops; a browser tries again on its own. */
  fail() {
    this.readyState = FakeEventSource.CONNECTING;
    const event = new Event("error");
    this.dispatchEvent(event);
    this.onerror?.(event);
  }
}

/** The EventSource the app has open now. */
export const openSource = () => {
  const source = sources.findLast((candidate) => candidate.readyState !== FakeEventSource.CLOSED);

  if (source === undefined) throw new Error("The app has no EventSource open");

  return source;
};
