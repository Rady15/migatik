import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  /* config options here */
  typescript: {
    ignoreBuildErrors: true,
  },
  reactStrictMode: false,
  allowedDevOrigins: ["192.168.1.20", "localhost"],
  webpackDevMiddleware: (config) => {
    config.allowedHosts = "all";
    return config;
  },
};

export default nextConfig;
