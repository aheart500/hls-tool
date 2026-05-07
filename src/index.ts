import * as path from "node:path";

import { probeVideo } from "./probe.js";
import {
  RENDITIONS,
  RESOLUTION_MAP,
  RenditionConfig,
  bucketResolution,
} from "./renditions.js";
import { transcodeToHls } from "./transcode.js";

export interface ConvertOptions {
  inputPath: string;
  outputDir: string;
  /**
   * Optional source resolution label (e.g. "1080p"). When omitted, the source
   * resolution is detected from the file via ffprobe.
   */
  sourceResolution?: keyof typeof RESOLUTION_MAP;
  baseName?: string;
  ffmpegPath?: string;
  ffprobePath?: string;
  preset?: string;
  onProgress?: (progress: number) => void;
}

export interface ConvertResult {
  masterPlaylist: string;
  renditionPlaylists: string[];
  renditions: RenditionConfig[];
  sourceResolution: string;
}

/**
 * Convert a single input video into a multi-bitrate HLS package matching the
 * AWS MediaConvert output layout used by the original Lambda.
 */
export async function convertToHls(
  opts: ConvertOptions,
): Promise<ConvertResult> {
  const probe = await probeVideo(opts.inputPath, opts.ffprobePath);

  const detected = bucketResolution(probe.height);
  const sourceResolution = opts.sourceResolution ?? detected;
  const allowed = RESOLUTION_MAP[sourceResolution] ?? RESOLUTION_MAP["480p"];

  const renditions = RENDITIONS.filter((r) => allowed.includes(r.nameModifier));

  if (renditions.length === 0) {
    throw new Error(
      `No renditions matched source resolution "${sourceResolution}".`,
    );
  }

  const baseName = opts.baseName ?? path.parse(opts.inputPath).name;

  await transcodeToHls({
    inputPath: opts.inputPath,
    outputDir: opts.outputDir,
    renditions,
    baseName,
    ffmpegPath: opts.ffmpegPath,
    durationSeconds: probe.durationSeconds,
    onProgress: opts.onProgress,
    preset: opts.preset,
    hasAudio: probe.hasAudio,
  });

  return {
    masterPlaylist: path.join(opts.outputDir, `${baseName}.m3u8`),
    renditionPlaylists: renditions.map((r) =>
      path.join(opts.outputDir, `${baseName}_${r.shortName}.m3u8`),
    ),
    renditions,
    sourceResolution,
  };
}

export { RENDITIONS, RESOLUTION_MAP } from "./renditions.js";
