// Drawing a QR code as SVG, from the module matrix.

import encodeQR from 'qr';
import { svg } from './dom.ts';

/**
 * Renders `text` as a QR code, quiet zone included.
 * Nothing is overlaid on it (spec §11.2b), so medium error correction is enough.
 */
export function qrSvg(text: string, label: string): SVGElement {
  // The library draws the quiet zone itself: four modules, as the symbology asks.
  const modules = encodeQR(text, 'raw', { ecc: 'medium', border: 4 });
  const size = modules.length;
  let d = '';
  for (let y = 0; y < size; y++) {
    const row = modules[y]!;
    for (let x = 0; x < size; x++) {
      if (!row[x]) continue;
      // Merge a horizontal run into one rectangle.
      let run = 1;
      while (x + run < size && row[x + run]) run++;
      d += `M${x} ${y}h${run}v1h-${run}z`;
      x += run - 1;
    }
  }
  return svg(
    'svg',
    { viewBox: `0 0 ${size} ${size}`, role: 'img', 'aria-label': label, 'shape-rendering': 'crispEdges', class: 'qr-code' },
    svg('rect', { width: size, height: size, fill: '#fff' }),
    svg('path', { d, fill: '#000' }),
  );
}
