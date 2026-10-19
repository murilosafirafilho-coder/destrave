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
