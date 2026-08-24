import "server-only";

import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/types";

/**
 * Client d'écriture. Utilise la clé service_role, qui CONTOURNE RLS :
 * elle donne un accès en écriture totale à la base.
 *
 * L'import "server-only" ci-dessus fait échouer le build si ce module se
 * retrouve dans un bundle client. C'est volontaire : mieux vaut une erreur de
 * compilation qu'une clé d'administration servie au navigateur.
 *
 * Seul lib/ingest.ts doit l'utiliser (Phase 3).
 */
export function createAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    throw new Error(
      "NEXT_PUBLIC_SUPABASE_URL et SUPABASE_SERVICE_ROLE_KEY sont requis côté serveur. Voir .env.example.",
    );
  }

  return createClient<Database>(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
