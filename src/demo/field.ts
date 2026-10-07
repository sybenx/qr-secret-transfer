// The strip between the two screens: what a relay sees.
//
// It starts as random bits. Each time a sealed message crosses, the strip shows the
// actual bits of that message's ciphertext sweeping from the device that sent it to
// the device it is for. The two are indistinguishable by eye, which is the point.

const MODULE = 8;
const SWEEP_MS = 650;
const BAND_ROWS = 7;

export class BitField {
  private readonly context: CanvasRenderingContext2D;
  private cells = new Uint8Array(0);
  private glow = new Float32Array(0);
  private cols = 0;
  private rows = 0;
  private frame = 0;
  private readonly reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
  private readonly dark: string;
  private readonly light: string;

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.context = canvas.getContext('2d')!;
    const style = getComputedStyle(canvas);
    this.dark = style.getPropertyValue('--bit-dark').trim() || '#1a2ab0';
    this.light = style.getPropertyValue('--bit-light').trim() || '#4a5cf2';
    new ResizeObserver(() => this.resize()).observe(canvas);
    this.resize();
  }

  private resize(): void {
    const box = this.canvas.getBoundingClientRect();
    const cols = Math.max(1, Math.floor(box.width / MODULE));
    const rows = Math.max(1, Math.floor(box.height / MODULE));
    if (cols === this.cols && rows === this.rows) return;
    const ratio = window.devicePixelRatio || 1;
    this.canvas.width = cols * MODULE * ratio;
    this.canvas.height = rows * MODULE * ratio;
    this.context.setTransform(ratio, 0, 0, ratio, 0, 0);
    this.cols = cols;
    this.rows = rows;
    this.cells = new Uint8Array(cols * rows);
    this.glow = new Float32Array(cols * rows);
    // Random bytes, expanded to one bit per cell.
    const random = crypto.getRandomValues(new Uint8Array(Math.ceil((cols * rows) / 8)));
    for (let i = 0; i < this.cells.length; i++) this.cells[i] = (random[i >> 3]! >> (i & 7)) & 1;
    this.draw();
  }

  private draw(): void {
    const c = this.context;
    c.fillStyle = this.dark;
    c.fillRect(0, 0, this.cols * MODULE, this.rows * MODULE);
    for (let y = 0; y < this.rows; y++) {
      for (let x = 0; x < this.cols; x++) {
        const i = y * this.cols + x;
        const lit = this.glow[i]!;
        if (this.cells[i]) {
          c.fillStyle = this.light;
          c.fillRect(x * MODULE, y * MODULE, MODULE, MODULE);
        }
        if (lit > 0.01) {
          c.fillStyle = `rgba(255,255,255,${(this.cells[i] ? 0.9 : 0.25) * lit})`;
          c.fillRect(x * MODULE, y * MODULE, MODULE, MODULE);
        }
      }
    }
  }

  /**
   * A sealed message crossed. `ciphertext` is its base64 content exactly as the relay
   * carries it; `direction` is seen from this device.
   */
  cross(ciphertext: string, direction: 'out' | 'in'): void {
    if (this.cols === 0 || this.rows === 0) return;
    let bytes: Uint8Array;
    try {
      bytes = Uint8Array.from(atob(ciphertext.slice(0, 1024)), (ch) => ch.charCodeAt(0));
    } catch {
      return;
    }
    // A tall strip sits between two side-by-side screens and is crossed left to right;
    // a wide one sits between stacked screens and is crossed top to bottom.
    const tall = this.rows >= this.cols;
    const along = tall ? this.cols : this.rows;
    const across = tall ? this.rows : this.cols;
    const band = Math.min(BAND_ROWS, across);
    const start = Math.floor(Math.random() * (across - band + 1));
    const index = (a: number, b: number) => (tall ? (start + b) * this.cols + a : a * this.cols + start + b);
    const forward = direction === 'out';
    const started = performance.now();
    const bit = (n: number) => (bytes[(n >> 3) % bytes.length]! >> (n & 7)) & 1;

    const step = (now: number) => {
      const progress = this.reduced.matches ? 1 : Math.min(1, (now - started) / SWEEP_MS);
      const front = progress * (along + 4);
      for (let a = 0; a < along; a++) {
        const position = forward ? a : along - 1 - a;
        const behind = front - a;
        for (let b = 0; b < band; b++) {
          const i = index(position, b);
          if (behind >= 0) this.cells[i] = bit(position * band + b);
          this.glow[i] = behind >= 0 && progress < 1 ? Math.max(0, 1 - behind / 4) : 0;
        }
      }
      this.draw();
      if (progress < 1) this.frame = requestAnimationFrame(step);
    };
    cancelAnimationFrame(this.frame);
    this.glow.fill(0);
    this.frame = requestAnimationFrame(step);
  }
}
