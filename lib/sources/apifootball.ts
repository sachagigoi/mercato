import { z } from "zod";

// Pas de `import "server-only"` ici, volontairement : ce module ne lit aucun
// secret — createApiFootballHttp() reçoit la clé de son appelant. C'est le même
// choix que lib/ingest.ts, et c'est ce qui permet de le tester directement.
// La lecture de API_FOOTBALL_KEY, elle, n'a lieu que dans le Route Handler.

const BASE_URL = "https://v3.football.api-sports.io";

export type ApiFootballHit = { af_id: number; image_url: string };

/**
 * Accès HTTP, injecté.
 *
 * Isole `resolveMedia()` du vrai réseau : les tests passent un double qui
 * rejoue des réponses enregistrées, sans jamais appeler api-sports.io.
 */
export interface ApiFootballHttp {
  get(path: string): Promise<unknown>;
}

export function createApiFootballHttp(apiKey: string): ApiFootballHttp {
  return {
    async get(path) {
      const res = await fetch(`${BASE_URL}${path}`, {
        headers: { "x-apisports-key": apiKey },
      });
      if (!res.ok) throw new Error(`API-Football ${path} : HTTP ${res.status}`);
      return res.json();
    },
  };
}

// Schémas volontairement permissifs : on ne valide que les champs qu'on lit.
// API-Football est un tiers — une réponse inattendue doit produire un "pas
// trouvé", jamais une exception qui interrompt tout le lot.
const TeamsResponse = z.object({
  response: z.array(
    z.object({ team: z.object({ id: z.number(), logo: z.string().nullish() }) }),
  ),
});

const PlayersResponse = z.object({
  response: z.array(
    z.object({ player: z.object({ id: z.number(), photo: z.string().nullish() }) }),
  ),
});

/** Cherche un club par nom. `null` si absent ou si la réponse est inexploitable. */
export async function searchClub(http: ApiFootballHttp, name: string): Promise<ApiFootballHit | null> {
  const parsed = TeamsResponse.safeParse(await http.get(`/teams?search=${encodeURIComponent(name)}`));
  const hit = parsed.success ? parsed.data.response[0]?.team : undefined;
  return hit?.logo ? { af_id: hit.id, image_url: hit.logo } : null;
}

/**
 * Cherche un joueur par nom, via `/players/profiles` — le seul endpoint qui
 * accepte une recherche par nom seul, sans exiger saison ni club. C'est celui
 * qui donne le portrait pour le détourage (§6 des specs).
 */
export async function searchPlayer(http: ApiFootballHttp, name: string): Promise<ApiFootballHit | null> {
  const parsed = PlayersResponse.safeParse(
    await http.get(`/players/profiles?search=${encodeURIComponent(name)}`),
  );
  const hit = parsed.success ? parsed.data.response[0]?.player : undefined;
  return hit?.photo ? { af_id: hit.id, image_url: hit.photo } : null;
}
