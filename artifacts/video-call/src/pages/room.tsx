import React, { useEffect, useRef, useState, useCallback } from "react";
import { useParams, useLocation } from "wouter";
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
  ArrowLeftRight,
  Phone,
} from "lucide-react";

export default function Room() {
  const { roomId } = useParams<{ roomId: string }>();
  const [, navigate] = useLocation();

  const localVideoRef = useRef<HTMLVideoElement>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  const localStreamRef = useRef<MediaStream | null>(null);

  const [isConnected, setIsConnected] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  const [isVideoOff, setIsVideoOff] = useState(false);

  const [isSwapped, setIsSwapped] = useState(false);
  const [pipPosition, setPipPosition] = useState({ x: 16, y: 80 });
  const dragging = useRef(false);
  const dragOffset = useRef({ x: 0, y: 0 });
  const pipRef = useRef<HTMLDivElement>(null);
  const wasDragged = useRef(false);

  useEffect(() => {
    let stream: MediaStream | null = null;
    const startCamera = async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
        localStreamRef.current = stream;
        if (localVideoRef.current) localVideoRef.current.srcObject = stream;
      } catch (err) {
        toast.error("Could not access camera/microphone");
      }
    };
    startCamera();
    return () => { stream?.getTracks().forEach((t) => t.stop()); };
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => {
      if (localStreamRef.current && remoteVideoRef.current) {
        remoteVideoRef.current.srcObject = localStreamRef.current;
        setIsConnected(true);
        toast.success("Partner connected!");
      }
    }, 8000);
    return () => clearTimeout(timer);
  }, []);

  const toggleMute = useCallback(() => {
    const stream = localStreamRef.current;
    if (stream) {
      stream.getAudioTracks().forEach((t) => (t.enabled = !t.enabled));
      setIsMuted((m) => !m);
    }
  }, []);

  const toggleVideo = useCallback(() => {
    const stream = localStreamRef.current;
    if (stream) {
      stream.getVideoTracks().forEach((t) => (t.enabled = !t.enabled));
      setIsVideoOff((v) => !v);
    }
  }, []);

  const leaveCall = useCallback(() => {
    localStreamRef.current?.getTracks().forEach((t) => t.stop());
    navigate("/");
  }, [navigate]);

  const copyLink = useCallback(() => {
    navigator.clipboard.writeText(window.location.href);
    toast.success("Room link copied!");
  }, []);

  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    dragging.current = true;
    wasDragged.current = false;
    dragOffset.current = { x: e.clientX - pipPosition.x, y: e.clientY - pipPosition.y };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }, [pipPosition]);

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    if (!dragging.current) return;
    wasDragged.current = true;
    const maxX = window.innerWidth - 130;
    const maxY = window.innerHeight - 180;
    setPipPosition({
      x: Math.max(8, Math.min(e.clientX - dragOffset.current.x, maxX)),
      y: Math.max(8, Math.min(e.clientY - dragOffset.current.y, maxY)),
    });
  }, []);

  const handlePointerUp = useCallback(() => { dragging.current = false; }, []);

  const handlePipTap = useCallback(() => {
    if (!wasDragged.current && isConnected) setIsSwapped((s) => !s);
  }, [isConnected]);

  const mainVideoRef = isConnected
    ? isSwapped ? localVideoRef : remoteVideoRef
    : localVideoRef;

  const pipVideoRef = isConnected
    ? isSwapped ? remoteVideoRef : localVideoRef
    : null;

  return (
    <div className="relative h-screen w-screen overflow-hidden bg-[hsl(240,20%,4%)] select-none">
      <video
        ref={mainVideoRef}
        autoPlay
        playsInline
        muted={mainVideoRef === localVideoRef}
        className="absolute inset-0 h-full w-full object-cover"
      />
      <div className="absolute inset-0 bg-black/10 pointer-events-none" />

      <div className="absolute top-0 inset-x-0 z-20 flex items-center justify-between px-4 pt-3 pb-2">
        <div className="flex items-center gap-2">
          {!isConnected ? (
            <>
              <Phone className="w-4 h-4 text-green-400 animate-pulse" />
              <span className="text-sm font-medium text-white/90 drop-shadow">Calling…</span>
            </>
          ) : (
            <>
              <div className="w-2 h-2 rounded-full bg-green-400" />
              <span className="text-sm font-medium text-white/90 drop-shadow">Connected</span>
            </>
          )}
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 text-white/80 hover:text-white hover:bg-white/10"
          onClick={copyLink}
        >
          <Copy className="w-4 h-4" />
        </Button>
      </div>

      {isConnected && pipVideoRef && (
        <div
          ref={pipRef}
          className="absolute z-30 w-[120px] h-[160px] rounded-2xl overflow-hidden shadow-2xl border-2 border-white/20 cursor-grab active:cursor-grabbing"
          style={{ left: pipPosition.x, top: pipPosition.y, touchAction: "none" }}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onClick={handlePipTap}
        >
          <video
            ref={pipVideoRef}
            autoPlay
            playsInline
            muted={pipVideoRef === localVideoRef}
            className="h-full w-full object-cover"
          />
          <div className="absolute bottom-1 right-1 rounded-full bg-black/50 p-1">
            <ArrowLeftRight className="w-3 h-3 text-white/70" />
          </div>
          <div className="absolute top-1 left-1.5 text-[10px] font-medium text-white/80 drop-shadow">
            {pipVideoRef === localVideoRef ? "You" : "Partner"}
          </div>
        </div>
      )}

      {isVideoOff && mainVideoRef === localVideoRef && (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-[hsl(240,20%,8%)]">
          <div className="w-20 h-20 rounded-full bg-white/10 flex items-center justify-center">
            <VideoOff className="w-8 h-8 text-white/50" />
          </div>
        </div>
      )}

      <div className="absolute bottom-0 inset-x-0 z-20 pb-8 pt-4 flex justify-center">
        <div className="flex items-center gap-4 px-6 py-3 rounded-full bg-black/40 backdrop-blur-xl border border-white/10">
          <Button
            variant="ghost"
            size="icon"
            className={`h-12 w-12 rounded-full ${isMuted ? "bg-red-500/20 text-red-400 hover:bg-red-500/30" : "bg-white/10 text-white hover:bg-white/20"}`}
            onClick={toggleMute}
          >
            {isMuted ? <MicOff className="w-5 h-5" /> : <Mic className="w-5 h-5" />}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className={`h-12 w-12 rounded-full ${isVideoOff ? "bg-red-500/20 text-red-400 hover:bg-red-500/30" : "bg-white/10 text-white hover:bg-white/20"}`}
            onClick={toggleVideo}
          >
            {isVideoOff ? <VideoOff className="w-5 h-5" /> : <VideoIcon className="w-5 h-5" />}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-14 w-14 rounded-full bg-red-500 text-white hover:bg-red-600"
            onClick={leaveCall}
          >
            <PhoneOff className="w-6 h-6" />
          </Button>
        </div>
      </div>
    </div>
  );
}
