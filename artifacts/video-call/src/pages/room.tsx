import React, { useEffect, useRef, useState, useCallback } from "react";
import { useParams, useLocation } from "wouter";
import { useGetRoom } from "@workspace/api-client-react";
import { io, Socket } from "socket.io-client";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import {
  Mic,
  MicOff,
  Video as VideoIcon,
  VideoOff,
  PhoneOff,
  Copy,
  Users,
  ShieldCheck,
  Loader2,
} from "lucide-react";

export default function Room() {
  const { roomId } = useParams<{ roomId: string }>();
  const [, setLocation] = useLocation();

  const localVideoRef = useRef<HTMLVideoElement>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const socketRef = useRef<Socket | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const remoteUserIdRef = useRef<string | null>(null);

  const [isMuted, setIsMuted] = useState(false);
  const [isVideoOff, setIsVideoOff] = useState(false);
  const [hasRemoteVideo, setHasRemoteVideo] = useState(false);
  const [permissionError, setPermissionError] = useState(false);

  // WhatsApp-style swap: false = remote is main, true = local is main
  const [isSwapped, setIsSwapped] = useState(false);

  // Draggable PiP state
  const [pipPosition, setPipPosition] = useState({ x: 16, y: 80 });
  const dragging = useRef(false);
  const dragOffset = useRef({ x: 0, y: 0 });

  const { data: room, isLoading: isLoadingRoom, isError: isRoomError } = useGetRoom(roomId);

  useEffect(() => {
    if (isRoomError) {
      toast.error("Room not found");
      setLocation("/");
    }
  }, [isRoomError, setLocation]);

  // --- Draggable PiP handlers ---
  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    dragging.current = true;
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    dragOffset.current = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    e.preventDefault();
  }, []);

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    if (!dragging.current) return;
    const parent = (e.currentTarget as HTMLElement).parentElement;
    if (!parent) return;
    const parentRect = parent.getBoundingClientRect();
    const elW = (e.currentTarget as HTMLElement).offsetWidth;
    const elH = (e.currentTarget as HTMLElement).offsetHeight;
    let newX = e.clientX - parentRect.left - dragOffset.current.x;
    let newY = e.clientY - parentRect.top - dragOffset.current.y;
    newX = Math.max(8, Math.min(newX, parentRect.width - elW - 8));
    newY = Math.max(8, Math.min(newY, parentRect.height - elH - 8));
    setPipPosition({ x: newX, y: newY });
  }, []);

  const handlePointerUp = useCallback(() => {
    dragging.current = false;
  }, []);

  const handlePipTap = useCallback(() => {
    if (!dragging.current) {
      setIsSwapped((prev) => !prev);
    }
  }, []);

  // --- WebRTC setup ---
   useEffect(() => {
  if (!roomId) return;
  const iceCandidateBuffer: RTCIceCandidateInit[] = [];
  let remoteDescSet = false;
  const flushCandidates = async (pc: RTCPeerConnection) => {
    remoteDescSet = true;
    for (const c of iceCandidateBuffer) {
      try {
        await pc.addIceCandidate(new RTCIceCandidate(c));
      } catch (e) {
        console.error("Error flushing ice candidate", e);
      }
    }
    iceCandidateBuffer.length = 0;
  };
  const setupMediaAndWebRTC = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: true,
        audio: true,
      });
      localStreamRef.current = stream;
      if (localVideoRef.current) {
        localVideoRef.current.srcObject = stream;
      }
      const socket = io({ path: "/socket.io" });
      socketRef.current = socket;
      const pc = new RTCPeerConnection({
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
    {
      urls: "turn:openrelay.metered.ca:80",
      username: "openrelayproject",
      credential: "openrelayproject",
    },
    {
      urls: "turn:openrelay.metered.ca:443",
      username: "openrelayproject",
      credential: "openrelayproject",
    },
    {
      urls: "turn:openrelay.metered.ca:443?transport=tcp",
      username: "openrelayproject",
      credential: "openrelayproject",
    },
  ],
});
      pcRef.current = pc;
      stream.getTracks().forEach((track) => pc.addTrack(track, stream));
      pc.ontrack = (event) => {
        if (remoteVideoRef.current) {
          remoteVideoRef.current.srcObject = event.streams[0];
          setHasRemoteVideo(true);
        }
      };
      pc.onicecandidate = (event) => {
        if (event.candidate && remoteUserIdRef.current) {
          socket.emit("ice-candidate", {
            candidate: event.candidate.toJSON(),
            to: remoteUserIdRef.current,
          });
        }
      };
      socket.on("user-connected", async (userId: string) => {
        remoteUserIdRef.current = userId;
        try {
          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          socket.emit("offer", { offer, to: userId });
        } catch (e) {
          console.error("Error creating offer", e);
        }
      });
      socket.on("offer", async ({ offer, from }: { offer: RTCSessionDescriptionInit; from: string }) => {
        remoteUserIdRef.current = from;
        try {
          await pc.setRemoteDescription(new RTCSessionDescription(offer));
          await flushCandidates(pc); // apply any buffered candidates
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          socket.emit("answer", { answer, to: from });
        } catch (e) {
          console.error("Error handling offer", e);
        }
      });
      socket.on("answer", async ({ answer }: { answer: RTCSessionDescriptionInit }) => {
        try {
          await pc.setRemoteDescription(new RTCSessionDescription(answer));
          await flushCandidates(pc); // apply any buffered candidates
        } catch (e) {
          console.error("Error handling answer", e);
        }
      });
      socket.on("ice-candidate", async ({ candidate }: { candidate: RTCIceCandidateInit }) => {
        if (!candidate) return;
        if (remoteDescSet) {
          try {
            await pc.addIceCandidate(new RTCIceCandidate(candidate));
          } catch (e) {
            console.error("Error adding ice candidate", e);
          }
        } else {
          // Buffer it until remote description is ready
          iceCandidateBuffer.push(candidate);
        }
      });
      socket.on("user-disconnected", () => {
        setHasRemoteVideo(false);
        if (remoteVideoRef.current) {
          remoteVideoRef.current.srcObject = null;
        }
        if (pcRef.current) {
          const senders = pcRef.current.getSenders();
          senders.forEach((sender) => pcRef.current?.removeTrack(sender));
          if (localStreamRef.current) {
            localStreamRef.current
              .getTracks()
              .forEach((track) => pcRef.current?.addTrack(track, localStreamRef.current!));
          }
        }
      });
      socket.emit("join-room", roomId);
    } catch (err) {
      console.error("Media permission error", err);
      setPermissionError(true);
    }
  };
  setupMediaAndWebRTC();
  return () => {
    localStreamRef.current?.getTracks().forEach((track) => track.stop());
    pcRef.current?.close();
    socketRef.current?.disconnect();
  };
}, [roomId]);
      
  const toggleMute = () => {
    if (localStreamRef.current) {
      localStreamRef.current.getAudioTracks().forEach((track) => {
        track.enabled = !track.enabled;
      });
      setIsMuted(!isMuted);
    }
  };

  const toggleVideo = () => {
    if (localStreamRef.current) {
      localStreamRef.current.getVideoTracks().forEach((track) => {
        track.enabled = !track.enabled;
      });
      setIsVideoOff(!isVideoOff);
    }
  };

  const copyLink = () => {
    navigator.clipboard.writeText(window.location.href);
    toast.success("Link copied to clipboard!");
  };

  const leaveCall = () => {
    setLocation("/");
  };

  if (isLoadingRoom) {
    return (
      <div style={{
        minHeight: "100vh",
        background: "#0a0a0f",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}>
        <Loader2 className="w-8 h-8 animate-spin" style={{ color: "#7c5cfc" }} />
      </div>
    );
  }

  if (permissionError) {
    return (
      <div style={{
        minHeight: "100vh",
        background: "#0a0a0f",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "24px",
      }}>
        <div style={{
          background: "rgba(124,92,252,0.08)",
          border: "1px solid rgba(124,92,252,0.2)",
          borderRadius: "20px",
          padding: "32px",
          textAlign: "center",
          maxWidth: "400px",
          width: "100%",
        }}>
          <div style={{
            width: "64px",
            height: "64px",
            borderRadius: "50%",
            background: "rgba(239,68,68,0.15)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            margin: "0 auto 16px",
          }}>
            <VideoOff style={{ color: "#ef4444", width: "28px", height: "28px" }} />
          </div>
          <h2 style={{ color: "#fff", fontSize: "20px", fontWeight: 700, marginBottom: "8px" }}>
            Camera/Microphone Access Denied
          </h2>
          <p style={{ color: "rgba(255,255,255,0.5)", fontSize: "14px", lineHeight: 1.6 }}>
            We need access to your camera and microphone for the video call. Please allow access in your browser settings and refresh the page.
          </p>
          <Button
            onClick={() => window.location.reload()}
            style={{
              width: "100%",
              marginTop: "16px",
              background: "linear-gradient(135deg, #7c5cfc, #6c47ff)",
              border: "none",
              borderRadius: "12px",
              color: "#fff",
              fontWeight: 600,
              padding: "12px",
              cursor: "pointer",
            }}
          >
            Try Again
          </Button>
        </div>
      </div>
    );
  }

  const showWaiting = !hasRemoteVideo && !isSwapped;

  // Shared PiP wrapper style
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

  // Shared main wrapper style
  const mainWrapperStyle: React.CSSProperties = {
    position: "absolute",
    inset: 0,
  };

  return (
    <div style={{
      minHeight: "100vh",
      background: "#0a0a0f",
      display: "flex",
      flexDirection: "column",
      position: "relative",
      overflow: "hidden",
    }}>
      {/* Top Bar */}
      <div style={{
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
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
          <div style={{
            width: "36px",
            height: "36px",
            borderRadius: "10px",
            background: "linear-gradient(135deg, #7c5cfc, #6c47ff)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}>
            <VideoIcon style={{ color: "#fff", width: "18px", height: "18px" }} />
          </div>
          <div>
            <p style={{ color: "#fff", fontSize: "14px", fontWeight: 600, margin: 0 }}>
              Room {room?.id?.substring(0, 8)}
            </p>
            <p style={{ color: "rgba(255,255,255,0.4)", fontSize: "11px", margin: 0, display: "flex", alignItems: "center", gap: "4px" }}>
              <ShieldCheck style={{ width: "10px", height: "10px" }} />
              End-to-end encrypted
            </p>
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
          <div style={{
            display: "flex",
            alignItems: "center",
            gap: "4px",
            background: "rgba(255,255,255,0.1)",
            borderRadius: "20px",
            padding: "4px 10px",
            fontSize: "12px",
            color: "rgba(255,255,255,0.7)",
          }}>
            <Users style={{ width: "12px", height: "12px" }} />
            {hasRemoteVideo ? "2" : "1"}
          </div>
          <button
            onClick={copyLink}
            style={{
              display: "flex",
              alignItems: "center",
              gap: "4px",
              background: "rgba(255,255,255,0.1)",
              border: "none",
              borderRadius: "20px",
              padding: "6px 12px",
              fontSize: "12px",
              color: "rgba(255,255,255,0.7)",
              cursor: "pointer",
            }}
          >
            <Copy style={{ width: "12px", height: "12px" }} />
            Copy Link
          </button>
        </div>
      </div>

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
            style={{
              width: "100%",
              height: isSwapped ? "100%" : "100vh",
              objectFit: "cover",
              background: "#0a0a0f",
            }}
          />
          {/* Swap hint icon — only visible when remote is in PiP */}
          {isSwapped && (
            <div style={{
              position: "absolute",
              top: "6px",
              right: "6px",
              width: "22px",
              height: "22px",
              borderRadius: "50%",
              background: "rgba(124,92,252,0.6)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M7 16V4m0 0L3 8m4-4l4 4M17 8v12m0 0l4-4m-4 4l-4-4" />
              </svg>
            </div>
          )}
        </div>

        {/* Local video — PiP when !isSwapped, main when isSwapped */}
        {/* ref is always fixed to localVideoRef — never swapped */}
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
            style={{
              width: "100%",
              height: !isSwapped ? "100%" : "100vh",
              objectFit: "cover",
              background: "#0a0a0f",
              transform: "scaleX(-1)", // always mirror local camera
            }}
          />

          {/* "You" label — always follows local video */}
          <div style={{
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
          }}>
            You
          </div>

          {/* Swap hint icon — only visible when local is in PiP */}
          {!isSwapped && (
            <div style={{
              position: "absolute",
              top: "6px",
              right: "6px",
              width: "22px",
              height: "22px",
              borderRadius: "50%",
              background: "rgba(124,92,252,0.6)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M7 16V4m0 0L3 8m4-4l4 4M17 8v12m0 0l4-4m-4 4l-4-4" />
              </svg>
            </div>
          )}

          {/* Video off overlay — always tied to local stream */}
          {isVideoOff && (
            <div style={{
              position: "absolute",
              inset: 0,
              background: "rgba(10,10,15,0.9)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}>
              <VideoOff style={{ color: "rgba(255,255,255,0.3)", width: "24px", height: "24px" }} />
            </div>
          )}

          {/* Muted indicator — always tied to local stream */}
          {isMuted && (
            <div style={{
              position: "absolute",
              top: "6px",
              left: "6px",
              width: "20px",
              height: "20px",
              borderRadius: "50%",
              background: "rgba(239,68,68,0.8)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}>
              <MicOff style={{ width: "10px", height: "10px", color: "#fff" }} />
            </div>
          )}
        </div>

        {/* Waiting overlay — shown over remote (main) when no one has joined yet */}
        {showWaiting && (
          <div style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            background: "rgba(10,10,15,0.85)",
            zIndex: 10,
          }}>
            <div style={{
              width: "80px",
              height: "80px",
              borderRadius: "50%",
              background: "rgba(124,92,252,0.15)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              marginBottom: "16px",
              animation: "pulse 2s ease-in-out infinite",
            }}>
              <Users style={{ color: "#7c5cfc", width: "36px", height: "36px" }} />
            </div>
            <p style={{ color: "rgba(255,255,255,0.5)", fontSize: "16px" }}>
              Waiting for others to join...
            </p>
          </div>
        )}
      </div>

      {/* Control Bar */}
      <div style={{
        position: "absolute",
        bottom: 0,
        left: 0,
        right: 0,
        zIndex: 30,
        padding: "16px 24px 32px",
        background: "linear-gradient(0deg, rgba(0,0,0,0.8) 0%, transparent 100%)",
        display: "flex",
        justifyContent: "center",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: "16px" }}>
          <button
            onClick={toggleMute}
            style={{
              width: "52px",
              height: "52px",
              borderRadius: "50%",
              border: "none",
              background: isMuted ? "rgba(239,68,68,0.2)" : "rgba(255,255,255,0.15)",
              color: isMuted ? "#ef4444" : "#fff",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              cursor: "pointer",
              backdropFilter: "blur(12px)",
            }}
          >
            {isMuted ? <MicOff className="w-5 h-5" /> : <Mic className="w-5 h-5" />}
          </button>

          <button
            onClick={toggleVideo}
            style={{
              width: "52px",
              height: "52px",
              borderRadius: "50%",
              border: "none",
              background: isVideoOff ? "rgba(239,68,68,0.2)" : "rgba(255,255,255,0.15)",
              color: isVideoOff ? "#ef4444" : "#fff",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              cursor: "pointer",
              backdropFilter: "blur(12px)",
            }}
          >
            {isVideoOff ? <VideoOff className="w-5 h-5" /> : <VideoIcon className="w-5 h-5" />}
          </button>

          <button
            onClick={leaveCall}
            style={{
              height: "52px",
              borderRadius: "26px",
              border: "none",
              background: "linear-gradient(135deg, #ef4444, #dc2626)",
              color: "#fff",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: "8px",
              padding: "0 24px",
              cursor: "pointer",
              fontWeight: 600,
              fontSize: "14px",
              boxShadow: "0 4px 20px rgba(239,68,68,0.4)",
            }}
          >
            <PhoneOff className="w-5 h-5" />
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
