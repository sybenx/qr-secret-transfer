// A device's network connection that a test can cut: a WebSocket class for one device
// that, while that device is down, closes every socket it made, refuses to open new
// ones, and hears nothing that was already on its way in. What a locked phone or a
// tab in the background does to a session, minus the waiting.

export interface Flaky {
  WebSocketImpl: typeof WebSocket;
  readonly isDown: boolean;
  down(): void;
  up(): void;
  /** Goes down straight after the next EVENT this device sends: its message gets out, the answer does not get in. */
  downAfterSending(): Promise<void>;
}

export function flaky(): Flaky {
  let offline = false;
  let afterSend: (() => void) | undefined;
  const live = new Set<WebSocket>();

  const down = () => {
    offline = true;
    for (const ws of live) ws.close();
  };

  class FlakySocket extends WebSocket {
    constructor(url: string | URL, protocols?: string | string[]) {
      if (offline) throw new Error('offline');
      super(url, protocols);
      live.add(this);
      this.addEventListener('close', () => live.delete(this));
    }

    override send(data: Parameters<WebSocket['send']>[0]): void {
      super.send(data);
      if (afterSend && typeof data === 'string' && data.startsWith('["EVENT"')) {
        const then = afterSend;
        afterSend = undefined;
        then();
      }
    }

    override set onmessage(handler: ((this: WebSocket, ev: MessageEvent) => unknown) | null) {
      super.onmessage = handler && ((ev: MessageEvent) => (offline ? undefined : handler.call(this, ev)));
    }

    override get onmessage(): ((this: WebSocket, ev: MessageEvent) => unknown) | null {
      return super.onmessage;
    }
  }

  return {
    WebSocketImpl: FlakySocket,
    get isDown() {
      return offline;
    },
    down,
    up() {
      offline = false;
    },
    downAfterSending() {
      return new Promise((resolve) => {
        afterSend = () => {
          down();
          resolve();
        };
      });
    },
  };
}
