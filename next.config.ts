import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Self-contained build in .next/standalone for the cPanel Node.js host.
  output: "standalone",
  // The build is made on Windows; skipping the image optimizer avoids
  // needing sharp's Linux binaries on the server. Only small local logos use next/image.
  images: { unoptimized: true },
  // Attachments (e.g. proof of payment) are uploaded through server actions;
  // the default 1 MB is too small for phone photos. Vercel caps requests at 4.5 MB.
  experimental: { serverActions: { bodySizeLimit: "5mb" } },
};

export default nextConfig;
