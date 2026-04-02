'use client';

import {
  acquireSimliSession,
  releaseSimliSession,
} from '@/lib/simliSessionManager';

let aborted = false;

/** Call this before starting an interview to stop any background captures. */
export function abortCaptures(): void {
  aborted = true;
}

/** Reset abort flag — call when returning to the interviewers page. */
export function resumeCaptures(): void {
  aborted = false;
}

async function captureFrame(faceId: string): Promise<string> {
  const { stream } = await acquireSimliSession(faceId);

  try {
    if (!stream) {
      throw new Error('No stream available');
    }

    const videoEl = document.createElement('video');
    videoEl.muted = true;
    videoEl.autoplay = true;
    videoEl.playsInline = true;
    videoEl.style.cssText = 'position:fixed;top:-9999px;left:-9999px;width:1px;height:1px;opacity:0;pointer-events:none;';
    document.body.appendChild(videoEl);
    videoEl.srcObject = stream;

    await new Promise<void>((resolve) => {
      const fallback = setTimeout(resolve, 5000);
      const abortCheck = setInterval(() => {
        if (aborted) { clearTimeout(fallback); clearInterval(abortCheck); resolve(); }
      }, 200);
      videoEl.addEventListener(
        'canplay',
        () =>
          setTimeout(() => {
            clearTimeout(fallback);
            clearInterval(abortCheck);
            resolve();
          }, 2000),
        { once: true }
      );
    });

    const canvas = document.createElement('canvas');
    canvas.width = videoEl.videoWidth || 300;
    canvas.height = videoEl.videoHeight || 300;
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(videoEl, 0, 0);
    videoEl.remove();

    // Reject blank/black frames — sample pixels and check average brightness
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    let total = 0;
    const step = 4 * 50; // sample every 50th pixel for speed
    let count = 0;
    for (let i = 0; i < data.length; i += step) {
      total += (data[i] + data[i + 1] + data[i + 2]) / 3;
      count++;
    }
    const avgBrightness = total / count;
    if (avgBrightness < 10) {
      throw new Error('Blank frame captured (avg brightness: ' + avgBrightness.toFixed(1) + ')');
    }

    return canvas.toDataURL('image/jpeg', 0.85);
  } finally {
    releaseSimliSession(faceId);
    await new Promise((r) => setTimeout(r, 1500));
  }
}

// Module-level queue — guarantees only 1 Simli connection at a time
let queue = Promise.resolve();

export function queueThumbnailCapture(
  faceId: string,
  onReady: (dataUrl: string) => void,
  interviewerId?: string | number | bigint
): void {
  queue = queue.then(async () => {
    if (aborted) {
      return;
    }

    const MAX_RETRIES = 3;
    let dataUrl: string | null = null;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      if (aborted) { return; }
      try {
        dataUrl = await captureFrame(faceId);
        break;
      } catch (err: any) {
        console.warn(`[AvatarThumbnail] attempt ${attempt}/${MAX_RETRIES} failed for`, faceId, err?.message);
        if (attempt < MAX_RETRIES) {
          await new Promise((r) => setTimeout(r, 2000 * attempt));
        }
      }
    }

    if (!dataUrl) {
      console.error('[AvatarThumbnail] all capture attempts failed for', faceId);
      return;
    }

    // Show immediately in-session via in-memory state
    onReady(dataUrl);

    // Persist to Supabase Storage in the background (non-blocking)
    if (interviewerId) {
      fetch('/api/upload-avatar-thumbnail', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ interviewerId: String(interviewerId), dataUrl }),
      }).catch(() => {});
    }
  });
}
