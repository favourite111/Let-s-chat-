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
    <div className="min-h-screen w-full flex flex-col items-center justify-center p-4">
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top,_var(--tw-gradient-stops))] from-primary/10 via-background to-background -z-10" />

      <div className="w-full max-w-md space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-700">
        <div className="text-center space-y-2">
          <div className="mx-auto w-16 h-16 bg-primary/10 rounded-2xl flex items-center justify-center mb-6 border border-primary/20 shadow-[0_0_40px_rgba(100,100,250,0.15)]">
            <Video className="w-8 h-8 text-primary" />
          </div>
          <h1 className="text-4xl font-bold tracking-tight">VideoCall</h1>
          <p className="text-muted-foreground text-lg">
            Connect instantly, face-to-face.
          </p>
          {health && (
            <div className="flex items-center justify-center gap-2 mt-4 text-xs text-muted-foreground/50">
              <span className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
              Systems Operational
            </div>
          )}
        </div>

        <div className="bg-card border shadow-xl rounded-2xl p-6 space-y-8">
          <div className="space-y-4">
            <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wider">
              Start a new call
            </h2>
            <div className="space-y-3">
              <Input
                placeholder="Your name (optional)"
                value={hostName}
                onChange={(e) => setHostName(e.target.value)}
                className="h-12 bg-background"
              />
              <Button
                size="lg"
                className="w-full h-12 text-md font-medium"
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

          <div className="relative">
            <div className="absolute inset-0 flex items-center">
              <span className="w-full border-t" />
            </div>
            <div className="relative flex justify-center text-xs uppercase">
              <span className="bg-card px-2 text-muted-foreground">Or</span>
            </div>
          </div>

          <div className="space-y-4">
            <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wider">
              Join existing call
            </h2>
            <form onSubmit={handleJoinRoom} className="flex gap-2">
              <Input
                placeholder="Paste room code..."
                value={roomCode}
                onChange={(e) => setRoomCode(e.target.value)}
                className="h-12 bg-background flex-1"
              />
              <Button
                type="submit"
                size="icon"
                className="h-12 w-12 shrink-0"
                disabled={!roomCode.trim()}
              >
                <ArrowRight className="w-5 h-5" />
              </Button>
            </form>
          </div>
        </div>
      </div>
    </div>
  );
}
