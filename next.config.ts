import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Keep native/wasm DB drivers out of the server bundle.
  serverExternalPackages: ["@electric-sql/pglite", "postgres"],
};

export default nextConfig;
