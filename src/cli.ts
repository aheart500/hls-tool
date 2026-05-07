#!/usr/bin/env node
import { existsSync } from "node:fs";
import * as path from "node:path";
import * as process from "node:process";

import { Command } from "commander";

import { convertToHls } from "./index.js";
import { RESOLUTION_MAP } from "./renditions.js";

const program = new Command();

program
  .name("hls-tool")
  .description(
    "Local FFmpeg-based HLS transcoder that mirrors AWS MediaConvert output.",
  )
  .requiredOption("-i, --input <file>", "Path to the input video file")
  .requiredOption(
    "-o, --output <dir>",
    "Output directory for HLS manifests and segments",
  )
  .option(
    "-r, --resolution <label>",
    `Source resolution label (one of: ${Object.keys(RESOLUTION_MAP).join(
      ", ",
    )}). Auto-detected from the file when omitted.`,
  )
  .option(
    "-n, --name <basename>",
    "Base name for playlists/segments (defaults to input filename without extension)",
  )
  .option(
    "--ffmpeg <path>",
    "Path to ffmpeg executable (defaults to 'ffmpeg' on PATH)",
  )
  .option(
    "--ffprobe <path>",
    "Path to ffprobe executable (defaults to 'ffprobe' on PATH)",
  )
  .option(
    "--preset <preset>",
    "x264 preset (ultrafast..placebo). Default: medium",
    "medium",
  )
  .option("--quiet", "Suppress progress output", false);

program.parse(process.argv);

const opts = program.opts<{
  input: string;
  output: string;
  resolution?: string;
  name?: string;
  ffmpeg?: string;
  ffprobe?: string;
  preset: string;
  quiet: boolean;
}>();

async function main() {
  const inputPath = path.resolve(opts.input);
  const outputDir = path.resolve(opts.output);

  if (!existsSync(inputPath)) {
    console.error(`Input file does not exist: ${inputPath}`);
    process.exit(1);
  }

  if (
    opts.resolution &&
    !Object.keys(RESOLUTION_MAP).includes(opts.resolution)
  ) {
    console.error(
      `Invalid --resolution "${opts.resolution}". ` +
        `Allowed: ${Object.keys(RESOLUTION_MAP).join(", ")}.`,
    );
    process.exit(1);
  }

  let lastPctPrinted = -1;

  const result = await convertToHls({
    inputPath,
    outputDir,
    sourceResolution: opts.resolution as
      | keyof typeof RESOLUTION_MAP
      | undefined,
    baseName: opts.name,
    ffmpegPath: opts.ffmpeg,
    ffprobePath: opts.ffprobe,
    preset: opts.preset,
    onProgress: opts.quiet
      ? undefined
      : (p) => {
          const pct = Math.floor(p * 100);
          if (pct !== lastPctPrinted) {
            lastPctPrinted = pct;
            process.stdout.write(`\rTranscoding... ${pct}%`);
            if (pct >= 100) process.stdout.write("\n");
          }
        },
  });

  if (!opts.quiet) {
    console.log(`\nDone.`);
    console.log(`Source resolution: ${result.sourceResolution}`);
    console.log(`Master playlist:   ${result.masterPlaylist}`);
    console.log(`Renditions:`);
    for (const r of result.renditions) {
      console.log(
        `  - ${r.shortName.padEnd(6)} ${r.width}x${r.height}  ` +
          `video<=${(r.maxBitrate / 1000).toFixed(0)}kbps  ` +
          `audio=${(r.audioBitrate / 1000).toFixed(0)}kbps`,
      );
    }
  }
}

main().catch((err) => {
  console.error("\n[hls-tool] Error:", err.message ?? err);
  process.exit(1);
});
