import type { Transfer } from "@/lib/types";

/**
 * Jeu de rendu pour /preview.
 *
 * Sert à regarder la carte dans ses cas limites sans dépendre de la base :
 * les trois niveaux de portrait, les quatre accents, les bornes de la jauge,
 * les libellés qui débordent et les lignes sans visuel. Ce sont les états qui
 * cassent une carte en production et qu'un feed nominal ne montre jamais.
 */
function mk(partial: Partial<Transfer> & Pick<Transfer, "external_id" | "player_name" | "type">): Transfer {
  const now = new Date().toISOString();
  return {
    id: partial.external_id,
    player_photo: null,
    player_cutout: null,
    nationality_code: null,
    from_club_name: null,
    from_club_logo: null,
    to_club_name: null,
    to_club_logo: null,
    transfer_fee: null,
    fee_value_eur: null,
    probability_score: null,
    previous_probability: null,
    status_badge: null,
    source: "Banc de rendu",
    source_url: null,
    is_published: true,
    published_at: now,
    created_at: now,
    updated_at: now,
    ...partial,
  } as Transfer;
}

export const PREVIEW_CASES: { title: string; note: string; transfer: Transfer }[] = [
  {
    title: "Niveau 1 — portrait détouré",
    note: "Rumeur chaude (≥ 70) : accent ambre, jauge néon, tendance à la hausse.",
    transfer: mk({
      external_id: "preview:cutout",
      player_name: "Rayan Cherki",
      type: "RUMOUR",
      nationality_code: "fr",
      player_cutout: "/demo/portrait-cutout.png",
      from_club_name: "Olympique Lyonnais",
      to_club_name: "Paris Saint-Germain",
      transfer_fee: "45 M€",
      probability_score: 78,
      previous_probability: 66,
      status_badge: "Piste chaude",
      source_url: "https://example.org",
    }),
  },
  {
    title: "Niveau 2 — masque circulaire",
    note: "Portrait source non détouré : cercle, ring, halo. Transfert officiel, accent émeraude, pas de jauge.",
    transfer: mk({
      external_id: "preview:photo",
      player_name: "Lucas Bergeron",
      type: "TRANSFER",
      nationality_code: "fr",
      player_photo: "/demo/portrait-photo.png",
      from_club_name: "Stade Rennais",
      to_club_name: "Arsenal",
      transfer_fee: "32 M€",
      status_badge: "Officialisé",
      source_url: "https://example.org",
    }),
  },
  {
    title: "Niveau 3 — silhouette",
    note: "Aucun visuel. Prolongation : club unique en en-tête, pas de flèche.",
    transfer: mk({
      external_id: "preview:silhouette",
      player_name: "Matteo Ferrara",
      type: "EXTENSION",
      nationality_code: "it",
      from_club_name: "Juventus",
      to_club_name: "Juventus",
      transfer_fee: "—",
      status_badge: "Jusqu'en 2029",
    }),
  },
  {
    title: "Rumeur tiède",
    note: "Sous 70 : l'accent retombe en gris. La température du feed se lit sans lire un mot.",
    transfer: mk({
      external_id: "preview:cold",
      player_name: "Lars van Dijk",
      type: "RUMOUR",
      nationality_code: "nl",
      from_club_name: "PSV Eindhoven",
      to_club_name: "Newcastle",
      transfer_fee: "37 M€",
      probability_score: 12,
      previous_probability: 26,
      status_badge: "Piste refroidie",
    }),
  },
  {
    title: "Débordement de texte",
    note: "Nom long, clubs longs, libellé long : tout doit tronquer sans casser la grille.",
    transfer: mk({
      external_id: "preview:overflow",
      player_name: "Alessandro Bartolomeo Villanueva-Sørensen",
      type: "RUMOUR",
      nationality_code: "ar",
      from_club_name: "Borussia Mönchengladbach",
      to_club_name: "Wolverhampton Wanderers",
      transfer_fee: "Prêt avec option d'achat",
      probability_score: 71,
      previous_probability: 70,
      status_badge: "Discussions avancées",
    }),
  },
  {
    title: "Bornes de la jauge",
    note: "0 % : la barre doit rester lisible à vide. Écusson absent des deux côtés.",
    transfer: mk({
      external_id: "preview:zero",
      player_name: "Thomas Aubert",
      type: "RUMOUR",
      nationality_code: "fr",
      from_club_name: "AS Monaco",
      to_club_name: "Manchester United",
      transfer_fee: "Libre",
      probability_score: 0,
      previous_probability: 18,
      status_badge: "Démenti du club",
    }),
  },
  {
    title: "Jauge pleine",
    note: "100 % avec halo néon en bout de barre.",
    transfer: mk({
      external_id: "preview:full",
      player_name: "Gabriel Nogueira",
      type: "RUMOUR",
      nationality_code: "br",
      player_cutout: "/demo/portrait-cutout.png",
      from_club_name: "Flamengo",
      to_club_name: "Liverpool",
      transfer_fee: "64 M€",
      probability_score: 100,
      previous_probability: 88,
      status_badge: "Visite médicale",
      source_url: "https://example.org",
    }),
  },
  {
    title: "Ligne minimale",
    note: "Que le nom et le type. Tout le reste est nul : la carte doit rester intentionnelle.",
    transfer: mk({
      external_id: "preview:minimal",
      player_name: "Joueur inconnu",
      type: "TRANSFER",
    }),
  },
];
