-- Base de dados do Destrave. Cole tudo no Supabase: SQL Editor > New query > Run.
-- Pode rodar de novo sem problema: o script recria as regras.

-- 1) Documentos do app: progresso de cada pessoa (testers/<id>) e chamados de suporte (suporte/<id>).
create table if not exists public.docs (
  caminho       text primary key,
  dono          uuid not null default auth.uid() references auth.users (id) on delete cascade,
  dados         jsonb not null,
  atualizado_em timestamptz not null default now()
);
alter table public.docs enable row level security;

-- Cada pessoa só lê, cria, altera e apaga os próprios documentos, e só nos dois caminhos que o app usa.
drop policy if exists "docs: ler os proprios" on public.docs;
drop policy if exists "docs: criar os proprios" on public.docs;
drop policy if exists "docs: alterar os proprios" on public.docs;
drop policy if exists "docs: apagar os proprios" on public.docs;
create policy "docs: ler os proprios" on public.docs for select to authenticated
  using (dono = auth.uid());
create policy "docs: criar os proprios" on public.docs for insert to authenticated
  with check (dono = auth.uid() and caminho in ('testers/' || auth.uid()::text, 'suporte/' || auth.uid()::text));
create policy "docs: alterar os proprios" on public.docs for update to authenticated
  using (dono = auth.uid())
  with check (dono = auth.uid() and caminho in ('testers/' || auth.uid()::text, 'suporte/' || auth.uid()::text));
create policy "docs: apagar os proprios" on public.docs for delete to authenticated
  using (dono = auth.uid());

-- 2) Contador de uso da IA por pessoa e por dia (fuso de São Paulo). Ninguém acessa a tabela direto.
create table if not exists public.uso_ia (
  usuario  uuid not null references auth.users (id) on delete cascade,
  dia      date not null,
  chamadas int  not null default 0,
  primary key (usuario, dia)
);
alter table public.uso_ia enable row level security;

-- O servidor chama esta função com a sessão da pessoa: ela soma 1 e devolve quantas chamadas a pessoa fez hoje.
create or replace function public.usar_ia() returns int
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  if auth.uid() is null then
    raise exception 'sem sessão' using errcode = '28000';
  end if;
  insert into public.uso_ia (usuario, dia, chamadas)
  values (auth.uid(), (now() at time zone 'America/Sao_Paulo')::date, 1)
  on conflict (usuario, dia) do update set chamadas = public.uso_ia.chamadas + 1
  returning chamadas into n;
  return n;
end $$;
revoke all on function public.usar_ia() from public;
revoke all on function public.usar_ia() from anon;
grant execute on function public.usar_ia() to authenticated;

-- =====================================================================
-- 3) PAGAMENTO (Mercado Pago). Pode rodar de novo sem problema.
-- =====================================================================

-- Pedidos de compra. A pessoa só LÊ os próprios pedidos; quem cria e altera é o servidor
-- (com a chave service_role, que fica só na Vercel). Assim ninguém se marca como "pago" sozinho.
-- Se a conta for apagada, o pedido fica guardado (registro fiscal), só perde o vínculo.
create table if not exists public.pedidos (
  id            uuid primary key default gen_random_uuid(),
  usuario       uuid references auth.users (id) on delete set null,
  status        text not null default 'criado'
                check (status in ('criado', 'pendente', 'pago', 'recusado', 'estornado')),
  valor         numeric(10, 2) not null check (valor > 0),
  email         text,
  mp_preferencia text,
  mp_link       text,
  mp_pagamento  text,
  metodo        text,
  criado_em     timestamptz not null default now(),
  atualizado_em timestamptz not null default now(),
  pago_em       timestamptz
);
create index if not exists pedidos_usuario on public.pedidos (usuario, criado_em desc);
create unique index if not exists pedidos_mp_pagamento on public.pedidos (mp_pagamento) where mp_pagamento is not null;
alter table public.pedidos enable row level security;
drop policy if exists "pedidos: ler os proprios" on public.pedidos;
create policy "pedidos: ler os proprios" on public.pedidos for select to authenticated
  using (usuario = auth.uid());
revoke insert, update, delete on public.pedidos from anon, authenticated;

-- Quantas vezes cada pessoa pediu um plano à IA (para limitar o custo antes do pagamento).
create table if not exists public.geracoes (
  usuario uuid primary key references auth.users (id) on delete cascade,
  total   int not null default 0
);
alter table public.geracoes enable row level security;

-- O servidor chama com a sessão da pessoa, a cada uso da IA.
-- p_tipo = 'plano' (gerar ou corrigir o plano) ou 'chat' (suporte).
-- Devolve: chamadas de hoje, total de pedidos de plano e se a pessoa já pagou.
create or replace function public.registrar_uso(p_tipo text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  uid uuid := auth.uid();
  hoje int;
  g int := 0;
  pago boolean;
begin
  if uid is null then
    raise exception 'sem sessão' using errcode = '28000';
  end if;
  insert into public.uso_ia (usuario, dia, chamadas)
  values (uid, (now() at time zone 'America/Sao_Paulo')::date, 1)
  on conflict (usuario, dia) do update set chamadas = public.uso_ia.chamadas + 1
  returning chamadas into hoje;
  if p_tipo = 'plano' then
    insert into public.geracoes (usuario, total) values (uid, 1)
    on conflict (usuario) do update set total = public.geracoes.total + 1
    returning total into g;
  else
    select coalesce((select total from public.geracoes where usuario = uid), 0) into g;
  end if;
  select exists (select 1 from public.pedidos where usuario = uid and status = 'pago') into pago;
  return jsonb_build_object('hoje', hoje, 'geracoes', g, 'pago', pago);
end $$;
revoke all on function public.registrar_uso(text) from public;
revoke all on function public.registrar_uso(text) from anon;
grant execute on function public.registrar_uso(text) to authenticated;
