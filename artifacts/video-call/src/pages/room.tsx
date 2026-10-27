import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  UserX,
  Crown,
  MoreVertical,
  LogOut,
  PhoneOff as PhoneOffIcon,
} from "lucide-react";
import { ActionSheet, type SheetAction } from "@/components/action-sheet";
import {
  forgetLegacyParticipantId,
  getHostParticipantId,
  getHostSecret,
  getParticipantId,
  resolveJoinIdentity,
} from "@/lib/identity";
import {
  AdaptiveVideoController,
  PROFILES,
  preferHardwareCodecs,
  tuneOpusSdp,
  type QualityLevel,
} from "@/lib/rtc-quality";

type ConnectionStatus =
  | "connecting"
  | "waiting"
  | "connected"
  | "reconnecting"
  | "failed"
  /** Room is at capacity right now — recoverable, retried automatically. */
  | "full"
  /** The host ended the call; the room is closed for good. */
  | "closed"
  /** The host removed this participant; they cannot rejoin. */
  | "removed"
  /** The same identity joined from somewhere else; this tab is no longer in. */
  | "replaced";

interface RosterEntry {
  participantId: string;
  role: "host" | "guest";
  displayName: string | null;
  connected: boolean;
}

/**
 * One peer connection per other person.
 *
 * A group call is a mesh: with four people each browser keeps three peer
 * connections, one per peer, and every media track goes directly to each of
 * them. That is why the ceiling is four — the uplink cost is one copy of your
 * video per person in the room.
 */
interface PeerEntry {
  pc: RTCPeerConnection;
  controller: AdaptiveVideoController | null;
  stream: MediaStream | null;
  iceBuffer: RTCIceCandidateInit[];
  remoteDescSet: boolean;
  muted: boolean;
  videoOff: boolean;
  connected: boolean;
  quality: QualityLevel | null;
}

const QUALITY_COLOR: Record<QualityLevel, string> = {
  good: "#34d399",
  fair: "#fbbf24",
  poor: "#fb923c",
  bad: "#ef4444",
};

const FALLBACK_ICE_SERVERS: RTCIceServer[] = [
  { urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] },
];

const NAME_STORAGE_KEY = "videocall:display-name";

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

/** Initial for a tile when there is no video to show. */
function initialOf(name: string | null | undefined): string {
  const trimmed = (name ?? "").trim();
  return trimmed.length > 0 ? trimmed[0]!.toUpperCase() : "?";
}

