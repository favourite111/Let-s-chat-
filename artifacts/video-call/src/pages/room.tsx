import React, { useCallback, useEffect, useRef, useState } from "react";
import { useParams, useLocation } from "wouter";
import { io, type Socket } from "socket.io-client";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import {
  Activity,
  Mic,
  MicOff,
  Video as VideoIcon,
  VideoOff,
  PhoneOff,
  Copy,
  Users,
  ShieldCheck,
  Loader2,
  WifiOff,
  RotateCcw,
} from "lucide-react";
import {
  AdaptiveVideoController,
  PROFILES,
  preferHardwareCodecs,
  tuneOpusSdp,
  type QualityLevel,
} from "@/lib/rtc-quality";

type ConnectionStatus = "connecting" | "waiting" | "connected" | "reconnecting" | "failed";

const QUALITY_COLOR: Record<QualityLevel, string> = {
  good: "#22c55e",
  fair: "#eab308",
  poor: "#f97316",
  bad: "#ef4444",
};

const FALLBACK_ICE_SERVERS: RTCIceServer[] = [
  { urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] },
];

/** Turn a getUserMedia failure into something a human can act on. */
function describeMediaError(err: unknown): string {
  const name = err instanceof DOMException ? err.name : "";
  switch (name) {
    case "NotAllowedError":
    case "SecurityError":
      return "Camera and microphone access was blocked. Allow it in your browser's site settings, then try again.";
    case "NotFoundError":
    case "OverconstrainedError":
      return "No camera or microphone was found. Connect a device, or join with audio only.";
    case "NotReadableError":
    case "AbortError":
      return "Your camera or microphone is being used by another app. Close it and try again.";
    default:
      return "We couldn't start your camera. Check your device and browser permissions.";
  }
}

