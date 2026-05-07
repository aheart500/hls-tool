import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import * as path from "node:path";

import { HLS_SETTINGS, RenditionConfig } from "./renditions.js";

export interface TranscodeOptions {
  inputPath: string;
  outputDir: string;
  /** Renditions selected for this source (already filtered by resolution). */
  renditions: RenditionConfig[];
  /** Optional base name used for playlists/segments. Defaults to input basename. */
  baseName?: string;
  /** Path/name of ffmpeg executable. Defaults to "ffmpeg" on PATH. */
  ffmpegPath?: string;
  /** Approximate duration in seconds (from ffprobe) for progress reporting. */
  durationSeconds?: number;
  /** Called with a 0..1 progress value as encoding proceeds. */
  onProgress?: (progress: number) => void;
  /** x264 preset (speed/quality trade-off). Default: "medium". */
  preset?: string;
  /** Whether the source has an audio stream. Default: true. */
  hasAudio?: boolean;
}

/**
 * Build the FFmpeg argument list for a multi-rendition HLS encode.
 * Exposed for testability.
 */
export function buildFfmpegArgs(opts: TranscodeOptions): string[] {
  const {
    inputPath,
    outputDir,
    renditions,
    baseName = path.parse(inputPath).name,
    preset = "medium",
    hasAudio = true,
  } = opts;

  if (renditions.length === 0) {
    throw new Error("No renditions selected.");
  }

  // ---- filter_complex: split source video N ways and scale each branch ----
  const splitLabels = renditions.map((_, i) => `[v${i}_in]`).join("");
  const splitChain = `[0:v]split=${renditions.length}${splitLabels}`;

  const scaleChains = renditions.map((r, i) => {
    // Preserve aspect ratio, letterbox/pillarbox to exact W:H.
    // This matches MediaConvert's default scaling behaviour for non-matching
    // input aspect ratios.
    return (
      `[v${i}_in]scale=${r.width}:${r.height}:force_original_aspect_ratio=decrease,` +
      `pad=${r.width}:${r.height}:(ow-iw)/2:(oh-ih)/2:color=black,` +
      `setsar=1[v${i}]`
    );
  });

  const filterComplex = [splitChain, ...scaleChains].join(";");

  // ---- map outputs: one video branch + duplicate audio per rendition ----
  const mapArgs: string[] = [];
  renditions.forEach((_, i) => {
    mapArgs.push("-map", `[v${i}]`);
    if (hasAudio) {
      mapArgs.push("-map", "0:a:0");
    }
  });

  // ---- per-stream codec settings ----
  const perStreamCodecArgs: string[] = [];
  renditions.forEach((r, i) => {
    // Quality-based encoding (CRF) capped by maxrate/bufsize approximates
    // MediaConvert's QVBR rate-control mode.
    perStreamCodecArgs.push(
      `-crf:v:${i}`,
      String(r.crf),
      `-maxrate:v:${i}`,
      String(r.maxBitrate),
      `-bufsize:v:${i}`,
      String(r.maxBitrate * 2),
    );
    if (hasAudio) {
      perStreamCodecArgs.push(`-b:a:${i}`, String(r.audioBitrate));
    }
  });

  // ---- HLS variant stream map (drives the master playlist) ----
  const varStreamMap = renditions
    .map((r, i) =>
      hasAudio
        ? `v:${i},a:${i},name:${r.shortName}`
        : `v:${i},name:${r.shortName}`,
    )
    .join(" ");

  // FFmpeg's hls muxer substitutes %v with the `name:` value from the
  // var_stream_map, producing files like <base>_1080p.m3u8 and
  // <base>_1080p_00001.ts in a single directory.
  const segmentPattern = path.join(outputDir, `${baseName}_%v_%05d.ts`);
  const playlistPattern = path.join(outputDir, `${baseName}_%v.m3u8`);
  const masterName = `${baseName}.m3u8`;

  const args: string[] = [
    "-y",
    "-hide_banner",
    "-nostats",
    "-i",
    inputPath,
    "-filter_complex",
    filterComplex,
    ...mapArgs,

    // ---- video codec (applies to all video streams) ----
    "-c:v",
    "libx264",
    "-profile:v",
    "high",
    "-preset",
    preset,
    // GopSize: 90 + closed GOP so HLS segments align cleanly.
    "-g",
    String(HLS_SETTINGS.gopSize),
    "-keyint_min",
    String(HLS_SETTINGS.gopSize),
    // SceneChangeDetect: TRANSITION_DETECTION (x264 default scenecut threshold).
    "-sc_threshold",
    "40",
    // GopBReference: ENABLED (B-frames as reference / b-pyramid).
    "-bf",
    "3",
    "-x264opts",
    "b-pyramid=normal",
    // Pixel format compatible with HIGH profile + broad device support.
    "-pix_fmt",
    "yuv420p",

    ...(hasAudio
      ? [
          // ---- audio codec (applies to all audio streams) ----
          "-c:a",
          "aac",
          "-ar",
          "48000",
          "-ac",
          "2",
        ]
      : []),

    ...perStreamCodecArgs,

    // ---- HLS muxer ----
    "-f",
    "hls",
    "-hls_time",
    String(HLS_SETTINGS.segmentSeconds),
    "-hls_playlist_type",
    "vod",
    "-hls_segment_type",
    "mpegts",
    "-hls_flags",
    "independent_segments",
    "-hls_list_size",
    "0",
    "-master_pl_name",
    masterName,
    "-var_stream_map",
    varStreamMap,
    "-hls_segment_filename",
    segmentPattern,

    // Progress to stdout for easy parsing.
    "-progress",
    "pipe:1",

    playlistPattern,
  ];

  return args;
}

