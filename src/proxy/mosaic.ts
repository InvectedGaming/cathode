import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdirSync, rmSync, existsSync, readFileSync } from "node:fs";
import { FFMPEG } from "./transcode.ts";
import { cachedSetting } from "../settings.ts";

/**
 * Mosaic compositor — combines several live channels into ONE stream.
 *
 * A single long-lived ffmpeg pulls each slot's channel from our own local
 * /stream endpoint (so it shares the muxer fan-out — one provider slot per
 * channel, reused with the in-browser tiles), tiles them into a grid, and writes
 * a sliding-window live HLS playlist. That playlist is the single, castable link
 * the user can open on a TV / VLC / Plex or play in-browser via hls.js.
 *
 * Interactive focus/audio switching is done CLIENT-SIDE (independent <video>
 * tiles) where it's instant; this server composite is the shared single output.
 * Changing the channel set / audio tile restarts ffmpeg (a brief reconnect) —
 * acceptable for the cast stream; the per-viewer browser view stays seamless.
 */

const PORT = Number(process.env.PORT ?? 7777);
const OUT_ROOT = join(tmpdir(), "phospharr-mosaic");

type Cfg = { channels: number[]; cols: number; audio: number };

function key(): string { return String(cachedSetting("access.streamKey") || ""); }
function localStreamUrl(id: number): string {
  // /mosaicfeed (not /stream) → a keyframe-aligned start so the grid syncs fast.
  return `http://127.0.0.1:${PORT}/mosaicfeed/${id}?key=${encodeURIComponent(key())}`;
}

// Build the filter_complex for an n-up grid laid out in `cols` columns on a
// 1280x720 canvas. Each tile is letterboxed (no distortion) into its cell.
function buildGraph(n: number, cols: number): string {
  const W = 1280, H = 720;
  const rows = Math.ceil(n / cols);
  const tw = Math.floor(W / cols), th = Math.floor(H / rows);
  const parts: string[] = [];
  const labels: string[] = [];
  const layout: string[] = [];
  for (let i = 0; i < n; i++) {
    // setpts=PTS-STARTPTS zeroes each input's timeline — live TS sources each
    // carry their own clock, and without this xstack's frame-sync waits forever
    // for timestamps that never overlap (the grid never starts).
    parts.push(`[${i}:v]scale=${tw}:${th}:force_original_aspect_ratio=decrease,pad=${tw}:${th}:(ow-iw)/2:(oh-ih)/2:black,setsar=1,fps=30,setpts=PTS-STARTPTS[v${i}]`);
    labels.push(`[v${i}]`);
    layout.push(`${(i % cols) * tw}_${Math.floor(i / cols) * th}`);
  }
  parts.push(`${labels.join("")}xstack=inputs=${n}:layout=${layout.join("|")}:fill=black[vout]`);
  return parts.join(";");
}

class MosaicComposite {
  private proc: ReturnType<typeof Bun.spawn> | null = null;
  private cfg: Cfg | null = null;
  private dir = "";
  private lastAccess = 0;
  private idle: ReturnType<typeof setInterval> | null = null;
  private lastErr = "";

