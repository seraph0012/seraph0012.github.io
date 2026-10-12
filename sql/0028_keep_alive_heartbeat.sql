-- keep-alive心跳：给GitHub Actions的定时ping提供一个"真实写入"的目标。
-- 背景：原来的keep-alive只是匿名GET一次connection_test（只读），2026-09实测每3天一次全部成功，
-- 但Supabase仍然发了"7天无足够活动"的暂停警告——只读ping不足以被算作活动。
-- 改成每天调用一次keep_alive_ping()，真正UPDATE一行数据。

create table if not exists keep_alive_heartbeat (
  id int primary key default 1 check (id = 1),
  last_ping_at timestamptz not null default now(),
  ping_count bigint not null default 0
);

-- 开RLS且不建任何policy：匿名/登录用户都不能直接读写这张表，只能通过下面的函数。
alter table keep_alive_heartbeat enable row level security;

insert into keep_alive_heartbeat (id) values (1) on conflict (id) do nothing;

create or replace function keep_alive_ping()
returns timestamptz
language sql
security definer
set search_path = public
as $$
  update keep_alive_heartbeat
     set last_ping_at = now(),
         ping_count = ping_count + 1
   where id = 1
  returning last_ping_at;
$$;

revoke all on function keep_alive_ping() from public;
grant execute on function keep_alive_ping() to anon, authenticated;
