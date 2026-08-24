import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/types";

/**
 * Client de lecture pour les Server Components.
 * Clé anon : RLS s'applique, donc seules les lignes `is_published` remontent.
 */
export function createServerClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !key) {
    throw new Error(
      "NEXT_PUBLIC_SUPABASE_URL et NEXT_PUBLIC_SUPABASE_ANON_KEY sont requis. Voir .env.example.",
    );
  }

  return createClient<Database>(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
