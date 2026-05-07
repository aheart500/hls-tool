/**
 * Rendition configuration that mirrors the AWS MediaConvert job in the
 * original Lambda. Each entry maps a MediaConvert "Output" to its FFmpeg
 * equivalent.
 *
 * MediaConvert -> FFmpeg mapping:
 *   - H_264 / CodecProfile: HIGH         => -c:v libx264 -profile:v high
 *   - QVBR (QvbrQualityLevel)            => -crf <value> capped by -maxrate/-bufsize
 *                                           (CRF gives quality-based encoding similar
 *                                            to QVBR; maxrate enforces the same ceiling)
 *   - MaxBitrate                         => -maxrate <N> -bufsize <2N>
 *   - GopSize: 90                        => -g 90 -keyint_min 90
 *   - GopBReference: ENABLED             => -bf 3 (x264 b-pyramid default = normal)
 *   - SceneChangeDetect: TRANSITION_DET. => x264 default scenecut behaviour
 *   - FramerateControl: INITIALIZE_FROM_SOURCE => no -r flag (inherit source)
 *   - AAC / Bitrate / 48kHz / 2.0        => -c:a aac -b:a <N> -ar 48000 -ac 2
 */

export interface RenditionConfig {
  /** Suffix used on the playlist filename, matches MediaConvert NameModifier. */
  nameModifier: string;
  /** Short name used inside the master playlist's #EXT-X-STREAM-INF NAME tag. */
  shortName: string;
  width: number;
  height: number;
  /** CRF value approximating the QVBR QvbrQualityLevel.
   *  Lower CRF = higher quality. Mapping derived empirically:
   *    QvbrQualityLevel 9 -> CRF 19 (visually lossless-ish)
   *    QvbrQualityLevel 7 -> CRF 21
   *    QvbrQualityLevel 5 -> CRF 23 (default x264 quality)
   */
  crf: number;
  /** Hard ceiling matching MediaConvert MaxBitrate (bits/second). */
  maxBitrate: number;
  /** Audio bitrate in bits/second. */
  audioBitrate: number;
}

export const RENDITIONS: RenditionConfig[] = [
  {
    nameModifier: "_1080p",
    shortName: "1080p",
    width: 1920,
    height: 1080,
    crf: 19,
    maxBitrate: 5_000_000,
    audioBitrate: 128_000,
  },
  {
    nameModifier: "_720p",
    shortName: "720p",
    width: 1280,
    height: 720,
    crf: 21,
    maxBitrate: 2_500_000,
    audioBitrate: 96_000,
  },
  {
    nameModifier: "_480p",
    shortName: "480p",
    width: 854,
    height: 480,
    crf: 23,
    maxBitrate: 1_000_000,
    audioBitrate: 64_000,
  },
];

/**
 * Resolution map mirroring the original Lambda. Determines which renditions
 * to produce given the source's labelled resolution.
 */
export const RESOLUTION_MAP: Record<string, string[]> = {
  "2160p": ["_1080p", "_720p", "_480p"],
  "1440p": ["_1080p", "_720p", "_480p"],
  "1080p": ["_1080p", "_720p", "_480p"],
  "720p": ["_720p", "_480p"],
  "480p": ["_480p"],
  "360p": ["_480p"],
  "240p": ["_480p"],
  "144p": ["_480p"],
};

/** Bucket an arbitrary pixel height into the canonical labels above. */
export function bucketResolution(height: number): keyof typeof RESOLUTION_MAP {
  if (height >= 2000) return "2160p";
  if (height >= 1300) return "1440p";
  if (height >= 950) return "1080p";
  if (height >= 650) return "720p";
  if (height >= 440) return "480p";
  if (height >= 320) return "360p";
  if (height >= 220) return "240p";
  return "144p";
}

/** HLS group-level settings mirroring MediaConvert's HlsGroupSettings. */
export const HLS_SETTINGS = {
  /** Matches SegmentLength: 4 */
  segmentSeconds: 4,
  /** GopSize: 90 */
  gopSize: 90,
} as const;
