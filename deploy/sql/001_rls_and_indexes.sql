-- Canonical RLS + FK indexes (idempotent)

-- Covering indexes for FKs
create index if not exists idx_brand_kits_user_id on public.brand_kits (user_id);
create index if not exists idx_glossary_terms_user_id on public.glossary_terms (user_id);
create index if not exists idx_phrasebook_items_user_id on public.phrasebook_items (user_id);

-- PROFILES
alter table if exists public.profiles enable row level security;
drop policy if exists "profiles_select_own" on public.profiles;
create policy "profiles_select_own"
on public.profiles for select to authenticated
using ((select auth.uid()) = id);
drop policy if exists "profiles_update_own" on public.profiles;
create policy "profiles_update_own"
on public.profiles for update to authenticated
using ((select auth.uid()) = id)
with check ((select auth.uid()) = id);

-- BRAND KITS
alter table if exists public.brand_kits enable row level security;
drop policy if exists "brand_kits_select_own" on public.brand_kits;
create policy "brand_kits_select_own"
on public.brand_kits for select to authenticated
using ((select auth.uid()) = user_id);
drop policy if exists "brand_kits_crud_own" on public.brand_kits;
create policy "brand_kits_crud_own"
on public.brand_kits for all to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

-- GLOSSARY TERMS
alter table if exists public.glossary_terms enable row level security;
drop policy if exists "glossary_terms_select_own" on public.glossary_terms;
create policy "glossary_terms_select_own"
on public.glossary_terms for select to authenticated
using ((select auth.uid()) = user_id);
drop policy if exists "glossary_terms_crud_own" on public.glossary_terms;
create policy "glossary_terms_crud_own"
on public.glossary_terms for all to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

-- PHRASEBOOK ITEMS
alter table if exists public.phrasebook_items enable row level security;
drop policy if exists "phrasebook_items_select_own" on public.phrasebook_items;
create policy "phrasebook_items_select_own"
on public.phrasebook_items for select to authenticated
using ((select auth.uid()) = user_id);
drop policy if exists "phrasebook_items_crud_own" on public.phrasebook_items;
create policy "phrasebook_items_crud_own"
on public.phrasebook_items for all to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

-- USAGE MONTHLY (read-only)
alter table if exists public.usage_monthly enable row level security;
drop policy if exists "usage_monthly_select_own" on public.usage_monthly;
create policy "usage_monthly_select_own"
on public.usage_monthly for select to authenticated
using ((select auth.uid()) = user_id);


