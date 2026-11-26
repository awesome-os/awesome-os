/**
 * @file assets/generate-splash.mts
 * @description Deterministic Zero-Dependency Splash Screen Generator for Awesome-OS Bootloaders.
 *
 * Emits uncompressed 24-bit BI_RGB bottom-up BMPs (guaranteed compatible with Limine,
 * UEFI GOP, ACPI BGRT, and Linux SimpleDRM) plus a matching vector SVG for seamless
 * UI handoff into Sectium Canvas / Host Manager.
 *
 * Strictly `erasableSyntaxOnly: true`, Node 22+ built-ins only.
 */

import fs from 'node:fs';
import path from 'node:path';

export interface SplashSpec {
  readonly width: number;
  readonly height: number;
  readonly filename: string;
}

export const SPLASH_SPECS: readonly SplashSpec[] = [
  { width: 640, height: 480, filename: 'awesome-os-640x480.bmp' },
  { width: 1024, height: 768, filename: 'awesome-os-1024x768.bmp' },
  { width: 1920, height: 1080, filename: 'awesome-os-1920x1080.bmp' },
];

function clampByte(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
}

/**
 * Generates an uncompressed 24-bit BI_RGB bottom-up BMP buffer with the Awesome-OS
 * Neutral Graphite backdrop (#0E1116), soft Lumi Cyan aura (#39C5CF), geometric
 * hollow emblem, and bottom boot progress track.
 */
export function renderSplashBmp24(width: number, height: number): Uint8Array {
  const rowStride = Math.ceil((width * 3) / 4) * 4;
  const pixelBytes = rowStride * height;
  const fileSize = 54 + pixelBytes;
  const buf = new Uint8Array(fileSize);
  const view = new DataView(buf.buffer);

  // BITMAPFILEHEADER (14 bytes)
  buf[0] = 0x42; // 'B'
  buf[1] = 0x4d; // 'M'
  view.setUint32(2, fileSize, true);
  view.setUint32(6, 0, true);
  view.setUint32(10, 54, true);

  // BITMAPINFOHEADER (40 bytes)
  view.setUint32(14, 40, true);
  view.setInt32(18, width, true);
  view.setInt32(22, height, true); // positive = bottom-up (max UEFI/Limine compat)
  view.setUint16(26, 1, true); // planes
  view.setUint16(28, 24, true); // 24-bit BGR
  view.setUint32(30, 0, true); // BI_RGB (uncompressed)
  view.setUint32(34, pixelBytes, true);
  view.setInt32(38, 2835, true); // 72 DPI
  view.setInt32(42, 2835, true);
  view.setUint32(46, 0, true);
  view.setUint32(50, 0, true);

  const cx = width * 0.5;
  const cy = height * 0.46;
  const minDim = Math.min(width, height);
  const rOuter = minDim * 0.145;
  const rInner = minDim * 0.118;
  const rCore = minDim * 0.042;
  const barY = Math.round(height * 0.72);
  const barHalfW = Math.round(minDim * 0.18);
  const barHalfH = Math.max(2, Math.round(minDim * 0.005));

  for (let y = 0; y < height; y++) {
    // Bottom-up BMP row index
    const bmpRow = height - 1 - y;
    const rowOff = 54 + bmpRow * rowStride;
    const dy = y - cy;

    for (let x = 0; x < width; x++) {
      const dx = x - cx;
      const dist = Math.hypot(dx, dy);

      // Base graphite backdrop (#0E1116) + subtle radial vignette glow
      const glow = Math.exp(-(dist * dist) / (2 * (minDim * 0.36) * (minDim * 0.36)));
      let r = 14 + glow * 14;
      let g = 17 + glow * 26;
      let b = 22 + glow * 34;

      // Outer Lumi Cyan precision ring (#39C5CF)
      if (dist <= rOuter && dist >= rInner) {
        const angle = Math.atan2(dy, dx);
        const accent = 0.72 + 0.28 * Math.cos(angle - Math.PI * 0.25);
        r = 57 * accent;
        g = 197 * accent;
        b = 207 * accent;
      }

      // Inner diamond / prism core (#E6EDF3)
      const manhattan = Math.abs(dx) + Math.abs(dy);
      if (manhattan <= rCore * 1.45 && manhattan >= rCore * 0.85) {
        r = 230;
        g = 237;
        b = 243;
      } else if (dist <= rCore * 0.45) {
        r = 86;
        g = 212;
        b = 221;
      }

      // Minimal boot progress rail (matches UEFI GOP holo_splash_draw_progress)
      if (Math.abs(y - barY) <= barHalfH && Math.abs(x - cx) <= barHalfW) {
        const progressEnd = cx - barHalfW + barHalfW * 2 * 0.34;
        if (x <= progressEnd) {
          r = 57;
          g = 197;
          b = 207;
        } else {
          r = 36;
          g = 43;
          b = 54;
        }
      }

      const off = rowOff + x * 3;
      buf[off] = clampByte(b);
      buf[off + 1] = clampByte(g);
      buf[off + 2] = clampByte(r);
    }
  }

  return buf;
}

export function renderSplashSvg(): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1920 1080" width="1920" height="1080">
  <defs>
    <radialGradient id="bgGlow" cx="50%" cy="46%" r="48%">
      <stop offset="0%" stop-color="#1C2B38"/>
      <stop offset="100%" stop-color="#0E1116"/>
    </radialGradient>
    <linearGradient id="lumiRing" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#56D4DD"/>
      <stop offset="100%" stop-color="#39C5CF"/>
    </linearGradient>
  </defs>
  <rect width="1920" height="1080" fill="url(#bgGlow)"/>
  <circle cx="960" cy="497" r="142" fill="none" stroke="url(#lumiRing)" stroke-width="26"/>
  <polygon points="960,432 1025,497 960,562 895,497" fill="none" stroke="#E6EDF3" stroke-width="14"/>
  <circle cx="960" cy="497" r="20" fill="#56D4DD"/>
  <rect x="766" y="772" width="388" height="10" rx="5" fill="#242B36"/>
  <rect x="766" y="772" width="132" height="10" rx="5" fill="#39C5CF"/>
  <text x="960" y="838" text-anchor="middle" fill="#8B949E" font-family="ui-sans-serif, system-ui, sans-serif" font-size="22" letter-spacing="4">AWESOME-OS · HOLO-LINUX 7.3.6 · V11 CAS</text>
</svg>
`;
}

if (import.meta.main) {
  const outDir = path.join(import.meta.dirname, 'splash');
  fs.mkdirSync(outDir, { recursive: true });
  for (const spec of SPLASH_SPECS) {
    const bmp = renderSplashBmp24(spec.width, spec.height);
    const outPath = path.join(outDir, spec.filename);
    fs.writeFileSync(outPath, bmp);
    console.log(`wrote ${outPath} (${bmp.byteLength} bytes)`);
  }
  const svgPath = path.join(outDir, 'awesome-os-splash.svg');
  fs.writeFileSync(svgPath, renderSplashSvg(), 'utf8');
  console.log(`wrote ${svgPath}`);
}
