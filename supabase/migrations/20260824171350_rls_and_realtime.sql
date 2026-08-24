alter table public.transfers   enable row level security;
alter table public.media_cache enable row level security;

-- Lecture publique des seules lignes publiées.
create policy "transfers_public_read"
  on public.transfers
  for select
  to anon, authenticated
  using (is_published);

-- Aucune policy d'écriture sur transfers : seul service_role écrit (il contourne RLS).
-- Aucune policy du tout sur media_cache : la table est invisible côté client. Volontaire.
-- (Le linter Supabase remonte un INFO rls_enabled_no_policy dessus : c'est le comportement voulu.)

-- Realtime.
-- replica identity full est obligatoire : sans elle, le payload UPDATE ne porte que
-- la clé primaire dans old_record, et l'animation de variation de jauge n'a rien à comparer.
alter table public.transfers replica identity full;
alter publication supabase_realtime add table public.transfers;
