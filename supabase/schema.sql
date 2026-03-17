-- ═══════════════════════════════════════════════
-- GEM N EYE — Supabase Schema
-- Run this in: Supabase Dashboard → SQL Editor
-- ═══════════════════════════════════════════════

-- 1. User profiles table (extends Supabase auth.users)
create table if not exists public.profiles (
  id            uuid primary key references auth.users(id) on delete cascade,
  email         text,
  credits       integer not null default 5,      -- everyone starts with 5 free spins
  bp_unlocked   boolean not null default false,  -- full blueprint ($19) purchased
  created_at    timestamptz default now(),
  updated_at    timestamptz default now()
);

-- 2. Auto-create a profile row when a new user signs up
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer as $$
begin
  insert into public.profiles (id, email)
  values (new.id, new.email);
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- 3. Row Level Security — users can only read/update their own row
alter table public.profiles enable row level security;

create policy "Users can read own profile"
  on public.profiles for select
  using (auth.uid() = id);

create policy "Users can update own profile"
  on public.profiles for update
  using (auth.uid() = id);

-- Service role (used by Vercel API) bypasses RLS — no extra policy needed.

-- 4. Optional: spin history log
create table if not exists public.spins (
  id         bigserial primary key,
  user_id    uuid references public.profiles(id) on delete cascade,
  tools      text[],        -- e.g. ['NotebookLM', 'Veo 3', 'Stitch']
  role       text,
  niche      text,
  created_at timestamptz default now()
);

alter table public.spins enable row level security;

create policy "Users can read own spins"
  on public.spins for select
  using (auth.uid() = user_id);

-- 5. Pending grants — for users who pay before creating an account
create table if not exists public.pending_grants (
  email        text primary key,
  amount_cents integer not null,
  applied      boolean default false,
  created_at   timestamptz default now()
);
-- No RLS needed — only service role touches this table

-- 6. Auto-apply pending grant when a new user signs up
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer as $$
declare
  pending record;
begin
  -- Create profile with default 5 credits
  insert into public.profiles (id, email)
  values (new.id, new.email);

  -- Check for a pending grant (paid before signing up)
  select * into pending from public.pending_grants
    where lower(email) = lower(new.email) and applied = false
    limit 1;

  if found then
    if pending.amount_cents = 900 then
      update public.profiles set credits = credits + 50 where id = new.id;
    elsif pending.amount_cents = 1900 then
      update public.profiles set bp_unlocked = true where id = new.id;
    end if;
    update public.pending_grants set applied = true where email = pending.email;
  end if;

  return new;
end;
$$;
