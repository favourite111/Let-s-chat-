import React, { useEffect, useRef, useState } from "react";
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

  const { data: room, isLoading: isLoadingRoom, isError: isRoomError } = useGetRoom(roomId);

  useEffect(() => {
    if (isRoomError) {
      toast.error("Room not found");
      setLocation("/");
    }
  }, [isRoomError, setLocation]);

  useEffect(() => {
    if (!roomId) return;

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
          iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
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

        socket.on("offer", async ({ offer, from }: { offer: RTCSessionDescriptionInit, from: string }) => {
          remoteUserIdRef.current = from;
          try {
            await pc.setRemoteDescription(new RTCSessionDescription(offer));
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
          } catch (e) {
            console.error("Error handling answer", e);
          }
        });

        socket.on("ice-candidate", async ({ candidate }: { candidate: RTCIceCandidateInit }) => {
          try {
            if (candidate) {
              await pc.addIceCandidate(new RTCIceCandidate(candidate));
            }
          } catch (e) {
            console.error("Error adding ice candidate", e);
          }
        });

        socket.on("user-disconnected", () => {
          setHasRemoteVideo(false);
          if (remoteVideoRef.current) {
            remoteVideoRef.current.srcObject = null;
          }
          // Reset peer connection state for next connection
          if (pcRef.current) {
             const senders = pcRef.current.getSenders();
             senders.forEach(sender => pcRef.current?.removeTrack(sender));

             if (localStreamRef.current) {
               localStreamRef.current.getTracks().forEach(track => pcRef.current?.addTrack(track, localStreamRef.current!));
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
      <div className="min-h-screen flex items-center justify-center bg-background">
        <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (permissionError) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center p-4 bg-background">
        <div className="max-w-md w-full bg-card p-8 rounded-2xl border text-center space-y-4 shadow-xl">
          <div className="w-16 h-16 bg-destructive/10 text-destructive rounded-full flex items-center justify-center mx-auto mb-4">
            <VideoOff className="w-8 h-8" />
          </div>
          <h2 className="text-xl font-bold">Camera/Microphone Access Denied</h2>
          <p className="text-muted-foreground text-sm">
            We need access to your camera and microphone for the video call. Please allow access in your browser settings and refresh the page.
          </p>
          <Button onClick={() => window.location.reload()} className="w-full mt-4">
            Try Again
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-[100dvh] w-full bg-black flex flex-col overflow-hidden">
      {/* Top Bar */}
      <div className="absolute top-0 inset-x-0 h-20 bg-gradient-to-b from-black/80 to-transparent z-10 flex items-center justify-between px-6">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 bg-primary/20 backdrop-blur rounded-xl border border-primary/30 flex items-center justify-center text-primary">
            <VideoIcon className="w-5 h-5" />
          </div>
          <div>
            <h1 className="text-white font-medium">Room {room?.id.substring(0, 8)}</h1>
            <div className="flex items-center gap-2 text-xs text-white/60">
              <ShieldCheck className="w-3 h-3 text-green-400" />
              End-to-end encrypted
            </div>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <div className="px-3 py-1.5 rounded-full bg-white/10 backdrop-blur border border-white/10 text-white text-sm font-medium flex items-center gap-2">
            <Users className="w-4 h-4" />
            {hasRemoteVideo ? "2" : "1"}
          </div>
          <Button
            variant="secondary"
            size="sm"
            onClick={copyLink}
            className="bg-white/10 hover:bg-white/20 text-white border-none"
          >
            <Copy className="w-4 h-4 mr-2" />
            Copy Link
          </Button>
        </div>
      </div>

      {/* Video Grid */}
      <div className="flex-1 p-4 pb-28 flex flex-col md:flex-row gap-4 items-center justify-center h-full max-w-7xl mx-auto w-full">
        {/* Remote Video Container */}
        <div className="relative w-full h-full flex-1 rounded-2xl overflow-hidden bg-zinc-900 border border-white/10 flex items-center justify-center">
          <video
            ref={remoteVideoRef}
            autoPlay
            playsInline
            className={`w-full h-full object-cover ${!hasRemoteVideo && "hidden"}`}
          />
          {!hasRemoteVideo && (
            <div className="absolute inset-0 flex flex-col items-center justify-center text-white/50 space-y-4">
              <div className="w-20 h-20 rounded-full bg-white/5 border border-white/10 flex items-center justify-center animate-pulse">
                <Users className="w-8 h-8" />
              </div>
              <p className="text-sm font-medium tracking-wide">Waiting for others to join...</p>
            </div>
          )}
        </div>

        {/* Local Video Container */}
        <div className={`relative transition-all duration-500 ease-in-out z-20 ${
          hasRemoteVideo 
            ? "absolute bottom-32 right-8 w-48 h-72 shadow-2xl" 
            : "w-full h-full flex-1"
        } rounded-2xl overflow-hidden bg-zinc-900 border border-white/20`}>
          <video
            ref={localVideoRef}
            autoPlay
            playsInline
            muted
            className={`w-full h-full object-cover transition-opacity duration-300 ${isVideoOff ? "opacity-0" : "opacity-100"} scale-x-[-1]`}
          />

          <div className="absolute bottom-3 left-3 px-2 py-1 rounded-md bg-black/60 backdrop-blur text-white text-xs font-medium border border-white/10">
            You
          </div>

          {isVideoOff && (
            <div className="absolute inset-0 flex items-center justify-center bg-zinc-900">
              <div className="w-16 h-16 rounded-full bg-white/10 flex items-center justify-center">
                <VideoOff className="w-6 h-6 text-white/70" />
              </div>
            </div>
          )}
          {isMuted && (
            <div className="absolute top-3 right-3 w-8 h-8 rounded-full bg-destructive/90 backdrop-blur flex items-center justify-center shadow-lg">
              <MicOff className="w-4 h-4 text-white" />
            </div>
          )}
        </div>
      </div>

      {/* Control Bar */}
      <div className="absolute bottom-0 inset-x-0 h-24 bg-gradient-to-t from-black/90 to-transparent flex items-center justify-center pb-6">
        <div className="flex items-center gap-4 bg-white/10 backdrop-blur-xl p-2 rounded-2xl border border-white/10 shadow-2xl">
          <Button
            size="icon"
            variant="ghost"
            onClick={toggleMute}
            className={`w-12 h-12 rounded-xl transition-all ${
              isMuted 
                ? "bg-destructive/20 text-destructive hover:bg-destructive/30 hover:text-destructive" 
                : "bg-white/5 text-white hover:bg-white/15"
            }`}
          >
            {isMuted ? <MicOff className="w-5 h-5" /> : <Mic className="w-5 h-5" />}
          </Button>

          <Button
            size="icon"
            variant="ghost"
            onClick={toggleVideo}
            className={`w-12 h-12 rounded-xl transition-all ${
              isVideoOff 
                ? "bg-destructive/20 text-destructive hover:bg-destructive/30 hover:text-destructive" 
                : "bg-white/5 text-white hover:bg-white/15"
            }`}
          >
            {isVideoOff ? <VideoOff className="w-5 h-5" /> : <VideoIcon className="w-5 h-5" />}
          </Button>

          <div className="w-[1px] h-8 bg-white/10 mx-2" />

          <Button
            size="lg"
            variant="destructive"
            onClick={leaveCall}
            className="px-6 h-12 rounded-xl font-medium shadow-lg hover:shadow-destructive/50 transition-shadow"
          >
            <PhoneOff className="w-5 h-5 mr-2" />
            Leave
          </Button>
        </div>
      </div>
    </div>
  );
}
