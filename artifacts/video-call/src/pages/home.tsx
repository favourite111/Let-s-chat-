import React, { useState } from "react";
import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useCreateRoom, useHealthCheck } from "@workspace/api-client-react";
import { Video, ArrowRight, Loader2 } from "lucide-react";
import { toast } from "sonner";

export default function Home() {
  const [, setLocation] = useLocation();
  const [roomCode, setRoomCode] = useState("");
  const [hostName, setHostName] = useState("");

  const { data: health } = useHealthCheck();
  const createRoom = useCreateRoom();

  const handleCreateRoom = () => {
    createRoom.mutate(
      { data: { hostName: hostName || "Guest" } },
      {
        onSuccess: (room) => {
          setLocation(`/room/${room.id}`);
        },
        onError: () => {
          toast.error("Failed to create room. Please try again.");
        },
      }
    );
  };

  const handleJoinRoom = (e: React.FormEvent) => {
    e.preventDefault();
    if (!roomCode.trim()) return;
    setLocation(`/room/${roomCode.trim()}`);
  };

  return (
    <div className="min-h-screen w-full flex flex-col items-center justify-center p-4 bg-[#0a0a0f]">
      {/* Layered gradient background */}
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top,_rgba(120,80,255,0.12)_0%,_transparent_60%)] -z-10" />
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_bottom_left,_rgba(80,120,255,0.08)_0%,_transparent_50%)] -z-10" />
      <div className="absolute inset-0 bg-[linear-gradient(to_bottom,_transparent_0%,_rgba(0,0,0,0.4)_100%)] -z-10" />

      <div className="w-full max-w-md space-y-10 animate-in fade-in slide-in-from-bottom-6 duration-1000">
        {/* Header */}
        <div className="text-center space-y-3">
          <div className="mx-auto w-20 h-20 bg-gradient-to-br from-[#7c5cfc]/20 to-[#5c8cfc]/10 rounded-3xl flex items-center justify-center mb-8 border border-[#7c5cfc]/25 shadow-[0_0_60px_rgba(124,92,252,0.15),_0_0_120px_rgba(124,92,252,0.05)] backdrop-blur-sm transition-all duration-500 hover:shadow-[0_0_80px_rgba(124,92,252,0.25)] hover:scale-105">
            <Video className="w-9 h-9 text-[#9580ff]" />
          </div>
          <h1 className="text-5xl font-bold tracking-tight text-white">
            Video<span className="bg-gradient-to-r from-[#9580ff] to-[#7c5cfc] bg-clip-text text-transparent">Call</span>
          </h1>
          <p className="text-[#8888a0] text-lg font-light">
            Connect instantly, face-to-face.
          </p>
          {health && (
            <div className="flex items-center justify-center gap-2 mt-5 text-xs text-[#555570]">
              <span className="relative flex h-2.5 w-2.5">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-60" />
                <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-emerald-500" />
              </span>
              Systems Operational
            </div>
          )}
        </div>

        {/* Card */}
        <div className="bg-[#13131f]/80 border border-[#2a2a40] shadow-[0_8px_32px_rgba(0,0,0,0.4),_0_0_0_1px_rgba(255,255,255,0.03)] rounded-3xl p-7 space-y-8 backdrop-blur-xl">
          {/* Start a new call */}
          <div className="space-y-4">
            <h2 className="text-xs font-semibold text-[#6a6a80] uppercase tracking-[0.2em]">
              Start a new call
            </h2>
            <div className="space-y-3">
              <Input
                placeholder="Your name (optional)"
                value={hostName}
                onChange={(e) => setHostName(e.target.value)}
                className="h-13 bg-[#0e0e18] border-[#2a2a40] text-white placeholder:text-[#4a4a60] rounded-xl focus:border-[#7c5cfc]/50 focus:ring-[#7c5cfc]/20 transition-all duration-300"
              />
              <Button
                size="lg"
                className="w-full h-13 text-md font-semibold bg-gradient-to-r from-[#7c5cfc] to-[#6a4cfc] hover:from-[#8b6dff] hover:to-[#7c5cfc] text-white rounded-xl shadow-[0_4px_20px_rgba(124,92,252,0.3)] hover:shadow-[0_6px_30px_rgba(124,92,252,0.45)] transition-all duration-300 border-0"
                onClick={handleCreateRoom}
                disabled={createRoom.isPending}
              >
                {createRoom.isPending ? (
                  <Loader2 className="w-5 h-5 mr-2 animate-spin" />
                ) : (
                  <Video className="w-5 h-5 mr-2" />
                )}
                Create Room
              </Button>
            </div>
          </div>

          {/* Divider */}
          <div className="relative">
            <div className="absolute inset-0 flex items-center">
              <span className="w-full border-t border-[#2a2a40]" />
            </div>
            <div className="relative flex justify-center text-xs uppercase">
              <span className="bg-[#13131f] px-4 text-[#4a4a60] font-medium tracking-widest">Or</span>
            </div>
          </div>

          {/* Join existing call */}
          <div className="space-y-4">
            <h2 className="text-xs font-semibold text-[#6a6a80] uppercase tracking-[0.2em]">
              Join existing call
            </h2>
            <form onSubmit={handleJoinRoom} className="flex gap-2">
              <Input
                placeholder="Paste room code..."
                value={roomCode}
                onChange={(e) => setRoomCode(e.target.value)}
                className="h-13 bg-[#0e0e18] border-[#2a2a40] text-white placeholder:text-[#4a4a60] rounded-xl flex-1 focus:border-[#7c5cfc]/50 focus:ring-[#7c5cfc]/20 transition-all duration-300"
              />
              <Button
                type="submit"
                size="icon"
                className="h-13 w-13 shrink-0 bg-[#1e1e30] hover:bg-[#2a2a45] text-[#9580ff] border border-[#2a2a40] rounded-xl transition-all duration-300 hover:border-[#7c5cfc]/40 hover:shadow-[0_0_15px_rgba(124,92,252,0.15)]"
                disabled={!roomCode.trim()}
              >
                <ArrowRight className="w-5 h-5" />
              </Button>
            </form>
          </div>
        </div>

        {/* Footer */}
        <p className="text-center text-[#3a3a50] text-xs">
          End-to-end encrypted · No sign-up required
        </p>
      </div>
    </div>
  );
}
