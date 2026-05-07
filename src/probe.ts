import { spawn } from "node:child_process";

export interface ProbeResult {
  width: number;
  height: number;
  durationSeconds: number;
  frameRate: number;
  hasAudio: boolean;
}

/** Run ffprobe and return basic video stream info. */
export async function probeVideo(
  inputPath: string,
  ffprobePath = "ffprobe",
): Promise<ProbeResult> {
  const args = [
    "-v",
    "error",
    "-show_entries",
    "stream=index,codec_type,width,height,r_frame_rate:format=duration",
    "-of",
    "json",
    inputPath,
  ];

  const stdout = await runCapture(ffprobePath, args);
  const parsed = JSON.parse(stdout) as {
    streams?: Array<{
      codec_type?: string;
      width?: number;
      height?: number;
      r_frame_rate?: string;
    }>;
    format?: { duration?: string };
  };

  const streams = parsed.streams ?? [];
  const videoStream = streams.find((s) => s.codec_type === "video");
  const hasAudio = streams.some((s) => s.codec_type === "audio");

  if (!videoStream || !videoStream.width || !videoStream.height) {
    throw new Error(`ffprobe could not read video stream from: ${inputPath}`);
  }

  const [num, den] = (videoStream.r_frame_rate ?? "30/1").split("/").map(Number);
  const frameRate = den && den !== 0 ? num / den : 30;

  return {
    width: videoStream.width,
    height: videoStream.height,
    durationSeconds: parsed.format?.duration
      ? Number(parsed.format.duration)
      : 0,
    frameRate,
    hasAudio,
  };
}

function runCapture(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (c) => (out += c.toString()));
    child.stderr.on("data", (c) => (err += c.toString()));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(out);
      else reject(new Error(`${cmd} exited with code ${code}: ${err.trim()}`));
    });
  });
}
