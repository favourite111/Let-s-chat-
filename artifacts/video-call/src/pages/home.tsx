import React, { useState } from "react";
import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useCreateRoom, useHealthCheck } from "@workspace/api-client-react";
import { Video, ArrowRight, Loader2, Sparkles, Zap, Shield } from "lucide-react";
import { toast } from "sonner";

export default function Home() {
  const [, setLocation] = useLocation();
  const [roomCode, setRoomCode] = useState("");
  const [hostName, setHostName] = useState("");
  const [isHovering, setIsHovering] = useState(false);

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
    <div className="min-h-screen w-full flex flex-col items-center justify-center p-4 relative overflow-hidden bg-gradient-to-br from-slate-950 via-slate-900 to-slate-950">
      {/* Animated Background Elements */}
      <div className="fixed inset-0 overflow-hidden pointer-events-none">
        {/* Gradient Orbs */}
        <div className="absolute top-0 left-1/4 w-[600px] h-[600px] bg-primary/10 rounded-full blur-[150px] animate-pulse" />
        <div className="absolute bottom-0 right-1/4 w-[500px] h-[500px] bg-purple-500/10 rounded-full blur-[150px] animate-pulse" style={{ animationDelay: '1s' }} />
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[800px] h-[800px] bg-blue-500/5 rounded-full blur-[200px]" />

        {/* Grid Pattern */}
        <div className="absolute inset-0 bg-[linear-gradient(rgba(255,255,255,0.02)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.02)_1px,transparent_1px)] bg-[size:60px_60px] [mask-image:radial-gradient(ellipse_at_center,black,transparent_70%)]" />
      </div>

      {/* Floating Particles */}
      <div className="fixed inset-0 overflow-hidden pointer-events-none">
        {[...Array(6)].map((_, i) => (
          <div
            key={i}
            className="absolute w-2 h-2 bg-primary/30 rounded-full animate-float"
            style={{
              left: `${15 + i * 15}%`,
              top: `${20 + (i % 3) * 25}%`,
              animationDelay: `${i * 0.5}s`,
              animationDuration: `${4 + i}s`
            }}
          />
        ))}
      </div>

      <div className="w-full max-w-lg relative z-10">
        {/* Header Section */}
        <div className="text-center space-y-6 mb-10">
          {/* Logo */}
          <div className="relative mx-auto w-20 h-20 mb-8">
            <div className="absolute inset-0 bg-gradient-to-br from-primary/40 to-purple-500/40 rounded-2xl blur-xl animate-pulse" />
            <div className="relative w-full h-full bg-gradient-to-br from-primary/20 to-primary/5 backdrop-blur-xl rounded-2xl flex items-center justify-center border border-primary/30 shadow-[0_0_60px_rgba(100,100,250,0.3)] group hover:scale-105 transition-transform duration-500">
              <Video className="w-10 h-10 text-primary group-hover:scale-110 transition-transform" />
            </div>
            <div className="absolute -top-1 -right-1 w-6 h-6 bg-gradient-to-br from-yellow-400 to-orange-500 rounded-full flex items-center justify-center shadow-lg">
              <Sparkles className="w-3 h-3 text-white" />
            </div>
          </div>

          {/* Title */}
          <div className="space-y-3">
            <h1 className="text-5xl font-bold tracking-tight bg-gradient-to-r from-white via-white to-slate-400 bg-clip-text text-transparent">
          Impeccable-Call
            </h1>
            <p className="text-slate-400 text-lg font-light">
            built by impeccable Connect instantly, face-to-face.
            </p>
          </div>

          {/* Status Badge */}
          {health && (
            <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 text-sm font-medium">
              <span className="relative flex h-2 w-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
                <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500" />
              </span>
              Systems still under Development 
            </div>
          )}
        </div>

        {/* Main Card */}
        <div className="relative group">
          {/* Card Glow Effect */}
          <div className="absolute -inset-1 bg-gradient-to-r from-primary/20 via-purple-500/20 to-primary/20 rounded-3xl blur-xl opacity-0 group-hover:opacity-100 transition-opacity duration-700" />

          <div className="relative bg-slate-900/50 backdrop-blur-2xl border border-white/10 rounded-3xl p-8 shadow-2xl shadow-black/50">
            {/* Create Room Section */}
            <div className="space-y-5">
              <div className="flex items-center gap-3 text-slate-300">
                <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center">
                  <Zap className="w-4 h-4 text-primary" />
                </div>
                <h2 className="text-sm font-semibold uppercase tracking-wider">
                  Start a new call
                </h2>
              </div>

              <div className="space-y-4">
                <div className="relative">
                  <Input
                    placeholder="Your name (optional)"
                    value={hostName}
                    onChange={(e) => setHostName(e.target.value)}
                    className="h-14 bg-black/30 border-white/10 rounded-xl text-white placeholder:text-slate-500 focus:border-primary/50 focus:ring-primary/20 transition-all"
                  />
                  <div className="absolute right-4 top-1/2 -translate-y-1/2 text-xs text-slate-500">
                    Optional
                  </div>
                </div>

                <Button
                  size="lg"
                  className="w-full h-14 text-base font-semibold rounded-xl bg-gradient-to-r from-primary to-primary/80 hover:opacity-90 transition-all duration-300 shadow-lg shadow-primary/25 hover:shadow-primary/40 hover:scale-[1.02] active:scale-[0.98]"
                  onClick={handleCreateRoom}
                  disabled={createRoom.isPending}
                  onMouseEnter={() => setIsHovering(true)}
                  onMouseLeave={() => setIsHovering(false)}
                >
                  {createRoom.isPending ? (
                    <Loader2 className="w-5 h-5 mr-2 animate-spin" />
                  ) : (
                    <Video className={`w-5 h-5 mr-2 transition-transform duration-300 ${isHovering ? "scale-110" : ""}`} />
                  )}
                  Create Room
                </Button>
              </div>
            </div>

            {/* Divider */}
            <div className="relative my-8">
              <div className="absolute inset-0 flex items-center">
                <div className="w-full border-t border-white/10" />
              </div>
              <div className="relative flex justify-center">
                <span className="bg-slate-900/50 px-4 text-xs text-slate-500 uppercase tracking-widest">
                  Or
                </span>
              </div>
            </div>

            {/* Join Room Section */}
            <div className="space-y-5">
              <div className="flex items-center gap-3 text-slate-300">
                <div className="w-8 h-8 rounded-lg bg-purple-500/10 flex items-center justify-center">
                  <ArrowRight className="w-4 h-4 text-purple-400" />
                </div>
                <h2 className="text-sm font-semibold uppercase tracking-wider">
                  Join existing call
                </h2>
              </div>

              <form onSubmit={handleJoinRoom} className="flex gap-3">
                <div className="relative flex-1">
                  <Input
                    placeholder="Enter room code..."
                    value={roomCode}
                    onChange={(e) => setRoomCode(e.target.value)}
                    className="h-14 bg-black/30 border-white/10 rounded-xl text-white placeholder:text-slate-500 focus:border-purple-500/50 focus:ring-purple-500/20 transition-all uppercase tracking-wider font-mono"
                  />
                </div>
                <Button
                  type="submit"
                  className="h-14 px-6 rounded-xl bg-gradient-to-r from-purple-500 to-purple-600 hover:opacity-90 transition-all duration-300 shadow-lg shadow-purple-500/25 hover:shadow-purple-500/40 hover:scale-105 active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed"
                  disabled={!roomCode.trim()}
                >
                  <ArrowRight className="w-5 h-5" />
                </Button>
              </form>
            </div>
          </div>
        </div>

        {/* Footer Features */}
        <div className="mt-10 grid grid-cols-3 gap-4">
          {[
            { icon: Shield, label: "Secure", desc: "End-to-end encrypted" },
            { icon: Zap, label: "Fast", desc: "Low latency video" },
            { icon: Sparkles, label: "Simple", desc: "No signup required" },
          ].map((feature, i) => (
            <div key={i} className="text-center space-y-2 p-4 rounded-2xl bg-white/5 border border-white/5 hover:bg-white/10 transition-colors">
              <feature.icon className="w-5 h-5 text-slate-400 mx-auto" />
              <div className="text-xs font-medium text-slate-300">{feature.label}</div>
              <div className="text-[10px] text-slate-500">{feature.desc}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
