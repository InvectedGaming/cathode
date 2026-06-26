import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdirSync, rmSync, existsSync, readFileSync } from "node:fs";
import { FFMPEG } from "./transcode.ts";
import { cachedSetting } from "../settings.ts";

/**
 * Mosaic cast — the controller's output for a TV / VLC / Plex.
 *
 * Compositing four live IPTV streams into one grid proved fundamentally
 * unreliable: each input joins mid-GOP and ffmpeg's xstack can't emit a frame
 * until ALL FOUR independently hit a keyframe, so it stalls unpredictably. So
 * the cast follows the controller instead: it streams the ONE channel you've
 * focused. A single keyframe-aligned input copied straight to HLS starts in a
 * couple seconds, every time. Focus a different tile and we re-point the cast —
 * the TV shows exactly what you're driving from the controller.
 */

const PORT = Number(process.env.PORT ?? 7777);
const OUT_ROOT = join(tmpdir(), "phospharr-mosaic");

function key(): string { return String(cachedSetting("access.streamKey") || ""); }
function feedUrl(id: number): string { return `http://127.0.0.1:${PORT}/mosaicfeed/${id}?key=${encodeURIComponent(key())}`; }

class MosaicCast {
  private proc: ReturnType<typeof Bun.spawn> | null = null;
  private channelId: number | null = null;
  private dir = "";
  private lastAccess = 0;
  private idle: ReturnType<typeof setInterval> | null = null;
  private lastErr = "";

  private async drain(proc: ReturnType<typeof Bun.spawn>) {
    try {
      const reader = (proc.stderr as ReadableStream<Uint8Array>).getReader();
      const dec = new TextDecoder();
      while (true) { const { done, value } = await reader.read(); if (done) break; if (value) this.lastErr = (this.lastErr + dec.decode(value)).slice(-2000); }
    } catch { /* gone */ }
  }

  /** Cast a channel (or switch to a new one). Returns the public playlist path. */
  start(channelId: number): { playlist: string } {
    if (this.proc && this.channelId === channelId) { this.lastAccess = Date.now(); return { playlist: "/mosaic/index.m3u8" }; }
    if (this.proc) { try { this.proc.kill(); } catch { /* noop */ } this.proc = null; }
    this.channelId = channelId;
    this.dir = join(OUT_ROOT, String(PORT));
    try { rmSync(this.dir, { recursive: true, force: true }); } catch { /* noop */ }
    mkdirSync(this.dir, { recursive: true });
    // Single keyframe-aligned input, copied (no re-encode) → clean fast HLS start.
    const args = [
      "-hide_banner", "-loglevel", "error", "-fflags", "+genpts", "-i", feedUrl(channelId),
      "-map", "0:v:0?", "-map", "0:a:0?", "-c", "copy",
      "-f", "hls", "-hls_time", "2", "-hls_list_size", "6",
      "-hls_flags", "delete_segments+append_list+omit_endlist",
      "-hls_segment_filename", join(this.dir, "seg_%d.ts"), join(this.dir, "index.m3u8"),
    ];
    this.proc = Bun.spawn([FFMPEG, ...args], { stdout: "ignore", stderr: "pipe" });
    this.lastErr = "";
    void this.drain(this.proc);
    this.lastAccess = Date.now();
    if (!this.idle) this.idle = setInterval(() => { if (this.proc && Date.now() - this.lastAccess > 30_000) this.stop(); }, 5000);
    return { playlist: "/mosaic/index.m3u8" };
  }

  stop() {
    if (this.proc) { try { this.proc.kill(); } catch { /* noop */ } this.proc = null; }
    if (this.idle) { clearInterval(this.idle); this.idle = null; }
    this.channelId = null;
    if (this.dir) { try { rmSync(this.dir, { recursive: true, force: true }); } catch { /* noop */ } }
  }

  running(): boolean { return !!this.proc; }
  status() { return { running: !!this.proc, channel: this.channelId }; }

  file(name: string): { body: Uint8Array; type: string } | null {
    if (!this.dir || !/^[a-zA-Z0-9_.-]+$/.test(name)) return null;
    const p = join(this.dir, name);
    if (!existsSync(p)) return null;
    this.lastAccess = Date.now();
    const type = name.endsWith(".m3u8") ? "application/vnd.apple.mpegurl" : "video/mp2t";
    try { return { body: readFileSync(p), type }; } catch { return null; }
  }
}

export const mosaic = new MosaicCast();