export default function Room() {
  const { roomId } = useParams<{ roomId: string }>();
  const [, setLocation] = useLocation();

  const localVideoRef = useRef<HTMLVideoElement>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const socketRef = useRef<Socket | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const remoteUserIdRef = useRef<string | null>(null);
  const iceServersRef = useRef<RTCIceServer[]>(FALLBACK_ICE_SERVERS);
  const iceBufferRef = useRef<RTCIceCandidateInit[]>([]);
  const remoteDescSetRef = useRef(false);
  const audioOnlyRef = useRef(false);
  const qualityRef = useRef<AdaptiveVideoController | null>(null);
  // Mirrors of state so socket callbacks always read current values.
  const isMutedRef = useRef(false);
  const isVideoOffRef = useRef(false);

  const [isMuted, setIsMuted] = useState(false);
  const [isVideoOff, setIsVideoOff] = useState(false);
  const [hasRemoteVideo, setHasRemoteVideo] = useState(false);
  const [remoteMuted, setRemoteMuted] = useState(false);
  const [remoteVideoOff, setRemoteVideoOff] = useState(false);
  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  const [mediaError, setMediaError] = useState<string | null>(null);
  const [audioOnlyMode, setAudioOnlyMode] = useState(false);
  const [callSeconds, setCallSeconds] = useState(0);
  const [quality, setQuality] = useState<QualityLevel | null>(null);

  // WhatsApp-style swap: false = remote is main, true = local is main
  const [isSwapped, setIsSwapped] = useState(false);

  // Draggable PiP state
  const [pipPosition, setPipPosition] = useState({ x: 16, y: 80 });
  const dragging = useRef(false);
  const dragMoved = useRef(false);
  const dragOffset = useRef({ x: 0, y: 0 });

  // --- Draggable PiP handlers ---
  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    dragging.current = true;
    dragMoved.current = false;
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    dragOffset.current = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    e.preventDefault();
  }, []);

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    if (!dragging.current) return;
    const el = e.currentTarget as HTMLElement;
    const parent = el.parentElement;
    if (!parent) return;
    const parentRect = parent.getBoundingClientRect();
    let newX = e.clientX - parentRect.left - dragOffset.current.x;
    let newY = e.clientY - parentRect.top - dragOffset.current.y;
    if (Math.abs(newX - pipPosition.x) > 2 || Math.abs(newY - pipPosition.y) > 2) {
      dragMoved.current = true;
    }
    newX = Math.max(8, Math.min(newX, parentRect.width - el.offsetWidth - 8));
    newY = Math.max(8, Math.min(newY, parentRect.height - el.offsetHeight - 8));
    setPipPosition({ x: newX, y: newY });
  }, [pipPosition.x, pipPosition.y]);

  const handlePointerUp = useCallback(() => {
    dragging.current = false;
  }, []);

  // Only treat a tap as "swap" if the PiP was not dragged.
  const handlePipTap = useCallback(() => {
    if (!dragMoved.current) {
      setIsSwapped((prev) => !prev);
    }
    dragMoved.current = false;
  }, []);

  // --- Call timer ---
  useEffect(() => {
    if (status !== "connected") return;
    setCallSeconds(0);
    const interval = window.setInterval(() => setCallSeconds((s) => s + 1), 1000);
    return () => window.clearInterval(interval);
  }, [status]);

  // --- WebRTC + signaling ---
  useEffect(() => {
    if (!roomId) return;

    let cancelled = false;

    const emitMediaState = () => {
      const socket = socketRef.current;
      if (!socket?.connected) return;
      socket.emit("media-state", {
        audio: !isMutedRef.current,
        video: !isVideoOffRef.current,
      });
    };

    /** Create (or recreate) the peer connection for the current local stream. */
    const createPeer = (socket: Socket): RTCPeerConnection => {
      // Close the old connection only — never stop sender tracks here, they
      // are the live local camera/mic stream that the new PC will reuse.
      pcRef.current?.close();

      iceBufferRef.current = [];
      remoteDescSetRef.current = false;

      const pc = new RTCPeerConnection({
        iceServers: iceServersRef.current,
        iceCandidatePoolSize: 2,
      });
      pcRef.current = pc;

      const stream = localStreamRef.current;
      if (stream) {
        stream.getTracks().forEach((track) => pc.addTrack(track, stream));
      }

      // Offer hardware-accelerated H.264 before VP9/AV1. Software-encoding a
      // modern codec on a cheap phone is what makes a call stutter and drains
      // the battery that was holding the connection up.
      preferHardwareCodecs(pc);

      pc.ontrack = (event) => {
        const [remoteStream] = event.streams;
        if (remoteVideoRef.current && remoteStream) {
          remoteVideoRef.current.srcObject = remoteStream;
          setHasRemoteVideo(true);
          setStatus("connected");
        }
      };

      pc.onicecandidate = (event) => {
        if (!event.candidate || !remoteUserIdRef.current) return;
        socket.emit("ice-candidate", {
          candidate: event.candidate.toJSON(),
          to: remoteUserIdRef.current,
        });
      };

      // Without this the call froze forever after the network changed.
      pc.oniceconnectionstatechange = () => {
        const state = pc.iceConnectionState;
        if (state === "failed") {
          try {
            pc.restartIce();
          } catch {
            /* browser does not support ICE restart */
          }
          setStatus("reconnecting");
        } else if (state === "disconnected") {
          setStatus("reconnecting");
        } else if (state === "connected" || state === "completed") {
          setStatus("connected");
        }
      };

      pc.onconnectionstatechange = () => {
        if (pc.connectionState === "failed") setStatus("failed");
      };

      return pc;
    };

    const flushCandidates = async (pc: RTCPeerConnection) => {
      remoteDescSetRef.current = true;
      const buffered = iceBufferRef.current;
      iceBufferRef.current = [];
      for (const candidate of buffered) {
        try {
          await pc.addIceCandidate(new RTCIceCandidate(candidate));
        } catch (err) {
          console.warn("Dropping buffered ICE candidate", err);
        }
      }
    };

    /**
     * Start the adaptive quality loop for this peer connection: it measures the
     * link every couple of seconds and moves the video profile up or down to
     * match, instead of letting the encoder overrun a weak connection.
     */
    const startQualityLoop = (pc: RTCPeerConnection) => {
      qualityRef.current?.stop();
      const controller = new AdaptiveVideoController();
      qualityRef.current = controller;
      controller.start(pc, setQuality);
    };

    const start = async () => {
      // 1. ICE servers (server-provided, so TURN can change without a rebuild).
      try {
        const res = await fetch("/api/ice");
        if (res.ok) {
          const data = (await res.json()) as { iceServers?: RTCIceServer[] };
          if (Array.isArray(data.iceServers) && data.iceServers.length > 0) {
            iceServersRef.current = data.iceServers;
          }
        }
      } catch {
        // Keep the STUN fallback; calls still work on many networks.
      }

      if (cancelled) return;

      // 2. Local media.
      try {
        const constraints: MediaStreamConstraints = audioOnlyRef.current
          ? { audio: true, video: false }
          : {
              audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
              // Cap the uplink: 720p/24 is far kinder to a mobile connection than
              // an uncapped 1080p stream.
              video: { width: { ideal: 1280, max: 1280 }, height: { ideal: 720, max: 720 }, frameRate: { ideal: 24, max: 30 } },
            };
        const stream = await navigator.mediaDevices.getUserMedia(constraints);
        if (cancelled) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        localStreamRef.current = stream;
        if (localVideoRef.current) localVideoRef.current.srcObject = stream;
      } catch (err) {
        if (cancelled) return;
        console.error("Media permission error", err);
        setMediaError(describeMediaError(err));
        return;
      }

      // 3. Signaling socket. Re-emits `join-room` on every (re)connect, which
      //    is what keeps a call alive across a network blip.
      const socket = io({ path: "/socket.io", transports: ["websocket", "polling"] });
      socketRef.current = socket;

      socket.on("connect", () => {
        setStatus("waiting");
        setHasRemoteVideo(false);
        remoteUserIdRef.current = null;
        // Fresh peer connection per connection attempt.
        if (pcRef.current) {
          pcRef.current.ontrack = null;
          pcRef.current.onicecandidate = null;
          pcRef.current.close();
          pcRef.current = null;
        }
        socket.emit("join-room", roomId);
        emitMediaState();
      });

      socket.on("disconnect", () => setStatus("reconnecting"));

      socket.on("room-joined", ({ peers }: { peers?: string[] }) => {
        if (peers && peers.length > 0) {
          remoteUserIdRef.current = peers[0] ?? null;
          setStatus("connecting"); // waiting for the first offer
        } else {
          setStatus("waiting");
        }
      });

      socket.on("join-error", ({ reason }: { reason?: string }) => {
        if (reason === "room-not-found") {
          toast.error("That room doesn't exist any more.");
          setLocation("/");
        } else if (reason === "rate-limited") {
          toast.error("Too many attempts. Wait a moment and try again.");
        }
      });

      socket.on("room-full", () => {
        setStatus("failed");
        toast.error("This call already has two people in it.");
      });

      // Existing peer gets told a newcomer arrived → it creates the offer.
      socket.on("user-connected", async (userId: string) => {
        remoteUserIdRef.current = userId;
        const pc = createPeer(socket);
        try {
          const offer = await pc.createOffer();
          // Opus tuning has to happen in the SDP text — there is no API for it.
          offer.sdp = tuneOpusSdp(offer.sdp ?? "");
          await pc.setLocalDescription(offer);
          socket.emit("offer", { offer, to: userId });
          startQualityLoop(pc);
        } catch (err) {
          console.error("Error creating offer", err);
        }
      });

      socket.on(
        "offer",
        async ({ offer, from }: { offer: RTCSessionDescriptionInit; from: string }) => {
          remoteUserIdRef.current = from;
          const pc = pcRef.current ?? createPeer(socket);
          try {
            await pc.setRemoteDescription(new RTCSessionDescription(offer));
            await flushCandidates(pc);
            const answer = await pc.createAnswer();
            answer.sdp = tuneOpusSdp(answer.sdp ?? "");
            await pc.setLocalDescription(answer);
            socket.emit("answer", { answer, to: from });
            startQualityLoop(pc);
          } catch (err) {
            console.error("Error handling offer", err);
          }
        },
      );

      socket.on("answer", async ({ answer }: { answer: RTCSessionDescriptionInit }) => {
        const pc = pcRef.current;
        if (!pc) return;
        try {
          await pc.setRemoteDescription(new RTCSessionDescription(answer));
          await flushCandidates(pc);
          startQualityLoop(pc);
        } catch (err) {
          console.error("Error handling answer", err);
        }
      });

      socket.on(
        "ice-candidate",
        async ({ candidate }: { candidate: RTCIceCandidateInit }) => {
          if (!candidate) return;
          const pc = pcRef.current;
          if (!pc) return;
          if (remoteDescSetRef.current) {
            try {
              await pc.addIceCandidate(new RTCIceCandidate(candidate));
            } catch (err) {
              console.warn("Error adding ICE candidate", err);
            }
          } else {
            iceBufferRef.current.push(candidate);
          }
        },
      );

      socket.on("media-state", ({ audio, video }: { audio?: boolean; video?: boolean }) => {
        setRemoteMuted(audio === false);
        setRemoteVideoOff(video === false);
      });

      socket.on("user-disconnected", () => {
        setHasRemoteVideo(false);
        setRemoteMuted(false);
        setRemoteVideoOff(false);
        remoteUserIdRef.current = null;
        if (remoteVideoRef.current) remoteVideoRef.current.srcObject = null;
        qualityRef.current?.stop();
        qualityRef.current = null;
        setQuality(null);
        pcRef.current?.close();
        pcRef.current = null;
        setStatus("waiting");
      });
    };

    void start();

    return () => {
      cancelled = true;
      localStreamRef.current?.getTracks().forEach((track) => track.stop());
      localStreamRef.current = null;
      qualityRef.current?.stop();
      qualityRef.current = null;
      pcRef.current?.close();
      pcRef.current = null;
      socketRef.current?.disconnect();
      socketRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId, audioOnlyMode]);

  const publishMediaState = () => {
    const socket = socketRef.current;
    if (!socket?.connected) return;
    socket.emit("media-state", { audio: !isMutedRef.current, video: !isVideoOffRef.current });
  };

  const toggleMute = () => {
    if (!localStreamRef.current) return;
    localStreamRef.current.getAudioTracks().forEach((track) => {
      track.enabled = !track.enabled;
    });
    const next = !isMuted;
    setIsMuted(next);
    isMutedRef.current = next;
    publishMediaState();
  };

  const toggleVideo = () => {
    if (!localStreamRef.current) return;
    localStreamRef.current.getVideoTracks().forEach((track) => {
      track.enabled = !track.enabled;
    });
    const next = !isVideoOff;
    setIsVideoOff(next);
    isVideoOffRef.current = next;
    publishMediaState();
  };

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      toast.success("Link copied — send it to whoever you're calling.");
    } catch {
      toast.error("Couldn't copy automatically. Copy the URL from the address bar.");
    }
  };

  const leaveCall = () => {
    localStreamRef.current?.getTracks().forEach((track) => track.stop());
    pcRef.current?.close();
    socketRef.current?.disconnect();
    setLocation("/");
  };

  const formatDuration = (total: number) => {
    const mins = Math.floor(total / 60).toString().padStart(2, "0");
    const secs = (total % 60).toString().padStart(2, "0");
    return `${mins}:${secs}`;
  };

  if (mediaError) {
    return (
      <div style={{ minHeight: "100dvh", background: "#0a0a0f", display: "flex", alignItems: "center", justifyContent: "center", padding: "24px" }}>
        <div style={{ background: "rgba(124,92,252,0.08)", border: "1px solid rgba(124,92,252,0.2)", borderRadius: "20px", padding: "32px", textAlign: "center", maxWidth: "420px", width: "100%" }}>
          <div style={{ width: "64px", height: "64px", borderRadius: "50%", background: "rgba(239,68,68,0.15)", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 16px" }}>
            <VideoOff style={{ color: "#ef4444", width: "28px", height: "28px" }} aria-hidden="true" />
          </div>
          <h2 style={{ color: "#fff", fontSize: "20px", fontWeight: 700, marginBottom: "8px" }}>
            Camera unavailable
          </h2>
          <p style={{ color: "rgba(255,255,255,0.5)", fontSize: "14px", lineHeight: 1.6 }}>{mediaError}</p>

          <Button
            onClick={() => {
              setMediaError(null);
              setAudioOnlyMode(true);
              audioOnlyRef.current = true;
              setStatus("connecting");
            }}
            style={{ width: "100%", marginTop: "20px", background: "linear-gradient(135deg, #7c5cfc, #6c47ff)", border: "none", borderRadius: "12px", color: "#fff", fontWeight: 600, padding: "12px", cursor: "pointer" }}
          >
            Join with audio only
          </Button>
          <Button
            onClick={() => window.location.reload()}
            style={{ width: "100%", marginTop: "10px", background: "rgba(255,255,255,0.08)", border: "none", borderRadius: "12px", color: "#fff", fontWeight: 600, padding: "12px", cursor: "pointer" }}
          >
            <RotateCcw style={{ width: "16px", height: "16px", marginRight: "8px" }} aria-hidden="true" />
            Try again
          </Button>
        </div>
      </div>
    );
  }

  const showWaiting = status === "waiting" || status === "connecting";
  const showRemoteVideoOff = remoteVideoOff;

  const pipWrapperStyle: React.CSSProperties = {
    position: "absolute",
    left: `${pipPosition.x}px`,
    top: `${pipPosition.y}px`,
    width: "120px",
    height: "160px",
    borderRadius: "16px",
    overflow: "hidden",
    border: "2px solid rgba(124,92,252,0.4)",
    boxShadow: "0 8px 32px rgba(0,0,0,0.5)",
    cursor: "grab",
    zIndex: 20,
    touchAction: "none",
    background: "#1a1a2e",
  };

  const mainWrapperStyle: React.CSSProperties = { position: "absolute", inset: 0 };

  return (
    <div style={{ minHeight: "100dvh", background: "#0a0a0f", display: "flex", flexDirection: "column", position: "relative", overflow: "hidden" }}>
      {/* Top Bar */}
      <div
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          right: 0,
          zIndex: 30,
          padding: "12px 16px",
          background: "linear-gradient(180deg, rgba(0,0,0,0.7) 0%, transparent 100%)",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "12px",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "10px", minWidth: 0 }}>
          <div style={{ width: "36px", height: "36px", borderRadius: "10px", background: "linear-gradient(135deg, #7c5cfc, #6c47ff)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
            <VideoIcon style={{ color: "#fff", width: "18px", height: "18px" }} aria-hidden="true" />
          </div>
          <div style={{ minWidth: 0 }}>
            <p style={{ color: "#fff", fontSize: "14px", fontWeight: 600, margin: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
              Room {roomId?.slice(0, 8)}
            </p>
            <p style={{ color: "rgba(255,255,255,0.4)", fontSize: "11px", margin: 0, display: "flex", alignItems: "center", gap: "4px" }}>
              <ShieldCheck style={{ width: "10px", height: "10px" }} aria-hidden="true" />
              Encrypted in transit · {formatDuration(callSeconds)}
            </p>
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: "8px", flexShrink: 0 }}>
          {/* Only shown when the link has degraded — otherwise it is noise. */}
          {status === "connected" && quality && quality !== "good" && (
            <div
              role="status"
              aria-label={`Network quality: ${PROFILES[quality].label}`}
              style={{
                display: "flex",
                alignItems: "center",
                gap: "4px",
                background: "rgba(255,255,255,0.1)",
                borderRadius: "20px",
                padding: "4px 10px",
                fontSize: "12px",
                color: QUALITY_COLOR[quality],
              }}
            >
              <Activity style={{ width: "12px", height: "12px" }} aria-hidden="true" />
              {PROFILES[quality].label}
            </div>
          )}
          <div
            aria-label={`${hasRemoteVideo ? 2 : 1} participants`}
            style={{ display: "flex", alignItems: "center", gap: "4px", background: "rgba(255,255,255,0.1)", borderRadius: "20px", padding: "4px 10px", fontSize: "12px", color: "rgba(255,255,255,0.7)" }}
          >
            <Users style={{ width: "12px", height: "12px" }} aria-hidden="true" />
            {hasRemoteVideo ? "2" : "1"}
          </div>
          <button
            onClick={copyLink}
            aria-label="Copy this call link"
            style={{ display: "flex", alignItems: "center", gap: "4px", background: "rgba(255,255,255,0.1)", border: "none", borderRadius: "20px", padding: "6px 12px", fontSize: "12px", color: "rgba(255,255,255,0.7)", cursor: "pointer" }}
          >
            <Copy style={{ width: "12px", height: "12px" }} aria-hidden="true" />
            Copy Link
          </button>
        </div>
      </div>

      {/* Connection banner */}
      {status === "reconnecting" && (
        <div
          role="status"
          style={{
            position: "absolute",
            top: "70px",
            left: "50%",
            transform: "translateX(-50%)",
            zIndex: 35,
            display: "flex",
            alignItems: "center",
            gap: "8px",
            background: "rgba(245,158,11,0.15)",
            border: "1px solid rgba(245,158,11,0.35)",
            color: "#fbbf24",
            borderRadius: "999px",
            padding: "6px 14px",
            fontSize: "12px",
            fontWeight: 600,
            backdropFilter: "blur(8px)",
          }}
        >
          <WifiOff style={{ width: "14px", height: "14px" }} aria-hidden="true" />
          Reconnecting…
        </div>
      )}

      {status === "failed" && (
        <div
          role="alert"
          style={{
            position: "absolute",
            top: "70px",
            left: "50%",
            transform: "translateX(-50%)",
            zIndex: 35,
            display: "flex",
            alignItems: "center",
            gap: "8px",
            background: "rgba(239,68,68,0.15)",
            border: "1px solid rgba(239,68,68,0.4)",
            color: "#fca5a5",
            borderRadius: "999px",
            padding: "6px 14px",
            fontSize: "12px",
            fontWeight: 600,
          }}
        >
          Connection failed — try leaving and rejoining
        </div>
      )}

      {/* Video Area */}
      <div style={{ flex: 1, position: "relative", width: "100%", height: "100%" }}>
        {/* Remote video — main when !isSwapped, PiP when isSwapped */}
        <div
          onPointerDown={isSwapped ? handlePointerDown : undefined}
          onPointerMove={isSwapped ? handlePointerMove : undefined}
          onPointerUp={isSwapped ? handlePointerUp : undefined}
          onClick={isSwapped ? handlePipTap : undefined}
          style={isSwapped ? pipWrapperStyle : mainWrapperStyle}
        >
          <video
            ref={remoteVideoRef}
            autoPlay
            playsInline
            style={{ width: "100%", height: "100%", objectFit: "cover", background: "#0a0a0f" }}
          />
          {showRemoteVideoOff && hasRemoteVideo && (
            <div style={{ position: "absolute", inset: 0, background: "rgba(10,10,15,0.92)", display: "flex", alignItems: "center", justifyContent: "center", flexDirection: "column", gap: "8px" }}>
              <VideoOff style={{ color: "rgba(255,255,255,0.3)", width: "32px", height: "32px" }} aria-hidden="true" />
              <span style={{ color: "rgba(255,255,255,0.4)", fontSize: "12px" }}>Camera off</span>
            </div>
          )}
          {isSwapped && (
            <div style={{ position: "absolute", top: "6px", right: "6px", width: "22px", height: "22px", borderRadius: "50%", background: "rgba(124,92,252,0.6)", display: "flex", alignItems: "center", justifyContent: "center" }}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M7 16V4m0 0L3 8m4-4l4 4M17 8v12m0 0l4-4m-4 4l-4-4" />
              </svg>
            </div>
          )}
        </div>

        {/* Local video — PiP when !isSwapped, main when isSwapped */}
        <div
          onPointerDown={!isSwapped ? handlePointerDown : undefined}
          onPointerMove={!isSwapped ? handlePointerMove : undefined}
          onPointerUp={!isSwapped ? handlePointerUp : undefined}
          onClick={!isSwapped ? handlePipTap : undefined}
          style={!isSwapped ? pipWrapperStyle : mainWrapperStyle}
        >
          <video
            ref={localVideoRef}
            autoPlay
            playsInline
            muted
            style={{ width: "100%", height: "100%", objectFit: "cover", background: "#0a0a0f", transform: "scaleX(-1)" }}
          />

          <div
            style={{
              position: "absolute",
              bottom: isSwapped ? "100px" : "6px",
              left: isSwapped ? "16px" : "6px",
              background: "rgba(0,0,0,0.6)",
              borderRadius: "6px",
              padding: "2px 8px",
              color: "#fff",
              fontSize: isSwapped ? "12px" : "10px",
              fontWeight: 600,
              zIndex: 1,
            }}
          >
            You
          </div>

          {!isSwapped && (
            <div style={{ position: "absolute", top: "6px", right: "6px", width: "22px", height: "22px", borderRadius: "50%", background: "rgba(124,92,252,0.6)", display: "flex", alignItems: "center", justifyContent: "center" }}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M7 16V4m0 0L3 8m4-4l4 4M17 8v12m0 0l4-4m-4 4l-4-4" />
              </svg>
            </div>
          )}

          {(isVideoOff || audioOnlyMode) && (
            <div style={{ position: "absolute", inset: 0, background: "rgba(10,10,15,0.9)", display: "flex", alignItems: "center", justifyContent: "center", flexDirection: "column", gap: "6px" }}>
              <VideoOff style={{ color: "rgba(255,255,255,0.3)", width: "24px", height: "24px" }} aria-hidden="true" />
              {audioOnlyMode && <span style={{ color: "rgba(255,255,255,0.4)", fontSize: "9px" }}>Audio only</span>}
            </div>
          )}

          {isMuted && (
            <div style={{ position: "absolute", top: "6px", left: "6px", width: "20px", height: "20px", borderRadius: "50%", background: "rgba(239,68,68,0.8)", display: "flex", alignItems: "center", justifyContent: "center" }}>
              <MicOff style={{ width: "10px", height: "10px", color: "#fff" }} aria-hidden="true" />
            </div>
          )}
        </div>

        {/* Waiting overlay — shown over the main area until someone joins */}
        {showWaiting && (
          <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", background: "rgba(10,10,15,0.85)", zIndex: 10, paddingTop: "56px", gap: "12px" }}>
            <div style={{ width: "80px", height: "80px", borderRadius: "50%", background: "rgba(124,92,252,0.15)", display: "flex", alignItems: "center", justifyContent: "center", animation: "pulse 2s ease-in-out infinite" }}>
              {status === "connecting" ? (
                <Loader2 style={{ color: "#7c5cfc", width: "36px", height: "36px" }} aria-hidden="true" />
              ) : (
                <Users style={{ color: "#7c5cfc", width: "36px", height: "36px" }} aria-hidden="true" />
              )}
            </div>
            <p style={{ color: "rgba(255,255,255,0.5)", fontSize: "16px", margin: 0 }}>
              {status === "connecting" ? "Connecting…" : "Waiting for others to join…"}
            </p>
            {status === "waiting" && (
              <button
                onClick={copyLink}
                style={{ display: "flex", alignItems: "center", gap: "6px", background: "rgba(124,92,252,0.15)", border: "1px solid rgba(124,92,252,0.35)", color: "#c4b5fd", borderRadius: "999px", padding: "8px 16px", fontSize: "13px", cursor: "pointer" }}
              >
                <Copy style={{ width: "14px", height: "14px" }} aria-hidden="true" />
                Copy the invite link
              </button>
            )}
          </div>
        )}
      </div>

      {/* Control Bar */}
      <div style={{ position: "absolute", bottom: 0, left: 0, right: 0, zIndex: 30, padding: "16px 24px 32px", background: "linear-gradient(0deg, rgba(0,0,0,0.8) 0%, transparent 100%)", display: "flex", justifyContent: "center" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "16px" }}>
          <button
            onClick={toggleMute}
            aria-label={isMuted ? "Unmute microphone" : "Mute microphone"}
            aria-pressed={isMuted}
            style={{ width: "52px", height: "52px", borderRadius: "50%", border: "none", background: isMuted ? "rgba(239,68,68,0.2)" : "rgba(255,255,255,0.15)", color: isMuted ? "#ef4444" : "#fff", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", backdropFilter: "blur(12px)" }}
          >
            {isMuted ? <MicOff className="w-5 h-5" aria-hidden="true" /> : <Mic className="w-5 h-5" aria-hidden="true" />}
          </button>

          <button
            onClick={toggleVideo}
            disabled={audioOnlyMode}
            aria-label={isVideoOff ? "Turn camera on" : "Turn camera off"}
            aria-pressed={isVideoOff}
            style={{ width: "52px", height: "52px", borderRadius: "50%", border: "none", background: isVideoOff ? "rgba(239,68,68,0.2)" : "rgba(255,255,255,0.15)", color: isVideoOff ? "#ef4444" : "#fff", display: "flex", alignItems: "center", justifyContent: "center", cursor: audioOnlyMode ? "not-allowed" : "pointer", opacity: audioOnlyMode ? 0.4 : 1, backdropFilter: "blur(12px)" }}
          >
            {isVideoOff || audioOnlyMode ? <VideoOff className="w-5 h-5" aria-hidden="true" /> : <VideoIcon className="w-5 h-5" aria-hidden="true" />}
          </button>

          <button
            onClick={leaveCall}
            aria-label="Leave call"
            style={{ height: "52px", borderRadius: "26px", border: "none", background: "linear-gradient(135deg, #ef4444, #dc2626)", color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", gap: "8px", padding: "0 24px", cursor: "pointer", fontWeight: 600, fontSize: "14px", boxShadow: "0 4px 20px rgba(239,68,68,0.4)" }}
          >
            <PhoneOff className="w-5 h-5" aria-hidden="true" />
            Leave
          </button>
        </div>
      </div>

      <style>{`
        @keyframes pulse {
          0%, 100% { transform: scale(1); opacity: 1; }
          50% { transform: scale(1.08); opacity: 0.7; }
        }
      `}</style>
    </div>
  );
}