/** Track viewport orientation so a two-person call stacks on a phone. */
function useViewport() {
  const [size, setSize] = useState(() => ({
    w: typeof window === "undefined" ? 1280 : window.innerWidth,
    h: typeof window === "undefined" ? 800 : window.innerHeight,
  }));

  useEffect(() => {
    const onResize = () => setSize({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener("resize", onResize);
    window.addEventListener("orientationchange", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      window.removeEventListener("orientationchange", onResize);
    };
  }, []);

  return size;
}

export default function Room() {
  const { roomId } = useParams<{ roomId: string }>();
  const [, setLocation] = useLocation();
  const { w: viewportWidth, h: viewportHeight } = useViewport();

  const prejoinVideoRef = useRef<HTMLVideoElement>(null);
  const localVideoRef = useRef<HTMLVideoElement>(null);
  const remoteVideoRefs = useRef(new Map<string, HTMLVideoElement>());
  const socketRef = useRef<Socket | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const peersRef = useRef(new Map<string, PeerEntry>());
  const iceServersRef = useRef<RTCIceServer[]>(FALLBACK_ICE_SERVERS);
  const audioOnlyRef = useRef(false);
  // Mirrors of state so socket callbacks always read current values.
  const isMutedRef = useRef(false);
  const isVideoOffRef = useRef(false);

  const [isMuted, setIsMuted] = useState(false);
  const [isVideoOff, setIsVideoOff] = useState(false);
  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  const [mediaError, setMediaError] = useState<string | null>(null);
  const [mediaReady, setMediaReady] = useState(false);
  const [audioOnlyMode, setAudioOnlyMode] = useState(false);
  const [callSeconds, setCallSeconds] = useState(0);
  const [quality, setQuality] = useState<QualityLevel | null>(null);

  // Roster comes from the server, never inferred from whether video is flowing.
  const [roster, setRoster] = useState<RosterEntry[]>([]);
  const [isHost, setIsHost] = useState(false);
  const [selfParticipantId, setSelfParticipantId] = useState<string | null>(null);
  const [joinAttempt, setJoinAttempt] = useState(0);

  // Pre-join: name + camera check before entering the call.
  const [joined, setJoined] = useState(false);
  const [displayName, setDisplayName] = useState(() => {
    try {
      return localStorage.getItem(NAME_STORAGE_KEY) ?? "";
    } catch {
      return "";
    }
  });
  const [roomHostName, setRoomHostName] = useState<string | null>(null);
  const [roomPeople, setRoomPeople] = useState(0);
  /**
   * Whether the room is worth preparing for. The pre-join screen asks for the
   * camera, so a link to a room that no longer exists (or was closed by the
   * host) must be refused *before* that — otherwise people grant camera access
   * and only then discover there is nothing to join.
   */
  const [roomCheck, setRoomCheck] = useState<"checking" | "open" | "closed" | "missing">("checking");

  /** Which sheet is open. Hosts get choices; guests never see either. */
  const [sheet, setSheet] = useState<null | "leave" | "host" | "confirm-remove">(null);
  const [removeTarget, setRemoveTarget] = useState<{ id: string; name: string } | null>(null);

  // Bumped whenever a peer's stream, mute state or connection changes, so the
  // grid re-renders without putting MediaStreams in React state.
  const [peerVersion, setPeerVersion] = useState(0);
  const bumpPeers = useCallback(() => setPeerVersion((v) => v + 1), []);

  /** Stop the camera and microphone for good (terminal states, leaving). */
  const stopLocalMedia = useCallback(() => {
    localStreamRef.current?.getTracks().forEach((track) => track.stop());
    localStreamRef.current = null;
    setMediaReady(false);
  }, []);

  // --- Is there anything to join? (before the camera is touched) ---
  useEffect(() => {
    if (!roomId) return;
    let cancelled = false;

    void fetch(`/api/rooms/${roomId}`)
      .then(async (res) => {
        if (cancelled) return;
        if (res.status === 404) {
          setRoomCheck("missing");
          toast.error("That room doesn't exist any more.");
          setLocation("/");
          return;
        }
        if (!res.ok) {
          // Unknown state: let them try rather than block the call.
          setRoomCheck("open");
          return;
        }
        const room = (await res.json()) as {
          closed?: boolean;
          hostName?: string | null;
          participantCount?: number;
        };
        if (cancelled) return;
        if (room.hostName) setRoomHostName(room.hostName);
        if (typeof room.participantCount === "number") setRoomPeople(room.participantCount);
        if (room.closed) {
          setRoomCheck("closed");
          setStatus("closed");
          return;
        }
        setRoomCheck("open");
      })
      .catch(() => {
        if (!cancelled) setRoomCheck("open");
      });

    return () => {
      cancelled = true;
    };
  }, [roomId, setLocation]);

  // --- Local media (pre-join preview and the call share one stream) ---
  useEffect(() => {
    if (roomCheck !== "open") return;
    let cancelled = false;

    const acquire = async () => {
      try {
        const constraints: MediaStreamConstraints = audioOnlyRef.current
          ? { audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false }
          : {
              audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
              // Cap the uplink: 720p/24 is far kinder to a mobile connection
              // than an uncapped 1080p stream. Group calls step down further.
              video: {
                width: { ideal: 1280, max: 1280 },
                height: { ideal: 720, max: 720 },
                frameRate: { ideal: 24, max: 30 },
              },
            };

        const stream = await navigator.mediaDevices.getUserMedia(constraints);
        if (cancelled) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }

        localStreamRef.current = stream;
        stream.getAudioTracks().forEach((track) => {
          track.enabled = !isMutedRef.current;
        });
        stream.getVideoTracks().forEach((track) => {
          track.enabled = !isVideoOffRef.current;
        });

        if (prejoinVideoRef.current) prejoinVideoRef.current.srcObject = stream;
        if (localVideoRef.current) localVideoRef.current.srcObject = stream;
        setMediaReady(true);
        setMediaError(null);
      } catch (err) {
        if (cancelled) return;
        console.error("Media permission error", err);
        setMediaError(describeMediaError(err));
      }
    };

    void acquire();

    return () => {
      cancelled = true;
      localStreamRef.current?.getTracks().forEach((track) => track.stop());
      localStreamRef.current = null;
    };
    // audioOnly switches the capture profile; everything else is stable.
  }, [audioOnlyMode, roomCheck]);

  // Keep whichever preview element is mounted pointed at the local stream.
  useEffect(() => {
    if (prejoinVideoRef.current && localStreamRef.current) {
      prejoinVideoRef.current.srcObject = localStreamRef.current;
    }
    if (localVideoRef.current && localStreamRef.current) {
      localVideoRef.current.srcObject = localStreamRef.current;
    }
  }, [joined, mediaReady]);

  // --- Call timer ---
  useEffect(() => {
    if (status !== "connected") return;
    setCallSeconds(0);
    const interval = window.setInterval(() => setCallSeconds((s) => s + 1), 1000);
    return () => window.clearInterval(interval);
  }, [status]);

  // --- WebRTC mesh + signaling ---
  //
  // Identity, not sockets: this browser presents the same participantId on
  // every join, so a reload or a reconnect reclaims its seat rather than
  // arriving as a second person and filling the room with ghosts.
  useEffect(() => {
    if (!roomId || !joined || !mediaReady) return;

    let cancelled = false;
    // Set once the room is closed or we are removed: nothing may move the UI
    // out of that state again, including the socket's own disconnect handler.
    let terminal = false;
    let retryTimer: number | null = null;

    /**
     * Identity is decided after asking the server one question: is the host
     * already in the call?
     *
     *  - this tab created the room (or holds its secret and the host is gone)
     *    → present the host identity, so the room stays controllable;
     *  - the host is connected in another window of this browser → this tab is
     *    a second participant, which is what makes "open your own link in a
     *    second window" join as a different person instead of colliding with
     *    the host's own seat.
     */
    let participantId = getParticipantId();
    // What we send on join: null when this tab is joining as an ordinary guest.
    let hostSecret = getHostSecret(roomId);
    // What this browser holds, regardless of how this tab joined. Kept so a tab
    // that joined as a guest can take the host seat once it is free.
    const storedSecret = getHostSecret(roomId);

    const name = displayName.trim() || "Guest";

    // Built fresh each time: a later reclaim switches the identity used here.
    const joinPayload = () => ({ roomId, participantId, hostSecret, displayName: name });

    const peers = peersRef.current;

    const closePeer = (peerId: string) => {
      const entry = peers.get(peerId);
      if (!entry) return;
      entry.controller?.stop();
      entry.pc.ontrack = null;
      entry.pc.onicecandidate = null;
      entry.pc.oniceconnectionstatechange = null;
      entry.pc.onconnectionstatechange = null;
      try {
        entry.pc.close();
      } catch {
        /* already closed */
      }
      peers.delete(peerId);
      remoteVideoRefs.current.delete(peerId);
      bumpPeers();
    };

    const closeAllPeers = () => {
      for (const peerId of [...peers.keys()]) closePeer(peerId);
    };

    /** Status from what the mesh actually looks like right now. */
    const refreshStatus = () => {
      if (terminal) return;
      const entries = [...peers.values()];
      if (entries.length === 0) {
        setStatus("waiting");
        return;
      }
      if (entries.some((entry) => entry.connected || entry.pc.connectionState === "connected")) {
        setStatus("connected");
        return;
      }
      setStatus("connecting");
    };

    /** The best connection in the room is what the pill should show. */
    const refreshQuality = () => {
      const levels = [...peers.values()]
        .map((entry) => entry.quality)
        .filter((level): level is QualityLevel => level !== null);
      if (levels.length === 0) {
        setQuality(null);
        return;
      }
      const order: QualityLevel[] = ["good", "fair", "poor", "bad"];
      levels.sort((a, b) => order.indexOf(a) - order.indexOf(b));
      setQuality(levels[0]);
    };

    /** Create (or reuse) the peer connection for one other participant. */
    const ensurePeer = (peerId: string): PeerEntry => {
      const existing = peers.get(peerId);
      if (existing) return existing;

      const pc = new RTCPeerConnection({
        iceServers: iceServersRef.current,
        iceCandidatePoolSize: 2,
      });

      const entry: PeerEntry = {
        pc,
        controller: null,
        stream: null,
        iceBuffer: [],
        remoteDescSet: false,
        muted: false,
        videoOff: false,
        connected: false,
        quality: null,
      };
      peers.set(peerId, entry);

      const stream = localStreamRef.current;
      if (stream) stream.getTracks().forEach((track) => pc.addTrack(track, stream));

      // Offer hardware-accelerated H.264 before VP9/AV1.
      preferHardwareCodecs(pc);

      pc.ontrack = (event) => {
        const [remoteStream] = event.streams;
        if (!remoteStream) return;
        entry.stream = remoteStream;
        entry.connected = true;
        const el = remoteVideoRefs.current.get(peerId);
        if (el && el.srcObject !== remoteStream) el.srcObject = remoteStream;
        bumpPeers();
        refreshStatus();
      };

      pc.onicecandidate = (event) => {
        if (!event.candidate) return;
        socketRef.current?.emit("ice-candidate", {
          candidate: event.candidate.toJSON(),
          to: peerId,
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
          if (!terminal) setStatus("reconnecting");
        } else if (state === "disconnected") {
          if (!terminal) setStatus("reconnecting");
        } else if (state === "connected" || state === "completed") {
          entry.connected = true;
          refreshStatus();
          bumpPeers();
        }
      };

      pc.onconnectionstatechange = () => {
        if (pc.connectionState === "failed" && !terminal) setStatus("failed");
      };

      return entry;
    };

    const startQualityLoop = (entry: PeerEntry, peerId: string) => {
      entry.controller?.stop();
      const controller = new AdaptiveVideoController();
      entry.controller = controller;
      controller.start(entry.pc, (level) => {
        entry.quality = level;
        refreshQuality();
        if (level !== "good") {
          console.info(`[call] link to ${peerId} degraded to ${level}`);
        }
      });
    };

    const flushCandidates = async (entry: PeerEntry) => {
      entry.remoteDescSet = true;
      const buffered = entry.iceBuffer;
      entry.iceBuffer = [];
      for (const candidate of buffered) {
        try {
          await entry.pc.addIceCandidate(new RTCIceCandidate(candidate));
        } catch (err) {
          console.warn("Dropping buffered ICE candidate", err);
        }
      }
    };

    const resolveIdentity = async () => {
      try {
        const res = await fetch(`/api/rooms/${roomId}`);
        if (res.status === 404) {
          toast.error("That room doesn't exist any more.");
          setLocation("/");
          return false;
        }
        if (res.ok) {
          const room = (await res.json()) as {
            closed?: boolean;
            hostConnected?: boolean;
            hostName?: string | null;
          };
          if (room.hostName) setRoomHostName(room.hostName);
          if (room.closed) {
            terminal = true;
            setStatus("closed");
            return false;
          }
          const resolved = resolveJoinIdentity(roomId, Boolean(room.hostConnected));
          participantId = resolved.participantId;
          hostSecret = resolved.hostSecret;
        }
      } catch {
        // Offline or the API hiccuped: fall back to this tab's own identity.
      }
      setSelfParticipantId(participantId);
      return true;
    };

    forgetLegacyParticipantId();

    const emitMediaState = () => {
      const socket = socketRef.current;
      if (!socket?.connected) return;
      socket.emit("media-state", {
        audio: !isMutedRef.current,
        video: !isVideoOffRef.current,
      });
    };

    /**
     * A tab of the host's own browser that joined as a guest (because the host
     * was still in the call elsewhere) keeps watching the room. When the host's
     * seat has been free for a while — the other window was closed — this tab
     * takes it back.
     */
    let reclaimTimer: number | null = null;
    let freeObservations = 0;
    let claimingHost = false;

    const stopReclaimWatch = () => {
      if (reclaimTimer !== null) {
        window.clearInterval(reclaimTimer);
        reclaimTimer = null;
      }
      freeObservations = 0;
    };

    const startReclaimWatch = (socket: Socket) => {
      if (!storedSecret || reclaimTimer !== null) return;
      const storedHostId = getHostParticipantId(roomId);
      if (!storedHostId || storedHostId === participantId) return;

      reclaimTimer = window.setInterval(() => {
        if (cancelled || terminal || claimingHost) {
          stopReclaimWatch();
          return;
        }

        void fetch(`/api/rooms/${roomId}`)
          .then((res) => (res.ok ? res.json() : null))
          .then((room: { closed?: boolean; hostConnected?: boolean } | null) => {
            if (!room || room.closed) {
              stopReclaimWatch();
              return;
            }
            if (room.hostConnected) {
              freeObservations = 0;
              return;
            }
            freeObservations += 1;
            if (freeObservations < 3) return;

            // Three consecutive checks with nobody in the host seat: take it.
            // A short random delay keeps two windows of the same browser from
            // claiming on the same tick.
            stopReclaimWatch();
            window.setTimeout(() => {
              if (cancelled || terminal || claimingHost) return;
              if (!socket.connected) return;
              participantId = storedHostId;
              hostSecret = storedSecret;
              socket.emit("leave");
              window.setTimeout(() => {
                if (!cancelled && !terminal && socket.connected) {
                  socket.emit("join-room", joinPayload());
                }
              }, 100);
            }, 200 + Math.random() * 1800);
          })
          .catch(() => {
            /* transient network error: try again next tick */
          });
      }, 4000);
    };

    const start = async () => {
      // 0. Who is this tab in this room?
      if (!(await resolveIdentity())) return;
      if (cancelled) return;

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

      // 2. Signaling socket. Re-emits `join-room` on every (re)connect, which
      //    is what keeps a call alive across a network blip.
      const socket = io({ path: "/socket.io", transports: ["websocket", "polling"] });
      socketRef.current = socket;

      socket.on("connect", () => {
        if (terminal) return;
        setStatus("connecting");
        // Fresh mesh per connection attempt: every peer connection belongs to
        // the socket that negotiated it.
        closeAllPeers();
        socket.emit("join-room", joinPayload());
      });

      socket.on("disconnect", () => {
        if (!terminal) setStatus("reconnecting");
      });

      socket.on(
        "room-joined",
        ({ participants, isHost: hostFlag }: { participants?: RosterEntry[]; isHost?: boolean }) => {
          claimingHost = Boolean(hostFlag);
          setIsHost(Boolean(hostFlag));
          if (claimingHost) stopReclaimWatch();
          setRoster(participants ?? []);
          setJoinAttempt(0);

          const others = (participants ?? []).filter(
            (p) => p.participantId !== participantId && p.connected,
          );
          // Peers already in the call will offer to us; we do not offer first
          // (see `user-connected`), which keeps the mesh free of offer glare.
          setStatus(others.length > 0 ? "connecting" : "waiting");
          emitMediaState();
          if (!claimingHost) startReclaimWatch(socket);
        },
      );

      socket.on(
        "room-state",
        ({ participants, count }: { participants?: RosterEntry[]; count?: number }) => {
          const next = participants ?? [];
          setRoster(next);

          // Any peer that left the room loses its connection here too.
          const present = new Set(next.filter((p) => p.connected).map((p) => p.participantId));
          for (const peerId of [...peers.keys()]) {
            if (!present.has(peerId)) closePeer(peerId);
          }

          refreshStatus();
          if (typeof count === "number" && count < 1) setStatus("waiting");
        },
      );

      socket.on("join-error", ({ reason }: { reason?: string }) => {
        if (reason === "room-not-found") {
          toast.error("That room doesn't exist any more.");
          setLocation("/");
        } else if (reason === "rate-limited") {
          toast.error("Too many attempts. Wait a moment and try again.");
          setStatus("reconnecting");
        } else if (reason === "host-auth-failed") {
          toast.error(
            "This browser can't prove it owns the room. Open it from the device that created the call.",
          );
          setStatus("failed");
        }
      });

      /**
       * Room at capacity. Recoverable: retried on a timer, without leaving the
       * page, because the usual cause is the other person's previous socket not
       * having timed out yet.
       */
      socket.on("room-full", () => {
        if (terminal) return;
        setStatus("full");
        if (retryTimer !== null) return;
        retryTimer = window.setTimeout(() => {
          retryTimer = null;
          if (cancelled) return;
          setJoinAttempt((n) => n + 1);
          if (socketRef.current?.connected) {
            socketRef.current.emit("join-room", joinPayload());
          }
        }, 5000);
      });

      socket.on("room-closed", () => {
        terminal = true;
        setStatus("closed");
        closeAllPeers();
        stopLocalMedia();
        window.setTimeout(() => socket.disconnect(), 0);
      });

      /**
       * Another window of this browser took the seat this one was holding.
       * Stand down to an ordinary guest seat rather than leaving the call.
       */
      socket.on("session-replaced", () => {
        if (terminal) return;
        claimingHost = false;
        setIsHost(false);
        participantId = getParticipantId();
        hostSecret = null;
        closeAllPeers();
        setStatus("connecting");
        window.setTimeout(() => {
          if (!cancelled && !terminal && socket.connected) {
            socket.emit("join-room", joinPayload());
          }
        }, 250);
      });

      socket.on("removed", () => {
        terminal = true;
        setStatus("removed");
        closeAllPeers();
        stopLocalMedia();
        window.setTimeout(() => socket.disconnect(), 0);
      });

      socket.on("host-action-error", ({ action, reason }: { action?: string; reason?: string }) => {
        if (action === "end-call") toast.error("Only the host can end this call.");
        else if (action === "remove-participant")
          toast.error(
            reason === "target-not-found" ? "That participant already left." : "Only the host can remove someone.",
          );
      });

      socket.on("participant-removed", ({ participantId: removed }: { participantId?: string }) => {
        if (removed) closePeer(removed);
        toast.success("Participant removed.");
      });

      /**
       * Somebody joined. Everyone already in the call offers to the newcomer,
       * which means exactly one side of each pair starts the negotiation.
       */
      socket.on(
        "user-connected",
        async ({
          participantId: peerId,
          displayName: peerName,
        }: {
          participantId: string;
          displayName?: string | null;
        }) => {
          if (peerId === participantId) return;
          // A returning peer replaces whatever connection we had to them.
          closePeer(peerId);

          const entry = ensurePeer(peerId);
          void peerName;
          try {
            const offer = await entry.pc.createOffer();
            offer.sdp = tuneOpusSdp(offer.sdp ?? "");
            await entry.pc.setLocalDescription(offer);
            socket.emit("offer", { offer, to: peerId });
            startQualityLoop(entry, peerId);
          } catch (err) {
            console.error("Error creating offer", err);
          }
        },
      );

      socket.on(
        "offer",
        async ({ offer, from }: { offer: RTCSessionDescriptionInit; from: string }) => {
          if (!from || from === participantId) return;
          // The peer is offering, so any half-built connection to them is stale.
          closePeer(from);
          const entry = ensurePeer(from);
          try {
            await entry.pc.setRemoteDescription(new RTCSessionDescription(offer));
            await flushCandidates(entry);
            const answer = await entry.pc.createAnswer();
            answer.sdp = tuneOpusSdp(answer.sdp ?? "");
            await entry.pc.setLocalDescription(answer);
            socket.emit("answer", { answer, to: from });
            startQualityLoop(entry, from);
          } catch (err) {
            console.error("Error handling offer", err);
          }
        },
      );

      socket.on(
        "answer",
        async ({ answer, from }: { answer: RTCSessionDescriptionInit; from: string }) => {
          const entry = peers.get(from);
          if (!entry) return;
          try {
            await entry.pc.setRemoteDescription(new RTCSessionDescription(answer));
            await flushCandidates(entry);
          } catch (err) {
            console.error("Error handling answer", err);
          }
        },
      );

      socket.on(
        "ice-candidate",
        async ({ candidate, from }: { candidate: RTCIceCandidateInit; from: string }) => {
          if (!candidate || !from) return;
          const entry = peers.get(from);
          if (!entry) return;
          if (entry.remoteDescSet) {
            try {
              await entry.pc.addIceCandidate(new RTCIceCandidate(candidate));
            } catch (err) {
              console.warn("Error adding ICE candidate", err);
            }
          } else {
            entry.iceBuffer.push(candidate);
          }
        },
      );

      socket.on(
        "media-state",
        ({ audio, video, from }: { audio?: boolean; video?: boolean; from?: string }) => {
          if (!from) return;
          const entry = peers.get(from);
          if (!entry) return;
          entry.muted = audio === false;
          entry.videoOff = video === false;
          bumpPeers();
        },
      );

      socket.on("user-disconnected", ({ participantId: gone }: { participantId?: string }) => {
        if (!gone) return;
        closePeer(gone);
        refreshStatus();
      });
    };

    void start();

    return () => {
      cancelled = true;
      stopReclaimWatch();
      if (retryTimer !== null) window.clearTimeout(retryTimer);
      closeAllPeers();
      socketRef.current?.disconnect();
      socketRef.current = null;
      setRoster([]);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId, joined, mediaReady, audioOnlyMode]);

  // Attach any arriving stream to its tile (a tile may mount after ontrack).
  useEffect(() => {
    for (const [peerId, entry] of peersRef.current) {
      const el = remoteVideoRefs.current.get(peerId);
      if (el && entry.stream && el.srcObject !== entry.stream) el.srcObject = entry.stream;
    }
  }, [peerVersion]);

  /**
   * Group calls share the uplink, so with more than two people everybody
   * captures smaller. One copy of 720p per peer is what makes a four-way call
   * stutter on a phone.
   */
  useEffect(() => {
    if (!joined) return;
    const track = localStreamRef.current?.getVideoTracks()[0];
    if (!track) return;

    const people = roster.filter((p) => p.connected).length;
    const group = people > 2;

    track
      .applyConstraints(
        group
          ? { width: { ideal: 640, max: 640 }, height: { ideal: 480, max: 480 }, frameRate: { ideal: 20, max: 24 } }
          : { width: { ideal: 1280, max: 1280 }, height: { ideal: 720, max: 720 }, frameRate: { ideal: 24, max: 30 } },
      )
      .catch(() => {
        /* not all devices allow re-constraining a live track */
      });
  }, [joined, roster]);

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

  const joinCall = () => {
    const clean = displayName.trim();
    if (!clean) {
      toast.error("Add a name so everyone knows who's who.");
      return;
    }
    try {
      localStorage.setItem(NAME_STORAGE_KEY, clean);
    } catch {
      /* storage disabled — the name still works for this call */
    }
    setDisplayName(clean);
    setJoined(true);
  };

  const leaveCall = () => {
    // Tell the server first: this releases the seat immediately instead of
    // leaving a ghost that holds the slot until the ping timeout.
    socketRef.current?.emit("leave");
    for (const entry of peersRef.current.values()) {
      entry.controller?.stop();
      try {
        entry.pc.close();
      } catch {
        /* already closed */
      }
    }
    peersRef.current.clear();
    stopLocalMedia();
    socketRef.current?.disconnect();
    setLocation("/");
  };

  /**
   * The single red button. Guests leave immediately. A host gets the sheet,
   * because "leave" and "end it for everyone" must not be one mis-tap apart.
   */
  const handleLeavePressed = () => {
    if (!isHost) {
      leaveCall();
      return;
    }
    setSheet("leave");
  };

  /** Host-only: end the call for everyone and close the room permanently. */
  const endCallForEveryone = () => {
    if (!roomId) return;
    const socket = socketRef.current;

    if (socket?.connected) {
      // The server re-verifies ownership, closes the room and broadcasts
      // `room-closed` to everyone (host included).
      socket.emit("end-call");
      return;
    }

    const participantId = getParticipantId();
    const hostSecret = getHostSecret(roomId);
    if (!participantId || !hostSecret) {
      toast.error("This browser can't prove it owns the room.");
      return;
    }

    void fetch(`/api/rooms/${roomId}`, {
      method: "DELETE",
      headers: { "x-participant-id": participantId, "x-host-secret": hostSecret },
    })
      .then((res) => {
        if (!res.ok) throw new Error(String(res.status));
        setStatus("closed");
        stopLocalMedia();
      })
      .catch(() => toast.error("Couldn't close the room. Check your connection and try again."));
  };

  /** Host-only: kick one participant out of the room for good. */
  const removeParticipant = (participantId: string) => {
    const socket = socketRef.current;
    if (!socket?.connected) {
      toast.error("Not connected — try again in a moment.");
      return;
    }
    socket.emit("remove-participant", { participantId });
  };

  const formatDuration = (total: number) => {
    const mins = Math.floor(total / 60).toString().padStart(2, "0");
    const secs = (total % 60).toString().padStart(2, "0");
    return `${mins}:${secs}`;
  };

  // --- Derived view state ---
  const connectedPeople = roster.filter((p) => p.connected);
  const participantCount = Math.max(connectedPeople.length, 1);
  const others = connectedPeople.filter((p) => p.participantId !== selfParticipantId);

  const selfName = displayName.trim() || (isHost ? roomHostName : null) || "You";
  const tiles = useMemo(() => {
    const list: Array<{
      id: string;
      name: string;
      isSelf: boolean;
      role: "host" | "guest";
      muted: boolean;
      videoOff: boolean;
      hasStream: boolean;
    }> = [
      {
        id: "self",
        name: selfName,
        isSelf: true,
        role: isHost ? "host" : "guest",
        muted: isMuted,
        videoOff: isVideoOff || audioOnlyMode,
        hasStream: Boolean(localStreamRef.current),
      },
    ];

    for (const person of others) {
      const entry = peersRef.current.get(person.participantId);
      list.push({
        id: person.participantId,
        name: person.displayName ?? (person.role === "host" ? "Host" : "Guest"),
        isSelf: false,
        role: person.role,
        muted: entry?.muted ?? false,
        videoOff: entry?.videoOff ?? false,
        hasStream: Boolean(entry?.stream),
      });
    }
    return list;
  }, [selfName, isHost, isMuted, isVideoOff, audioOnlyMode, others, peerVersion, joined]);

  // 1 person: full screen. 2: stacked on a phone, side by side on a desktop.
  // 3: one wide tile with two underneath on a phone (a 2×2 would leave a dead
  // quadrant), three across on a desktop. 4: a 2×2 grid.
  const portrait = viewportHeight >= viewportWidth;
  const gridStyle = useMemo<React.CSSProperties>(() => {
    const count = tiles.length;
    if (count <= 1) return { gridTemplateColumns: "1fr", gridTemplateRows: "1fr" };
    if (count === 2) {
      return portrait
        ? { gridTemplateColumns: "1fr", gridTemplateRows: "1fr 1fr" }
        : { gridTemplateColumns: "1fr 1fr", gridTemplateRows: "1fr" };
    }
    if (count === 3) {
      return portrait
        ? { gridTemplateColumns: "1fr 1fr", gridTemplateRows: "1.15fr 1fr" }
        : { gridTemplateColumns: "1fr 1fr 1fr", gridTemplateRows: "1fr" };
    }
    return { gridTemplateColumns: "1fr 1fr", gridTemplateRows: "1fr 1fr" };
  }, [tiles.length, portrait]);

  /** In the three-person portrait layout your own tile spans the full width. */
  const selfSpansRow = tiles.length === 3 && portrait;

  // --- Terminal states -----------------------------------------------------
  if (status === "closed" || status === "removed" || status === "replaced") {
    const closed = status === "closed";
    const replaced = status === "replaced";
    return (
      <div style={{ minHeight: "100dvh", background: "#0a0a0f", display: "flex", alignItems: "center", justifyContent: "center", padding: "24px" }}>
        <div style={{ background: "rgba(124,92,252,0.08)", border: "1px solid rgba(124,92,252,0.2)", borderRadius: "20px", padding: "32px", textAlign: "center", maxWidth: "420px", width: "100%" }}>
          <div style={{ width: "64px", height: "64px", borderRadius: "50%", background: closed ? "rgba(239,68,68,0.15)" : "rgba(245,158,11,0.15)", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 16px" }}>
            {closed ? (
              <PhoneOffIcon style={{ color: "#ef4444", width: "28px", height: "28px" }} aria-hidden="true" />
            ) : replaced ? (
              <Users style={{ color: "#7c5cfc", width: "28px", height: "28px" }} aria-hidden="true" />
            ) : (
              <UserX style={{ color: "#fbbf24", width: "28px", height: "28px" }} aria-hidden="true" />
            )}
          </div>
          <h2 style={{ color: "#fff", fontSize: "20px", fontWeight: 700, marginBottom: "8px" }}>
            {closed ? "Call ended" : replaced ? "Opened in another window" : "You were removed"}
          </h2>
          <p style={{ color: "rgba(255,255,255,0.5)", fontSize: "14px", lineHeight: 1.6 }}>
            {closed
              ? "The host ended this call. This room is closed and cannot be rejoined."
              : replaced
                ? "This room is open in another window or tab, so this one has left the call."
                : "The host removed you from this room, so you can't rejoin it."}
          </p>
          <Button
            onClick={() => setLocation("/")}
            style={{ width: "100%", marginTop: "20px", background: "linear-gradient(135deg, #7c5cfc, #6c47ff)", border: "none", borderRadius: "12px", color: "#fff", fontWeight: 600, padding: "12px", cursor: "pointer" }}
          >
            Back to home
          </Button>
        </div>
      </div>
    );
  }

  // --- Camera unavailable --------------------------------------------------
  if (mediaError && !mediaReady) {
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
              audioOnlyRef.current = true;
              setAudioOnlyMode(true);
              setMediaError(null);
            }}
            style={{ width: "100%", marginTop: "20px", background: "linear-gradient(135deg, #7c5cfc, #6c47ff)", border: "none", borderRadius: "12px", color: "#fff", fontWeight: 600, padding: "12px", cursor: "pointer" }}
          >
            Continue with audio only
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

  // --- Still working out whether the room exists --------------------------
  if (!joined && roomCheck === "checking") {
    return (
      <div style={{ minHeight: "100dvh", background: "#0a0a0f", display: "flex", alignItems: "center", justifyContent: "center" }}>
        <Loader2 style={{ width: "28px", height: "28px", color: "#7c5cfc", animation: "spin 1s linear infinite" }} aria-hidden="true" />
      </div>
    );
  }

  // --- Pre-join: name + camera check --------------------------------------
  if (!joined) {
    return (
      <div style={{ minHeight: "100dvh", background: "#0a0a0f", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "20px", gap: "18px" }}>
        <div style={{ width: "100%", maxWidth: "460px", display: "flex", flexDirection: "column", gap: "16px" }}>
          <div style={{ textAlign: "center" }}>
            <h1 style={{ color: "#fff", fontSize: "22px", fontWeight: 700, margin: 0 }}>
              {isHost ? "You're hosting" : "Ready to join?"}
            </h1>
            <p style={{ color: "rgba(255,255,255,0.45)", fontSize: "13px", margin: "6px 0 0" }}>
              Room {roomId?.slice(0, 8)} ·{" "}
              {roomPeople === 0
                ? "you'll be the first here"
                : `${roomPeople} ${roomPeople === 1 ? "person" : "people"} already in the call`}
            </p>
          </div>

          <div style={{ position: "relative", width: "100%", aspectRatio: "4 / 3", borderRadius: "18px", overflow: "hidden", background: "#14141f", border: "1px solid rgba(255,255,255,0.08)" }}>
            {audioOnlyMode || isVideoOff ? (
              <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", flexDirection: "column", gap: "10px" }}>
                <div style={{ width: "64px", height: "64px", borderRadius: "50%", background: "rgba(124,92,252,0.18)", display: "flex", alignItems: "center", justifyContent: "center" }}>
                  <span style={{ color: "#c4b5fd", fontSize: "24px", fontWeight: 700 }}>{initialOf(displayName)}</span>
                </div>
                <span style={{ color: "rgba(255,255,255,0.4)", fontSize: "12px" }}>
                  {audioOnlyMode ? "Audio only" : "Camera off"}
                </span>
              </div>
            ) : (
              <video
                ref={prejoinVideoRef}
                autoPlay
                playsInline
                muted
                style={{ width: "100%", height: "100%", objectFit: "cover", transform: "scaleX(-1)" }}
              />
            )}

            {isMuted && (
              <div style={{ position: "absolute", top: "10px", left: "10px", width: "26px", height: "26px", borderRadius: "50%", background: "rgba(239,68,68,0.85)", display: "flex", alignItems: "center", justifyContent: "center" }}>
                <MicOff style={{ width: "13px", height: "13px", color: "#fff" }} aria-hidden="true" />
              </div>
            )}
          </div>

          <input
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") joinCall();
            }}
            maxLength={40}
            placeholder="Your name"
            aria-label="Your name"
            style={{ width: "100%", height: "52px", borderRadius: "14px", border: "1px solid rgba(255,255,255,0.12)", background: "#14141f", color: "#fff", padding: "0 16px", fontSize: "15px", outline: "none" }}
          />

          <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: "12px" }}>
            <button
              onClick={toggleMute}
              aria-label={isMuted ? "Unmute microphone" : "Mute microphone"}
              aria-pressed={isMuted}
              style={{ width: "52px", height: "52px", borderRadius: "50%", border: "none", background: isMuted ? "rgba(239,68,68,0.2)" : "rgba(255,255,255,0.1)", color: isMuted ? "#ef4444" : "#fff", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer" }}
            >
              {isMuted ? <MicOff style={{ width: "20px", height: "20px" }} /> : <Mic style={{ width: "20px", height: "20px" }} />}
            </button>
            <button
              onClick={toggleVideo}
              disabled={audioOnlyMode}
              aria-label={isVideoOff ? "Turn camera on" : "Turn camera off"}
              aria-pressed={isVideoOff}
              style={{ width: "52px", height: "52px", borderRadius: "50%", border: "none", background: isVideoOff ? "rgba(239,68,68,0.2)" : "rgba(255,255,255,0.1)", color: isVideoOff ? "#ef4444" : "#fff", display: "flex", alignItems: "center", justifyContent: "center", cursor: audioOnlyMode ? "not-allowed" : "pointer", opacity: audioOnlyMode ? 0.4 : 1 }}
            >
              {isVideoOff || audioOnlyMode ? <VideoOff style={{ width: "20px", height: "20px" }} /> : <VideoIcon style={{ width: "20px", height: "20px" }} />}
            </button>
          </div>

          <Button
            onClick={joinCall}
            disabled={!mediaReady}
            style={{ width: "100%", height: "54px", background: "linear-gradient(135deg, #7c5cfc, #6c47ff)", border: "none", borderRadius: "16px", color: "#fff", fontWeight: 700, fontSize: "16px", cursor: mediaReady ? "pointer" : "not-allowed", opacity: mediaReady ? 1 : 0.6 }}
          >
            {mediaReady ? "Join call" : "Starting camera…"}
          </Button>

          <button
            onClick={() => setLocation("/")}
            style={{ background: "none", border: "none", color: "rgba(255,255,255,0.4)", fontSize: "13px", cursor: "pointer" }}
          >
            Cancel
          </button>
        </div>
      </div>
    );
  }

  const showWaiting = status === "waiting" || status === "connecting";

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
            <p style={{ color: "rgba(255,255,255,0.4)", fontSize: "11px", margin: 0, display: "flex", alignItems: "center", gap: "4px", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
              <ShieldCheck style={{ width: "10px", height: "10px", flexShrink: 0 }} aria-hidden="true" />
              {/* On a phone the badge lives here instead of taking its own pill. */}
              {isHost && (
                <span className="host-subtitle-label" aria-hidden="true">Host · </span>
              )}
              Encrypted in transit · {formatDuration(callSeconds)}
            </p>
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: "8px", flexShrink: 0 }}>
          {/* Only shown when the link has degraded — otherwise it is noise. */}
          {status === "connected" && quality && quality !== "good" && (
            <div
              role="status"
              className="quality-pill"
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
              <span className="quality-label">{PROFILES[quality].label}</span>
            </div>
          )}
          <div
            aria-label={`${participantCount} ${participantCount === 1 ? "participant" : "participants"}`}
            style={{ display: "flex", alignItems: "center", gap: "4px", background: "rgba(255,255,255,0.1)", borderRadius: "20px", padding: "4px 10px", fontSize: "12px", color: "rgba(255,255,255,0.7)" }}
          >
            <Users style={{ width: "12px", height: "12px" }} aria-hidden="true" />
            {participantCount}
          </div>
          {isHost && (
            <div
              className="host-badge"
              aria-label="You are the host"
              style={{ display: "flex", alignItems: "center", gap: "4px", background: "rgba(124,92,252,0.2)", border: "1px solid rgba(124,92,252,0.4)", borderRadius: "20px", padding: "4px 10px", fontSize: "12px", color: "#c4b5fd", fontWeight: 600 }}
            >
              <Crown style={{ width: "12px", height: "12px" }} aria-hidden="true" />
              <span className="host-badge-label">Host</span>
            </div>
          )}
          <button
            onClick={copyLink}
            aria-label="Copy this call link"
            style={{ display: "flex", alignItems: "center", gap: "4px", background: "rgba(255,255,255,0.1)", border: "none", borderRadius: "20px", padding: "6px 12px", fontSize: "12px", color: "rgba(255,255,255,0.7)", cursor: "pointer" }}
          >
            <Copy style={{ width: "12px", height: "12px" }} aria-hidden="true" />
            <span className="copy-link-label">Copy Link</span>
          </button>

          {/* Rare host actions live here, not in the control bar. */}
          {isHost && (
            <button
              onClick={() => setSheet("host")}
              aria-label="Host controls"
              aria-haspopup="dialog"
              aria-expanded={sheet !== null}
              data-testid="host-menu-button"
              style={{ display: "flex", alignItems: "center", justifyContent: "center", width: "32px", height: "32px", background: "rgba(255,255,255,0.1)", border: "none", borderRadius: "20px", color: "rgba(255,255,255,0.75)", cursor: "pointer" }}
            >
              <MoreVertical style={{ width: "16px", height: "16px" }} aria-hidden="true" />
            </button>
          )}
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

      {status === "full" && (
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
            whiteSpace: "nowrap",
          }}
        >
          <Loader2 style={{ width: "14px", height: "14px", animation: "spin 1s linear infinite" }} aria-hidden="true" />
          Room is full — retrying in a moment
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

      {/* Video grid: one tile per person, your own included. */}
      <div
        className="video-grid"
        data-tile-count={tiles.length}
        style={{
          flex: 1,
          display: "grid",
          gap: "8px",
          padding: "64px 8px 96px",
          width: "100%",
          height: "100%",
          ...gridStyle,
        }}
      >
        {tiles.map((tile) =>
          tile.isSelf ? (
            <div
              key="self"
              data-testid="tile-self"
              data-muted={tile.muted ? "true" : "false"}
              data-video-off={tile.videoOff ? "true" : "false"}
              style={{
                position: "relative",
                borderRadius: "16px",
                overflow: "hidden",
                background: "#14141f",
                border: "1px solid rgba(124,92,252,0.28)",
                minHeight: 0,
                ...(selfSpansRow ? { gridColumn: "1 / -1" } : {}),
              }}
            >
              <video
                ref={localVideoRef}
                autoPlay
                playsInline
                muted
                style={{ width: "100%", height: "100%", objectFit: "cover", transform: "scaleX(-1)", display: tile.videoOff ? "none" : "block" }}
              />
              {tile.videoOff && (
                <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center" }}>
                  <div style={{ width: "72px", height: "72px", borderRadius: "50%", background: "rgba(124,92,252,0.2)", display: "flex", alignItems: "center", justifyContent: "center" }}>
                    <span style={{ color: "#c4b5fd", fontSize: "26px", fontWeight: 700 }}>{initialOf(tile.name)}</span>
                  </div>
                </div>
              )}
              <div style={{ position: "absolute", left: "8px", bottom: "8px", display: "flex", alignItems: "center", gap: "5px", background: "rgba(0,0,0,0.55)", borderRadius: "8px", padding: "3px 8px" }}>
                <span style={{ color: "#fff", fontSize: "11px", fontWeight: 600 }}>You</span>
                {audioOnlyMode && <span style={{ color: "rgba(255,255,255,0.4)", fontSize: "9px" }}>Audio only</span>}
              </div>
              {tile.muted && (
                <div style={{ position: "absolute", top: "8px", right: "8px", width: "24px", height: "24px", borderRadius: "50%", background: "rgba(239,68,68,0.8)", display: "flex", alignItems: "center", justifyContent: "center" }}>
                  <MicOff style={{ width: "12px", height: "12px", color: "#fff" }} aria-hidden="true" />
                </div>
              )}
            </div>
          ) : (
            <div
              key={tile.id}
              data-testid="tile-remote"
              data-participant-id={tile.id}
              data-name={tile.name}
              data-muted={tile.muted ? "true" : "false"}
              data-video-off={tile.videoOff ? "true" : "false"}
              data-has-stream={tile.hasStream ? "true" : "false"}
              style={{ position: "relative", borderRadius: "16px", overflow: "hidden", background: "#14141f", border: "1px solid rgba(255,255,255,0.08)", minHeight: 0 }}
            >
              <video
                ref={(el) => {
                  if (!el) {
                    remoteVideoRefs.current.delete(tile.id);
                    return;
                  }
                  remoteVideoRefs.current.set(tile.id, el);
                  const entry = peersRef.current.get(tile.id);
                  if (entry?.stream && el.srcObject !== entry.stream) el.srcObject = entry.stream;
                }}
                autoPlay
                playsInline
                style={{ width: "100%", height: "100%", objectFit: "cover", display: tile.hasStream && !tile.videoOff ? "block" : "none" }}
              />

              {(!tile.hasStream || tile.videoOff) && (
                <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: "8px" }}>
                  <div style={{ width: "72px", height: "72px", borderRadius: "50%", background: "rgba(255,255,255,0.08)", display: "flex", alignItems: "center", justifyContent: "center" }}>
                    <span style={{ color: "rgba(255,255,255,0.7)", fontSize: "26px", fontWeight: 700 }}>{initialOf(tile.name)}</span>
                  </div>
                  {!tile.videoOff && (
                    <span style={{ color: "rgba(255,255,255,0.35)", fontSize: "11px" }}>Connecting…</span>
                  )}
                </div>
              )}

              <div style={{ position: "absolute", left: "8px", bottom: "8px", display: "flex", alignItems: "center", gap: "5px", maxWidth: "calc(100% - 16px)", background: "rgba(0,0,0,0.55)", borderRadius: "8px", padding: "3px 8px" }}>
                {tile.role === "host" && <Crown style={{ width: "10px", height: "10px", color: "#c4b5fd", flexShrink: 0 }} aria-hidden="true" />}
                <span style={{ color: "#fff", fontSize: "11px", fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                  {tile.name}
                </span>
              </div>

              {tile.muted && (
                <div style={{ position: "absolute", top: "8px", right: "8px", width: "24px", height: "24px", borderRadius: "50%", background: "rgba(239,68,68,0.8)", display: "flex", alignItems: "center", justifyContent: "center" }}>
                  <MicOff style={{ width: "12px", height: "12px", color: "#fff" }} aria-hidden="true" />
                </div>
              )}
            </div>
          ),
        )}

        {/* Waiting overlay — only while nobody else is here. */}
        {tiles.length === 1 && showWaiting && (
          <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", zIndex: 10, pointerEvents: "none" }}>
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: "12px", background: "rgba(10,10,15,0.82)", borderRadius: "20px", padding: "24px 28px", pointerEvents: "auto" }}>
              <div style={{ width: "64px", height: "64px", borderRadius: "50%", background: "rgba(124,92,252,0.15)", display: "flex", alignItems: "center", justifyContent: "center", animation: "pulse 2s ease-in-out infinite" }}>
                {status === "connecting" ? (
                  <Loader2 style={{ color: "#7c5cfc", width: "30px", height: "30px" }} aria-hidden="true" />
                ) : (
                  <Users style={{ color: "#7c5cfc", width: "30px", height: "30px" }} aria-hidden="true" />
                )}
              </div>
              <p style={{ color: "rgba(255,255,255,0.5)", fontSize: "15px", margin: 0 }}>
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
          </div>
        )}
      </div>

      {/* Control Bar */}
      <div
        className="call-controls-bar"
        style={{
          position: "absolute",
          bottom: 0,
          left: 0,
          right: 0,
          zIndex: 30,
          padding: "16px 12px calc(22px + env(safe-area-inset-bottom, 0px))",
          background: "linear-gradient(0deg, rgba(0,0,0,0.85) 0%, transparent 100%)",
          display: "flex",
          justifyContent: "center",
        }}
      >
        <div
          className="call-controls"
          style={{ display: "flex", alignItems: "center", justifyContent: "center", flexWrap: "wrap", gap: "10px 12px", width: "100%", maxWidth: "520px" }}
        >
          <div className="call-controls-group" style={{ display: "flex", alignItems: "center", gap: "12px" }}>
            <button
              onClick={toggleMute}
              aria-label={isMuted ? "Unmute microphone" : "Mute microphone"}
              aria-pressed={isMuted}
              style={{ width: "52px", height: "52px", flex: "0 0 auto", borderRadius: "50%", border: "none", background: isMuted ? "rgba(239,68,68,0.2)" : "rgba(255,255,255,0.15)", color: isMuted ? "#ef4444" : "#fff", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", backdropFilter: "blur(12px)" }}
            >
              {isMuted ? <MicOff className="w-5 h-5" aria-hidden="true" /> : <Mic className="w-5 h-5" aria-hidden="true" />}
            </button>

            <button
              onClick={toggleVideo}
              disabled={audioOnlyMode}
              aria-label={isVideoOff ? "Turn camera on" : "Turn camera off"}
              aria-pressed={isVideoOff}
              style={{ width: "52px", height: "52px", flex: "0 0 auto", borderRadius: "50%", border: "none", background: isVideoOff ? "rgba(239,68,68,0.2)" : "rgba(255,255,255,0.15)", color: isVideoOff ? "#ef4444" : "#fff", display: "flex", alignItems: "center", justifyContent: "center", cursor: audioOnlyMode ? "not-allowed" : "pointer", opacity: audioOnlyMode ? 0.4 : 1, backdropFilter: "blur(12px)" }}
            >
              {isVideoOff || audioOnlyMode ? <VideoOff className="w-5 h-5" aria-hidden="true" /> : <VideoIcon className="w-5 h-5" aria-hidden="true" />}
            </button>

            <button
              onClick={handleLeavePressed}
              aria-label="Leave call"
              aria-haspopup={isHost ? "dialog" : undefined}
              style={{ height: "52px", borderRadius: "26px", border: "none", background: "linear-gradient(135deg, #ef4444, #dc2626)", color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", gap: "8px", padding: "0 22px", cursor: "pointer", fontWeight: 600, fontSize: "14px", whiteSpace: "nowrap", flex: "0 0 auto", boxShadow: "0 4px 20px rgba(239,68,68,0.4)" }}
            >
              <PhoneOff className="w-5 h-5" aria-hidden="true" />
              <span className="control-label">Leave</span>
            </button>
          </div>
        </div>
      </div>

      {/*
        Host: "Leave" is a question, not an action. Two clearly-worded choices,
        one of them red — the destructive one is never a neighbour of the button
        people tap without looking.
      */}
      <ActionSheet
        open={sheet === "leave"}
        title="Leave this call?"
        actions={[
          {
            id: "leave-call",
            label: "Leave call",
            description: "Others stay connected, the room stays open",
            icon: LogOut,
            onSelect: leaveCall,
          },
          {
            id: "end-for-everyone",
            label: "End for everyone",
            description: "Closes the room for all participants",
            icon: PhoneOffIcon,
            tone: "danger",
            onSelect: endCallForEveryone,
          },
        ]}
        onClose={() => setSheet(null)}
      />

      {/* Host menu: rare actions, kept out of the control bar. */}
      <ActionSheet
        open={sheet === "host"}
        title="Host controls"
        description="You own this room."
        actions={
          [
            {
              id: "copy-link",
              label: "Copy invite link",
              description: "Send it to whoever you are calling",
              icon: Copy,
              onSelect: () => {
                void copyLink();
              },
            },
            ...others.map((person) => ({
              id: `remove-${person.participantId}`,
              label: `Remove ${person.displayName ?? "this person"}`,
              description: "They are disconnected and cannot rejoin",
              icon: UserX,
              tone: "warning" as const,
              onSelect: () => {
                setRemoveTarget({
                  id: person.participantId,
                  name: person.displayName ?? "this person",
                });
                setSheet("confirm-remove");
              },
            })),
          ] as SheetAction[]
        }
        onClose={() => setSheet(null)}
      />

      {/* Removing someone is permanent, so it gets its own confirmation. */}
      <ActionSheet
        open={sheet === "confirm-remove"}
        title={`Remove ${removeTarget?.name ?? "this person"}?`}
        description="They will be disconnected and cannot rejoin this room."
        actions={[
          {
            id: "confirm-remove",
            label: "Remove from call",
            icon: UserX,
            tone: "danger",
            onSelect: () => {
              if (removeTarget) removeParticipant(removeTarget.id);
              setRemoveTarget(null);
            },
          },
        ]}
        onClose={() => {
          setSheet(null);
          setRemoveTarget(null);
        }}
      />

      <style>{`
        /* Phone widths: tighten the spacing, and let the header keep the room
           name by folding the badge into the subtitle. */
        .host-subtitle-label { display: none; }
        @media (max-width: 430px) {
          .host-subtitle-label { display: inline !important; }
          .call-controls { gap: 8px !important; }
          .call-controls-group { gap: 8px !important; }
          .call-controls-bar { padding-left: 8px !important; padding-right: 8px !important; }
          /* The room name matters more than the words on these buttons. */
          .copy-link-label { display: none !important; }
          .host-badge { display: none !important; }
          .quality-label { display: none !important; }
          .quality-pill { padding: 4px 8px !important; }
        }
        @media (max-width: 380px) {
          .video-grid { padding-left: 6px !important; padding-right: 6px !important; }
        }
        @keyframes spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
        @keyframes pulse {
          0%, 100% { transform: scale(1); opacity: 1; }
          50% { transform: scale(1.08); opacity: 0.7; }
        }
      `}</style>
    </div>
  );
}
