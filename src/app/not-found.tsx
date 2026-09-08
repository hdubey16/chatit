import Image from "next/image";
import Link from "next/link";

export default function NotFound() {
  return (
    <div className="flex min-h-screen w-full flex-col items-center justify-center gap-5 bg-background px-6 text-center">
      <div className="relative flex h-16 w-52 items-center justify-center overflow-hidden opacity-90">
        <Image src="/logo.png" alt="Chatit Logo" fill sizes="208px" className="object-contain" />
      </div>
      <h1 className="text-xl font-semibold tracking-tight text-white">
        Page not found
      </h1>
      <p className="max-w-sm text-sm text-gray-400">
        The page you&apos;re looking for doesn&apos;t exist.
      </p>
      <Link
        href="/"
        className="mt-2 rounded-full bg-[#819c70] px-6 py-2.5 text-sm font-semibold text-black shadow-lg transition-all hover:bg-[#6e8560] active:scale-[0.97]"
      >
        Back to Chatit
      </Link>
    </div>
  );
}
