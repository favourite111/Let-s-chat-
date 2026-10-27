/**
 * Making a 1-on-1 call hold up on a bad network.
 *
 * The browser's default behaviour is generous: given a 720p camera it will try
 * to push 1.5–2.5 Mbit/s and, when the link cannot carry it, it lets the video
 * collapse into a freeze rather than stepping down. Three levers fix that, and
 * this module owns all three:
 *
 *  1. Opus tuning in the SDP — in-band FEC so lost packets are reconstructed
 *     instead of clicking, DTX so silence costs nothing, and a bitrate ceiling
 *     that suits speech rather than music.
 *
 *  2. A codec preference for H.264, which phones encode on dedicated hardware.
 *     Software VP9/AV1 on a cheap Android is what turns a call into a space
 *     heater and burns the battery that was holding the connection together.
 *
 *  3. A controller that reads getStats() every two seconds and adjusts the
 *     outbound video budget (bitrate ceiling and resolution scaling) to fit the
 *     measured link, with hysteresis so it does not oscillate.
 */

export type QualityLevel = "good" | "fair" | "poor" | "bad";

export type DegradationPreference = "balanced" | "maintain-framerate" | "maintain-resolution";

export interface VideoProfile {
  level: QualityLevel;
  /** Ceiling for the encoder, in bits per second. */
  maxBitrate: number;
  /** Encoder-side downscale (1 = full capture size). */
  scaleResolutionDownBy: number;
  degradationPreference: DegradationPreference;
  label: string;
}

/**
 * The ladder. `bad` is deliberately below what the camera captures — dropping
 * resolution to a third is what keeps a face moving at 15 fps on 2G-grade
 * uplinks instead of freezing at 720p.
 */
export const PROFILES: Record<QualityLevel, VideoProfile> = {
  good: {
    level: "good",
    maxBitrate: 1_200_000,
    scaleResolutionDownBy: 1,
    degradationPreference: "balanced",
    label: "Good",
  },
  fair: {
    level: "fair",
    maxBitrate: 500_000,
    scaleResolutionDownBy: 1.5,
    degradationPreference: "balanced",
    label: "Fair",
  },
  poor: {
    level: "poor",
    maxBitrate: 250_000,
    scaleResolutionDownBy: 2,
    degradationPreference: "maintain-framerate",
    label: "Weak",
  },
  bad: {
    level: "bad",
    maxBitrate: 120_000,
    scaleResolutionDownBy: 3,
    degradationPreference: "maintain-framerate",
    label: "Very weak",
  },
};

/** Opus settings for speech on a lossy link. */
const OPUS_PARAMS: Record<string, string> = {
  useinbandfec: "1", // reconstruct dropped packets instead of clicking
  usedtx: "1", // stop transmitting during silence
  stereo: "0", // voice is mono; stereo doubles the cost for nothing
  maxaveragebitrate: "32000",
};

/**
 * Rewrite the Opus fmtp line in an SDP.
 *
 * These parameters cannot be set through the WebRTC API — the only way to reach
 * them is the offer/answer text, which is why this is string surgery. It is
 * written to be a no-op on anything it does not recognise: if the browser
 * renames or omits things, the call still works, just without the tuning.
 */
export function tuneOpusSdp(sdp: string): string {
  if (!sdp) return sdp;

  const rtpmap = sdp.match(/a=rtpmap:(\d+) opus\/48000\/2/i);
  if (!rtpmap) return sdp;
  const pt = rtpmap[1];

  const merge = (existing: string): string => {
    const params = new Map<string, string>();
    for (const part of existing.split(";")) {
      const [k, v] = part.split("=");
      if (k && v !== undefined) params.set(k.trim(), v.trim());
    }
    for (const [k, v] of Object.entries(OPUS_PARAMS)) params.set(k, v);
    return [...params.entries()].map(([k, v]) => `${k}=${v}`).join(";");
  };

  const fmtp = new RegExp(`a=fmtp:${pt} ([^\\r\\n]*)`, "i");
  if (fmtp.test(sdp)) {
    return sdp.replace(fmtp, (_m, params: string) => `a=fmtp:${pt} ${merge(params)}`);
  }

  // No fmtp line for Opus yet — add one directly after its rtpmap.
  const afterRtpmap = new RegExp(`(a=rtpmap:${pt} opus/48000/2[^\\r\\n]*)`, "i");
  const defaults = Object.entries(OPUS_PARAMS).map(([k, v]) => `${k}=${v}`).join(";");
  return sdp.replace(afterRtpmap, `$1\r\na=fmtp:${pt} ${defaults}`);
}

