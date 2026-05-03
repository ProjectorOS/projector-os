import type { ClientCommand, ServerEvent } from "./types";

export type ConnectionState = "connecting" | "open" | "closed";

export interface WsClientOptions {
  url: string;
  onEvent: (event: ServerEvent) => void;
  onState?: (state: ConnectionState) => void;
}

/**
 * Minimal reconnecting WebSocket wrapper. Both the projector view and the control
 * view use it; the only difference is the event/command handlers wired up around it.
 */
export class WsClient {
  private ws: WebSocket | null = null;
  private state: ConnectionState = "closed";
  private reconnectTimer: number | null = null;

  constructor(private readonly opts: WsClientOptions) {}

  connect(): void {
    this.setState("connecting");
    const ws = new WebSocket(this.opts.url);
    this.ws = ws;
    ws.addEventListener("open", () => this.setState("open"));
    ws.addEventListener("close", () => {
      this.setState("closed");
      this.scheduleReconnect();
    });
    ws.addEventListener("error", () => {
      // close handler will fire next; nothing to do here.
    });
    ws.addEventListener("message", (e) => {
      try {
        this.opts.onEvent(JSON.parse(e.data) as ServerEvent);
      } catch (err) {
        console.error("bad event payload", err, e.data);
      }
    });
  }

  send(cmd: ClientCommand): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify(cmd));
  }

  private setState(s: ConnectionState): void {
    if (this.state === s) return;
    this.state = s;
    this.opts.onState?.(s);
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer !== null) return;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, 1000);
  }
}

export function defaultServerHttpUrl(): string {
  return location.protocol + "//" + location.hostname + ":8000";
}

export function defaultServerWsUrl(): string {
  const wsScheme = location.protocol === "https:" ? "wss:" : "ws:";
  return `${wsScheme}//${location.hostname}:8000/ws`;
}
