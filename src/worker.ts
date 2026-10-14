/// <reference lib="webworker" />
import { newAgg, add, finish, parseRobots } from "./core";

/**
 * Reads the log a chunk at a time — gzipped or not — so a few hundred
 * megabytes never sit in memory as one string, and the page stays responsive.
 */
self.onmessage = async (e: MessageEvent<{ file?: File; text?: string; robots: string }>) => {
  const { file, text, robots } = e.data;
  const agg = newAgg();
  const r = robots.trim() ? parseRobots(robots) : null;
  const post = (m: unknown) => (self as unknown as Worker).postMessage(m);
  try {
    if (text !== undefined) {
      for (const line of text.split(/\r?\n/)) if (line.trim()) add(agg, line, r);
    } else if (file) {
      const gz = /\.gz$/i.test(file.name) || (await file.slice(0, 2).arrayBuffer().then((b) => { const u = new Uint8Array(b); return u[0] === 0x1f && u[1] === 0x8b; }));
      let stream: ReadableStream<Uint8Array> = file.stream();
      if (gz) stream = stream.pipeThrough(new DecompressionStream("gzip") as unknown as ReadableWritablePair<Uint8Array, Uint8Array>);
      const reader = stream.pipeThrough(new TextDecoderStream() as unknown as ReadableWritablePair<string, Uint8Array>).getReader();
      let carry = "", read = 0, lastPost = 0;
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        read += value.length;
        const parts = (carry + value).split(/\r?\n/);
        carry = parts.pop() ?? "";
        for (const line of parts) if (line.trim()) add(agg, line, r);
        const now = performance.now();
        if (now - lastPost > 120) { lastPost = now; post({ progress: { lines: agg.lines, chars: read, total: gz ? null : file.size } }); }
      }
      if (carry.trim()) add(agg, carry, r);
    }
    post({ result: finish(agg) });
  } catch (err) {
    post({ error: (err as Error).message });
  }
};