/** Run FFmpeg and resolve when transcoding finishes successfully. */
export async function transcodeToHls(opts: TranscodeOptions): Promise<void> {
  const ffmpegPath = opts.ffmpegPath ?? "ffmpeg";

  await mkdir(opts.outputDir, { recursive: true });

  const args = buildFfmpegArgs(opts);

  await new Promise<void>((resolve, reject) => {
    const child = spawn(ffmpegPath, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stderrTail = "";
    const TAIL_LIMIT = 4000;

    // ---- progress parsing from -progress pipe:1 ----
    let stdoutBuf = "";
    child.stdout.on("data", (chunk) => {
      stdoutBuf += chunk.toString();
      let idx: number;
      while ((idx = stdoutBuf.indexOf("\n")) !== -1) {
        const line = stdoutBuf.slice(0, idx).trim();
        stdoutBuf = stdoutBuf.slice(idx + 1);
        const eq = line.indexOf("=");
        if (eq === -1) continue;
        const key = line.slice(0, eq);
        const val = line.slice(eq + 1);
        if (key === "out_time_ms" && opts.onProgress && opts.durationSeconds) {
          // out_time_ms is actually microseconds in current ffmpeg builds.
          const us = Number(val);
          if (!Number.isNaN(us) && opts.durationSeconds > 0) {
            const seconds = us / 1_000_000;
            const pct = Math.max(
              0,
              Math.min(1, seconds / opts.durationSeconds),
            );
            opts.onProgress(pct);
          }
        }
      }
    });

    child.stderr.on("data", (chunk) => {
      const s = chunk.toString();
      stderrTail = (stderrTail + s).slice(-TAIL_LIMIT);
    });

    child.on("error", (err) => {
      reject(
        new Error(
          `Failed to start ffmpeg ("${ffmpegPath}"): ${err.message}. ` +
            `Make sure FFmpeg is installed and on PATH.`,
        ),
      );
    });

    child.on("close", (code) => {
      if (code === 0) {
        if (opts.onProgress) opts.onProgress(1);
        resolve();
      } else {
        reject(
          new Error(
            `ffmpeg exited with code ${code}.\n` +
              `--- ffmpeg stderr (tail) ---\n${stderrTail}`,
          ),
        );
      }
    });
  });
}
