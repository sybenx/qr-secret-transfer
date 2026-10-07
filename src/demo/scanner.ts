// Reading a QR code with this page's own camera.
//
// Whether a pairing was read by the client's own camera matters to the protocol: it
// is the one channel that shows the code was physically in front of the user (spec
// §9.1), so only a scan made here counts as one.

import { QRCanvas, frameLoop, rearCamera } from 'qr/dom.js';

export type ScanProblem = 'denied' | 'no-camera' | 'insecure' | 'failed';

export interface Scanner {
  stop(): void;
}

function classify(error: unknown): ScanProblem {
  const name = error instanceof Error ? error.name : '';
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'denied';
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'no-camera';
  return 'failed';
}

/**
 * Starts the camera into `video` and calls `onText` for every QR code it reads, until
 * `onText` returns true. Calls `onProblem` once if the camera cannot be used.
 */
export function startScanner(
  video: HTMLVideoElement,
  onText: (text: string) => boolean,
  onProblem: (problem: ScanProblem) => void,
): Scanner {
  let stopped = false;
  let cancelLoop: (() => void) | undefined;
  let camera: Awaited<ReturnType<typeof rearCamera>> | undefined;

  const stop = () => {
    stopped = true;
    cancelLoop?.();
    try {
      camera?.stop();
    } catch {
      // already stopped
    }
  };

  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    queueMicrotask(() => onProblem('insecure'));
    return { stop };
  }

  void (async () => {
    try {
      camera = await rearCamera(video);
    } catch (error) {
      if (!stopped) onProblem(classify(error));
      return;
    }
    if (stopped) return stop();
    const canvas = new QRCanvas();
    let last = '';
    let busy = false;
    cancelLoop = frameLoop(() => {
      if (stopped || busy || !camera) return;
      busy = true;
      // readFrame resolves with the decoded text, or undefined for a frame with no code in it.
      Promise.resolve()
        .then(() => camera!.readFrame(canvas))
        .then((decoded) => {
          if (stopped || typeof decoded !== 'string' || decoded === '' || decoded === last) return;
          last = decoded;
          if (onText(decoded)) stop();
        })
        .catch(() => {})
        .finally(() => {
          busy = false;
        });
    });
  })();

  return { stop };
}
