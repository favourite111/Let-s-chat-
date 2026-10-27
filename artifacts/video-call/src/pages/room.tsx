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
  UserX,
  Crown,
  PhoneOff as PhoneOffIcon,
} from "lucide-react";
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
  const remoteParticipantIdRef = useRef<string | null>(null);
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
  // Roster comes from the server, never inferred from whether video is flowing.
  const [roster, setRoster] = useState<RosterEntry[]>([]);
  const [isHost, setIsHost] = useState(false);
  const [selfParticipantId, setSelfParticipantId] = useState<string | null>(null);
  const [joinAttempt, setJoinAttempt] = useState(0);

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
  //
  // Identity, not sockets: this browser presents the same participantId on
  // every join, so a reload or a reconnect reclaims its seat rather than
  // arriving as a second person and filling the room with ghosts.
  useEffect(() => {
    if (!roomId) return;

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

    // Built fresh each time: a later reclaim switches the identity used here.
    const joinPayload = () => ({ roomId, participantId, hostSecret, displayName: null });

    const resolveIdentity = async () => {
      try {
        const res = await fetch(`/api/rooms/${roomId}`);
        if (res.status === 404) {
          toast.error("That room doesn't exist any more.");
          setLocation("/");
          return false;
        }
        if (res.ok) {
          const room = (await res.json()) as { closed?: boolean; hostConnected?: boolean };
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
        if (!event.candidate || !remoteParticipantIdRef.current) return;
        socket.emit("ice-candidate", {
          candidate: event.candidate.toJSON(),
          to: remoteParticipantIdRef.current,
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

    /** Release hardware, peer connection and quality loop for good. */
    const stopEverything = () => {
      localStreamRef.current?.getTracks().forEach((track) => track.stop());
      localStreamRef.current = null;
      if (localVideoRef.current) localVideoRef.current.srcObject = null;
      qualityRef.current?.stop();
      qualityRef.current = null;
      pcRef.current?.close();
      pcRef.current = null;
      setHasRemoteVideo(false);
    };

    /**
     * A tab of the host's own browser that joined as a guest (because the host
     * was still in the call elsewhere) keeps watching the room. When the host's
     * seat has been free for a while — the other window was closed — this tab
     * takes it back, so the room never becomes uncontrollable just because a
     * window was closed.
     *
     * "For a while" matters: a host who is merely reconnecting has a free seat
     * for a moment, and there is no point in two windows fighting over it.
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
      // No stored host id means this tab either is the host or never created
      // the room; there is no seat to reclaim.
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
            // claiming on the same tick; the loser would be sent back to a
            // guest seat for no reason.
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
      // 0. Who is this tab in this room? Decided before the camera is touched,
      //    so a closed room never turns it on.
      if (!(await resolveIdentity())) return;

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
        if (terminal) return;
        setStatus("connecting");
        setHasRemoteVideo(false);
        remoteParticipantIdRef.current = null;
        // Fresh peer connection per connection attempt.
        if (pcRef.current) {
          pcRef.current.ontrack = null;
          pcRef.current.onicecandidate = null;
          pcRef.current.close();
          pcRef.current = null;
        }
        socket.emit("join-room", joinPayload());
      });

      socket.on("disconnect", () => {
        if (!terminal) setStatus("reconnecting");
      });

      socket.on(
        "room-joined",
        ({
          participants,
          isHost: hostFlag,
        }: {
          participants?: RosterEntry[];
          isHost?: boolean;
          reclaimed?: boolean;
        }) => {
          claimingHost = Boolean(hostFlag);
          setIsHost(Boolean(hostFlag));
          if (claimingHost) stopReclaimWatch();
          setRoster(participants ?? []);
          setJoinAttempt(0);

          const others = (participants ?? []).filter(
            (p) => p.participantId !== participantId && p.connected,
          );
          if (others.length > 0) {
            // They will send us an offer once `user-connected` reaches them.
            setStatus("connecting");
          } else {
            setStatus("waiting");
          }
          emitMediaState();
          if (!claimingHost) startReclaimWatch(socket);
        },
      );

      socket.on(
        "room-state",
        ({ participants, count }: { participants?: RosterEntry[]; count?: number }) => {
          const next = participants ?? [];
          setRoster(next);
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
        // Terminal: turn the hardware off, not just the video element.
        stopEverything();
        window.setTimeout(() => socket.disconnect(), 0);
      });

      /**
       * Another window of this browser took the seat this one was holding —
       * a duplicated tab, or two windows racing to reclaim the host seat.
       *
       * Only one socket can own a seat, so this one stands down — but it does
       * not throw the person out of the call: it asks for an ordinary guest
       * seat instead. If a seat is gone (the winner is a guest and the other
       * slot is taken) the normal room-full retry takes over.
       */
      socket.on("session-replaced", () => {
        if (terminal) return;
        claimingHost = false;
        setIsHost(false);
        participantId = getParticipantId();
        hostSecret = null;
        // The peer was talking to the identity that just lost the seat.
        remoteParticipantIdRef.current = null;
        qualityRef.current?.stop();
        qualityRef.current = null;
        pcRef.current?.close();
        pcRef.current = null;
        setHasRemoteVideo(false);
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
        stopEverything();
        window.setTimeout(() => socket.disconnect(), 0);
      });

      socket.on("host-action-error", ({ action, reason }: { action?: string; reason?: string }) => {
        if (action === "end-call") toast.error("Only the host can end this call.");
        else if (action === "remove-participant")
          toast.error(reason === "target-not-found" ? "That participant already left." : "Only the host can remove someone.");
      });

      socket.on("participant-removed", () => {
        toast.success("Participant removed.");
      });

      // A peer is present — a newcomer, or the same person after a reload. In
      // both cases this side offers a fresh connection: their old one is dead.
      socket.on("user-connected", async ({ participantId: peerId }: { participantId: string }) => {
        if (peerId === participantId) return;
        remoteParticipantIdRef.current = peerId;
        const pc = createPeer(socket);
        try {
          const offer = await pc.createOffer();
          // Opus tuning has to happen in the SDP text — there is no API for it.
          offer.sdp = tuneOpusSdp(offer.sdp ?? "");
          await pc.setLocalDescription(offer);
          socket.emit("offer", { offer, to: peerId });
          startQualityLoop(pc);
        } catch (err) {
          console.error("Error creating offer", err);
        }
      });

      socket.on(
        "offer",
        async ({ offer, from }: { offer: RTCSessionDescriptionInit; from: string }) => {
          remoteParticipantIdRef.current = from;
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
        remoteParticipantIdRef.current = null;
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
      stopReclaimWatch();
      if (retryTimer !== null) window.clearTimeout(retryTimer);
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
    // Tell the server first: this releases the seat immediately instead of
    // leaving a ghost that holds the slot until the ping timeout.
    socketRef.current?.emit("leave");
    localStreamRef.current?.getTracks().forEach((track) => track.stop());
    pcRef.current?.close();
    socketRef.current?.disconnect();
    setLocation("/");
  };

  /**
   * Host-only: end the call for everyone and close the room permanently.
   * The server re-checks ownership; this call is refused if we are not the host.
   */
  const endCallForEveryone = () => {
    if (!roomId) return;
    const ok = window.confirm(
      "End the call for everyone? The room closes and nobody can rejoin.",
    );
    if (!ok) return;
    const socket = socketRef.current;

    if (socket?.connected) {
      // The server re-verifies ownership, closes the room and broadcasts
      // `room-closed` to everyone (host included). The listener above does the
      // teardown, so the UI only changes once the server has actually closed it.
      socket.emit("end-call");
      return;
    }

    // Socket is down: close over REST. The server notifies the room from there.
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

  /**
   * Terminal states. These are not retried: the room is closed or this
   * participant was removed, and the server will refuse a rejoin anyway.
   */
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

  const showWaiting = status === "waiting" || status === "connecting";
  const connectedCount = roster.filter((p) => p.connected).length;
  const participantCount = Math.max(connectedCount, 1);
  const remotePeer = roster.find(
    (p) => p.connected && p.participantId !== selfParticipantId,
  );
  const selfEntry = roster.find((p) => p.participantId === selfParticipantId);
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
            aria-label={`${participantCount} ${participantCount === 1 ? "participant" : "participants"}`}
            style={{ display: "flex", alignItems: "center", gap: "4px", background: "rgba(255,255,255,0.1)", borderRadius: "20px", padding: "4px 10px", fontSize: "12px", color: "rgba(255,255,255,0.7)" }}
          >
            <Users style={{ width: "12px", height: "12px" }} aria-hidden="true" />
            {participantCount}
          </div>
          {isHost && (
            <div
              aria-label="You are the host"
              style={{ display: "flex", alignItems: "center", gap: "4px", background: "rgba(124,92,252,0.2)", border: "1px solid rgba(124,92,252,0.4)", borderRadius: "20px", padding: "4px 10px", fontSize: "12px", color: "#c4b5fd", fontWeight: 600 }}
            >
              <Crown style={{ width: "12px", height: "12px" }} aria-hidden="true" />
              Host
            </div>
          )}
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

          {isHost && remotePeer && (
            <button
              onClick={() => removeParticipant(remotePeer.participantId)}
              aria-label="Remove participant from this room"
              style={{ height: "52px", borderRadius: "26px", border: "1px solid rgba(245,158,11,0.4)", background: "rgba(245,158,11,0.15)", color: "#fbbf24", display: "flex", alignItems: "center", justifyContent: "center", gap: "8px", padding: "0 20px", cursor: "pointer", fontWeight: 600, fontSize: "14px" }}
            >
              <UserX className="w-5 h-5" aria-hidden="true" />
              Remove
            </button>
          )}

          {isHost && (
            <button
              onClick={endCallForEveryone}
              aria-label="End the call for everyone and close the room"
              style={{ height: "52px", borderRadius: "26px", border: "none", background: "rgba(239,68,68,0.2)", color: "#fca5a5", display: "flex", alignItems: "center", justifyContent: "center", gap: "8px", padding: "0 20px", cursor: "pointer", fontWeight: 600, fontSize: "14px" }}
            >
              <PhoneOff className="w-5 h-5" aria-hidden="true" />
              End for all
            </button>
          )}
        </div>
      </div>

      <style>{`
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
