import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Self-contained build in .next/standalone for the cPanel Node.js host.
  output: "standalone",
  // The build is made on Windows; skipping the image optimizer avoids
  // needing sharp's Linux binaries on the server. Only small local logos use next/image.
  images: { unoptimized: true },
};

export default nextConfig;
