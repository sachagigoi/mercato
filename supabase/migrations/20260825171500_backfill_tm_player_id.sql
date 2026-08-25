-- Rattrapage de `tm_player_id` sur les rumeurs déjà en base.
--
-- Le scraper ne voit que la page courante : sans ce rattrapage, les rumeurs
-- moissonnées avant la migration précédente n'auraient jamais d'identifiant
-- joueur, donc jamais de valeur de marché — le feed afficherait des montants
-- sur ses quinze lignes les plus fraîches et rien sur les soixante autres.
--
-- L'identifiant n'a pas besoin d'être retrouvé : il est déjà dans la clé
-- naturelle, `tm:rumour:{tm_player_id}:{tm_to_club_id}`. Le garde sur la forme
-- numérique écarte les lignes où le scraper avait replié sur un slug de nom,
-- faute d'identifiant lisible — les envoyer à la résolution ferait autant de
-- requêtes vers des fiches inexistantes.
--
-- Le pays, lui, ne se rattrape pas : il n'est pas dans la clé, et il faudrait
-- retrouver chaque rumeur dans une page qui ne les liste plus. Ces lignes
-- resteront donc hors des puces de pays jusqu'à leur sortie du feed.
update public.transfers
   set tm_player_id = split_part(external_id, ':', 3)
 where tm_player_id is null
   and external_id like 'tm:rumour:%'
   and split_part(external_id, ':', 3) ~ '^\d+$';
