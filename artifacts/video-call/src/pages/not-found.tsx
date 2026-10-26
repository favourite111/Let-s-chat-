import { Link } from "wouter";
import { AlertCircle } from "lucide-react";

export default function NotFound() {
  return (
    <div className="min-h-screen w-full flex items-center justify-center bg-[#0a0a0f] px-4">
      <div className="w-full max-w-md rounded-3xl border border-[#2a2a40] bg-[#13131f]/80 p-8 text-center backdrop-blur-xl">
        <div className="mx-auto mb-5 flex h-14 w-14 items-center justify-center rounded-2xl bg-red-500/10">
          <AlertCircle className="h-7 w-7 text-red-400" aria-hidden="true" />
        </div>
        <h1 className="text-2xl font-bold text-white">Page not found</h1>
        <p className="mt-2 text-sm text-[#8888a0]">
          That link doesn&apos;t exist. It may have expired, or the room code was mistyped.
        </p>
        <Link
          href="/"
          className="mt-6 inline-flex h-11 items-center justify-center rounded-xl bg-gradient-to-r from-[#7c5cfc] to-[#6a4cfc] px-5 text-sm font-semibold text-white transition hover:from-[#8b6dff] hover:to-[#7c5cfc]"
        >
          Back to home
        </Link>
      </div>
    </div>
  );
}
