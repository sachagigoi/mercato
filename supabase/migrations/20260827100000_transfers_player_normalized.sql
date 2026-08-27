-- La colonne sur laquelle repose le rapprochement presse -> piste.
--
-- Une déclaration dit « Igor Paixão » ; la rumeur Transfermarkt dit peut-être
-- « Igor Paixao ». Sans forme de comparaison stockée, il faudrait chercher au
-- `ilike` sur le nom brut — insensible à la casse, mais PAS aux accents, ce
-- qui rate exactement les noms que ce produit manipule.
--
-- Colonne générée plutôt que colonne tenue à jour par le code : elle ne peut
-- pas diverger du nom, et l'index reste vrai après n'importe quelle écriture,
-- d'où qu'elle vienne.
--
-- `public.normalize_name` est déjà la clé de `media_cache`, et son équivalent
-- TypeScript est `normalizeName` (lib/format.ts). Leur accord a été vérifié
-- sur les cas qui comptent — accents, apostrophes, traits d'union, espaces
-- doublés — avant d'y adosser la jointure.
alter table public.transfers
  add column player_normalized text
  generated always as (public.normalize_name(player_name)) stored;

comment on column public.transfers.player_normalized is
  'Forme de rapprochement du nom. Miroir de normalizeName (lib/format.ts). Cible du rapprochement des déclarations.';

create index transfers_player_normalized_idx
  on public.transfers (player_normalized);