/** Codecs we would rather negotiate first, best hardware support first. */
const CODEC_PREFERENCE = ["video/h264", "video/vp8", "video/vp9", "video/av1"];

/**
 * Reorder video codecs so hardware-accelerated H.264 is offered first.
 *
 * Every codec is kept, only the order changes, so this can never remove an
 * option the other side needs. RTX (retransmission) entries must stay next to
 * the codec they belong to, otherwise Chrome rejects the whole list.
 */
export function preferHardwareCodecs(pc: RTCPeerConnection): void {
  try {
    const caps =
      typeof RTCRtpSender !== "undefined" && RTCRtpSender.getCapabilities
        ? RTCRtpSender.getCapabilities("video")
        : null;
    if (!caps?.codecs?.length) return;

    const rank = (codec: { mimeType: string }): number => {
      const i = CODEC_PREFERENCE.indexOf(codec.mimeType.toLowerCase());
      return i === -1 ? CODEC_PREFERENCE.length : i;
    };

    // Stable sort: preferred codecs first, everything else keeps its order.
    const ordered = caps.codecs
      .map((codec, index) => ({ codec, index }))
      .sort((a, b) => rank(a.codec) - rank(b.codec) || a.index - b.index)
      .map((entry) => entry.codec);

    for (const transceiver of pc.getTransceivers()) {
      // Not supported (older Safari), or already negotiated.
      if (typeof transceiver.setCodecPreferences !== "function") return;
      try {
        transceiver.setCodecPreferences(ordered);
      } catch {
        // Rejected list — leave this transceiver on the browser default.
      }
    }
  } catch {
    // Never let a performance nicety break the call.
  }
}

/** Push a profile onto the outbound video sender. */
export async function applyVideoProfile(pc: RTCPeerConnection, profile: VideoProfile): Promise<void> {
  const sender = pc.getSenders().find((s) => s.track?.kind === "video");
  if (!sender) return;

  const write = async (withDegradation: boolean) => {
    const params = sender.getParameters();
    if (!params.encodings || params.encodings.length === 0) {
      params.encodings = [{}];
    }
    params.encodings[0].maxBitrate = profile.maxBitrate;
    params.encodings[0].scaleResolutionDownBy = profile.scaleResolutionDownBy;
    if (withDegradation) params.degradationPreference = profile.degradationPreference;
    await sender.setParameters(params);
  };

  try {
    await write(true);
  } catch {
    try {
      // Safari has historically rejected degradationPreference; the bitrate and
      // scaling are the parts that matter most, so retry without it.
      await write(false);
    } catch (err) {
      console.warn("Could not apply video profile", err);
    }
  }
}

interface Sample {
  /** Encoder-side estimate of the path capacity, if the browser reports it. */
  availableOutgoingBitrate?: number;
  roundTripTimeMs?: number;
  /** Percentage of outbound packets the peer reports missing. */
  lossPercent?: number;
  qualityLimitationReason?: string;
}

/** Map one stats sample onto the ladder. */
function levelFor(sample: Sample): QualityLevel {
  const loss = sample.lossPercent ?? 0;
  const bwe = sample.availableOutgoingBitrate;
  const rtt = sample.roundTripTimeMs ?? 0;

  // Loss is the honest signal — it is measured by the receiver.
  if (loss >= 12) return "bad";
  if (loss >= 6) return "poor";
  if (loss >= 2) return "fair";

  if (bwe !== undefined && Number.isFinite(bwe) && bwe > 0) {
    if (bwe < 180_000) return "bad";
    if (bwe < 350_000) return "poor";
    if (bwe < 750_000) return "fair";
  }

  // High latency with no loss still means a choppy call on a video encoder.
  if (rtt > 600) return "poor";
  if (rtt > 350) return "fair";

  // The encoder itself says it is bandwidth-bound: trust it and step down one.
  if (sample.qualityLimitationReason === "bandwidth") return "fair";

  return "good";
}

