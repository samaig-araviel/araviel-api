import type { NextConfig } from "next";

const allowedOrigin =
  process.env.NODE_ENV === "development"
    ? "http://localhost:5173"
    : "https://araviel-web.vercel.app";

const allowedHeaders = [
  "Content-Type",
  "X-User-Id",
  "X-Request-Id",
].join(", ");

const allowedMethods = ["GET", "POST", "PATCH", "DELETE", "OPTIONS"].join(", ");

const nextConfig: NextConfig = {
  async headers() {
    return [
      {
        source: "/api/:path*",
        headers: [
          { key: "Access-Control-Allow-Origin", value: allowedOrigin },
          { key: "Access-Control-Allow-Methods", value: allowedMethods },
          { key: "Access-Control-Allow-Headers", value: allowedHeaders },
          { key: "Access-Control-Allow-Credentials", value: "true" },
          { key: "Access-Control-Max-Age", value: "86400" },
          { key: "Vary", value: "Origin" },
        ],
      },
    ];
  },
};

export default nextConfig;