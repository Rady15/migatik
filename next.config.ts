import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  /* config options here */
  typescript: {
    ignoreBuildErrors: true,
  },
  reactStrictMode: false,
  allowedDevOrigins: ["192.168.1.20", "localhost", "100.119.187.124", "desktop-hrmk429.tail9145c9.ts.net"],
};

export default nextConfig;
