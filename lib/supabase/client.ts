"use client";

import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/types";

let browserClient: ReturnType<typeof createClient<Database>> | null = null;

/**
 * Client navigateur, singleton.
 * Une seule instance par onglet : chaque `createClient` ouvre sa propre
 * connexion Realtime, et le plan gratuit plafonne à 200 connexions simultanées.
 */
export function getBrowserClient() {
  if (browserClient) return browserClient;

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !key) {
    throw new Error(
      "NEXT_PUBLIC_SUPABASE_URL et NEXT_PUBLIC_SUPABASE_ANON_KEY sont requis. Voir .env.example.",
    );
  }

  browserClient = createClient<Database>(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    realtime: { params: { eventsPerSecond: 5 } },
  });
  return browserClient;
}
