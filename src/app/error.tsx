"use client";

import { useEffect } from "react";
import Image from "next/image";
import { AlertTriangle, RotateCw } from "lucide-react";

export default function Error({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  useEffect(() => {
    console.error("[app] unhandled error:", error);
  }, [error]);

  return (
    <div className="flex min-h-screen w-full flex-col items-center justify-center gap-5 bg-background px-6 text-center">
      <div className="relative flex h-16 w-52 items-center justify-center overflow-hidden opacity-90">
        <Image src="/logo.png" alt="Chatit Logo" fill sizes="208px" className="object-contain" />
      </div>
      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-red-500/10">
        <AlertTriangle className="h-6 w-6 text-red-400" />
      </div>
      <h1 className="text-xl font-semibold tracking-tight text-white">
        Something went wrong
      </h1>
      <p className="max-w-sm text-sm text-gray-400">
        Chatit hit an unexpected error. Your conversation wasn&apos;t lost — try again, and if this keeps happening, start a new chat.
      </p>
      <button
        onClick={retry}
        type="button"
        className="mt-2 flex items-center gap-2 rounded-full bg-[#819c70] px-6 py-2.5 text-sm font-semibold text-black shadow-lg transition-all hover:bg-[#6e8560] active:scale-[0.97]"
      >
        <RotateCw className="h-4 w-4" />
        Try again
      </button>
    </div>
  );
}
