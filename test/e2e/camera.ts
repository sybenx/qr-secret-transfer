// A fake camera feed for Chromium: a still picture of a QR code, as a Y4M video file.

import { writeFile } from 'node:fs/promises';
import encodeQR from 'qr';

export async function qrVideo(text: string, path: string): Promise<void> {
  const W = 640;
  const H = 480;
  const modules = encodeQR(text, 'raw', { ecc: 'medium', border: 4 });
  const scale = Math.floor(420 / modules.length);
  const side = modules.length * scale;
  const left = Math.floor((W - side) / 2);
  const top = Math.floor((H - side) / 2);
  const y = new Uint8Array(W * H).fill(110); // a grey desk around the screen
  for (let row = 0; row < side; row++) {
    for (let col = 0; col < side; col++) {
      const dark = modules[Math.floor(row / scale)]![Math.floor(col / scale)];
      y[(top + row) * W + left + col] = dark ? 20 : 230;
    }
  }
  const chroma = new Uint8Array((W / 2) * (H / 2)).fill(128);
  const frame = Buffer.concat([Buffer.from('FRAME\n'), y, chroma, chroma]);
  const header = Buffer.from(`YUV4MPEG2 W${W} H${H} F15:1 Ip A1:1 C420jpeg\n`);
  await writeFile(path, Buffer.concat([header, ...Array.from({ length: 15 }, () => frame)]));
}
