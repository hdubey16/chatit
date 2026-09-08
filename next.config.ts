import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  devIndicators: false,
  serverExternalPackages: [
    "pdf-oxide",
    "tesseract.js",
    "mammoth",
    "mongodb",
    "@langchain/core",
    "@langchain/textsplitters",
  ],
};

export default nextConfig;