  // Continuously drain ffmpeg's stderr. Compositing 4 mid-stream joins floods it
  // with H.264 resync errors; if we leave the pipe unread it fills and ffmpeg
  // BLOCKS writing to it — producing no output at all. We keep only the tail.
  private async drain(proc: ReturnType<typeof Bun.spawn>) {
    try {
      const reader = (proc.stderr as ReadableStream<Uint8Array>).getReader();
      const dec = new TextDecoder();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) this.lastErr = (this.lastErr + dec.decode(value)).slice(-2000);
      }
    } catch { /* process gone */ }
  }

  private sameCfg(a: Cfg, b: Cfg): boolean {
    return a.cols === b.cols && a.audio === b.audio && a.channels.length === b.channels.length && a.channels.every((c, i) => c === b.channels[i]);
  }

  /** Start (or reconfigure) the composite. Returns the public playlist path. */
  start(channels: number[], cols: number, audio: number): { playlist: string } {
    const cfg: Cfg = { channels: channels.slice(), cols, audio: Math.max(0, Math.min(audio, channels.length - 1)) };
    if (this.proc && this.cfg && this.sameCfg(this.cfg, cfg)) { this.lastAccess = Date.now(); return { playlist: "/mosaic/index.m3u8" }; }
    this.stop();
    this.cfg = cfg;
    this.dir = join(OUT_ROOT, String(PORT));
    try { rmSync(this.dir, { recursive: true, force: true }); } catch { /* noop */ }
    mkdirSync(this.dir, { recursive: true });

    const inputs: string[] = [];
    // -thread_queue_size buffers each input independently — without it, xstack
    // blocking on the slowest-to-sync input starves the others, the muxer drops
    // their data under backpressure, and they desync too (the grid never starts).
    // No -reconnect: on an infinite chunked /stream, -reconnect_streamed makes
    // ffmpeg treat the continuous read as disconnects. Re-enable if a channel drops.
    for (const id of cfg.channels) inputs.push("-thread_queue_size", "1024", "-i", localStreamUrl(id));
    const args = [
      "-hide_banner", "-loglevel", "error", "-fflags", "+genpts+discardcorrupt", "-err_detect", "ignore_err",
      ...inputs,
      "-filter_complex", buildGraph(cfg.channels.length, cfg.cols),
      "-map", "[vout]", "-map", `${cfg.audio}:a:0?`,
      "-af", "aresample=async=1:first_pts=0", // realign the picked audio to the zeroed video clock
      "-c:v", "libx264", "-preset", "veryfast", "-tune", "zerolatency", "-g", "60", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-ac", "2", "-b:a", "128k",
      "-f", "hls", "-hls_time", "2", "-hls_list_size", "6",
      "-hls_flags", "delete_segments+append_list+omit_endlist",
      "-hls_segment_filename", join(this.dir, "seg_%d.ts"), join(this.dir, "index.m3u8"),
    ];
    this.proc = Bun.spawn([FFMPEG, ...args], { stdout: "ignore", stderr: "pipe" });
    this.lastErr = "";
    void this.drain(this.proc);
    this.lastAccess = Date.now();
    // Idle-stop: HLS players poll the playlist every couple seconds; if nobody
    // has for a while, tear the encoder (and its 4 upstreams) down.
    // Wide grace: a 4-input grid can take ~20-30s to sync before the first
    // segment, so don't idle-stop until well past that with no playlist fetch.
    if (!this.idle) this.idle = setInterval(() => { if (this.proc && Date.now() - this.lastAccess > 50_000) this.stop(); }, 5000);
    return { playlist: "/mosaic/index.m3u8" };
  }

  stop() {
    if (this.proc) { try { this.proc.kill(); } catch { /* noop */ } this.proc = null; }
    if (this.idle) { clearInterval(this.idle); this.idle = null; }
    this.cfg = null;
    if (this.dir) { try { rmSync(this.dir, { recursive: true, force: true }); } catch { /* noop */ } }
  }

  running(): boolean { return !!this.proc; }
  errTail(): string { return this.lastErr; }
  status() { return { running: !!this.proc, channels: this.cfg?.channels ?? [], audio: this.cfg?.audio ?? 0, cols: this.cfg?.cols ?? 2 }; }

  /** Serve a playlist/segment file by name; touches lastAccess to stay warm. */
  file(name: string): { body: Uint8Array; type: string } | null {
    if (!this.dir || !/^[a-zA-Z0-9_.-]+$/.test(name)) return null;
    const p = join(this.dir, name);
    if (!existsSync(p)) return null;
    this.lastAccess = Date.now();
    const type = name.endsWith(".m3u8") ? "application/vnd.apple.mpegurl" : "video/mp2t";
    try { return { body: readFileSync(p), type }; } catch { return null; }
  }
}

export const mosaic = new MosaicComposite();