/**
 * Watches the connection and moves the video profile up and down the ladder.
 *
 * A level must be seen twice before it is adopted. Without that, a single noisy
 * sample mid-call would flip resolution back and forth, which the encoder pays
 * for in keyframes — visible as a pulsing picture.
 */
export class AdaptiveVideoController {
  private timer: number | null = null;
  private current: QualityLevel = "good";
  private pending: QualityLevel | null = null;
  private pendingCount = 0;

  start(pc: RTCPeerConnection, onChange: (level: QualityLevel) => void): void {
    this.stop();

    const tick = async () => {
      if (pc.connectionState === "closed" || pc.signalingState === "closed") {
        this.stop();
        return;
      }
      const sample = await readSample(pc);
      if (!sample) return;

      const next = levelFor(sample);
      if (next === this.current) {
        this.pending = null;
        this.pendingCount = 0;
        return;
      }

      if (this.pending !== next) {
        this.pending = next;
        this.pendingCount = 1;
        return;
      }

      this.pendingCount += 1;
      if (this.pendingCount < 2) return;

      this.current = next;
      this.pending = null;
      this.pendingCount = 0;
      onChange(next);
      await applyVideoProfile(pc, PROFILES[next]);
    };

    // Apply the starting profile immediately so the first frames are not sent
    // at full rate into a link that cannot carry them.
    void applyVideoProfile(pc, PROFILES.good);
    this.timer = window.setInterval(() => void tick(), 2000);
  }

  stop(): void {
    if (this.timer !== null) {
      window.clearInterval(this.timer);
      this.timer = null;
    }
    this.current = "good";
    this.pending = null;
    this.pendingCount = 0;
  }
}

async function readSample(pc: RTCPeerConnection): Promise<Sample | null> {
  let report: RTCStatsReport;
  try {
    report = await pc.getStats();
  } catch {
    return null;
  }

  const sample: Sample = {};
  let packetsLost = 0;
  let packetsReceived = 0;

  report.forEach((stat) => {
    const s = stat as Record<string, unknown>;

    // Candidate pair carries the browser's own capacity estimate.
    if (
      s["type"] === "candidate-pair" &&
      (s["state"] === "succeeded" || s["selected"] === true) &&
      typeof s["availableOutgoingBitrate"] === "number"
    ) {
      sample.availableOutgoingBitrate = s["availableOutgoingBitrate"] as number;
      if (typeof s["currentRoundTripTime"] === "number") {
        sample.roundTripTimeMs = (s["currentRoundTripTime"] as number) * 1000;
      }
    }

    if (s["type"] === "outbound-rtp" && s["kind"] === "video") {
      if (typeof s["qualityLimitationReason"] === "string") {
        sample.qualityLimitationReason = s["qualityLimitationReason"] as string;
      }
    }

    // Remote-inbound is where the peer tells us what it actually received.
    if (s["type"] === "remote-inbound-rtp" && s["kind"] === "video") {
      if (typeof s["packetsLost"] === "number") packetsLost += s["packetsLost"] as number;
      if (typeof s["roundTripTime"] === "number" && sample.roundTripTimeMs === undefined) {
        sample.roundTripTimeMs = (s["roundTripTime"] as number) * 1000;
      }
    }

    if (s["type"] === "inbound-rtp" && s["kind"] === "video") {
      if (typeof s["packetsLost"] === "number") packetsLost += s["packetsLost"] as number;
      if (typeof s["packetsReceived"] === "number") packetsReceived += s["packetsReceived"] as number;
    }
  });

  if (packetsReceived > 0) {
    sample.lossPercent = Math.max(0, (packetsLost / (packetsLost + packetsReceived)) * 100);
  }

  return sample;
}
