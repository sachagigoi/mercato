import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  images: {
    remotePatterns: [
      // Logos de clubs et portraits API-Football
      { protocol: "https", hostname: "media.api-sports.io" },
      // Portraits Transfermarkt
      { protocol: "https", hostname: "tmssl.akamaized.net" },
      { protocol: "https", hostname: "img.a.transfermarkt.technology" },
      // Portraits détourés produits par le worker (§6)
      { protocol: "https", hostname: "jfqtgphbpogfvofgtnax.supabase.co", pathname: "/storage/v1/object/public/**" },
    ],
  },
};

export default nextConfig;
