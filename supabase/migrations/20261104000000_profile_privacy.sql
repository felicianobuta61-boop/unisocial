-- UniSocial profile privacy and follow approval.
-- Run this migration before deploying the matching profile-privacy.js.
-- Existing follows remain approved; existing profiles remain public by default.

begin;

alter table public.profiles
  add column if not exists is_private boolean not null default false;

update public.profiles
set is_private = false
where is_private is null;

alter table public.profiles
  alter column is_private set default false,
  alter column is_private set not null;

create table if not exists public.follow_requests (
  follower_id uuid not null references public.profiles(id) on delete cascade,
  following_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (follower_id, following_id),
  constraint follow_requests_not_self check (follower_id <> following_id)
);

alter table public.follow_requests enable row level security;
revoke all on table public.follow_requests from anon, authenticated;
grant select on table public.follow_requests to authenticated;

drop policy if exists follow_requests_read_participants on public.follow_requests;
create policy follow_requests_read_participants
  on public.follow_requests
  for select
  to authenticated
  using (follower_id = (select auth.uid()) or following_id = (select auth.uid()));

-- Return a discoverable card for private accounts without exposing their bio,
-- avatar, notes, posts, or stories.
create or replace function public.search_profiles(
  p_search_text text default null,
  p_limit integer default 50
)
returns table (
  id uuid,
  username text,
  full_name text,
  avatar_url text,
  is_private boolean
)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select p.id,
         p.username,
         p.full_name,
         case when p.is_private then null else p.avatar_url end,
         p.is_private
  from public.profiles as p
  where auth.uid() is not null
    and p.id <> auth.uid()
    and (
      p_search_text is null
      or p_search_text = ''
      or p.username ilike '%' || p_search_text || '%'
      or p.full_name ilike '%' || p_search_text || '%'
    )
  order by p.username
  limit least(greatest(coalesce(p_limit, 50), 1), 50);
$$;

create or replace function public.request_follow(target_profile_id uuid)
returns text
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  current_user_id uuid := auth.uid();
  target_is_private boolean;
begin
  if current_user_id is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;
  if target_profile_id = current_user_id then
    raise exception 'Cannot follow your own profile' using errcode = '22023';
  end if;

  select p.is_private
    into target_is_private
    from public.profiles as p
   where p.id = target_profile_id;
  if not found then
    raise exception 'Profile not found' using errcode = 'P0002';
  end if;

  if exists (
    select 1 from public.follows as f
    where f.follower_id = current_user_id
      and f.following_id = target_profile_id
  ) then
    return 'following';
  end if;

  if target_is_private then
    insert into public.follow_requests (follower_id, following_id)
    values (current_user_id, target_profile_id)
    on conflict do nothing;
    return 'pending';
  end if;

  insert into public.follows (follower_id, following_id)
  select current_user_id, target_profile_id
  where not exists (
    select 1 from public.follows as f
    where f.follower_id = current_user_id
      and f.following_id = target_profile_id
  )
  on conflict do nothing;
  return 'following';
end;
$$;

create or replace function public.cancel_follow_request(target_profile_id uuid)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if auth.uid() is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;
  delete from public.follow_requests
   where follower_id = auth.uid()
     and following_id = target_profile_id;
  return found;
end;
$$;

create or replace function public.approve_follow_request(requester_id uuid)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if auth.uid() is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;
  delete from public.follow_requests
   where follower_id = requester_id
     and following_id = auth.uid();
  if not found then
    return false;
  end if;

  insert into public.follows (follower_id, following_id)
  select requester_id, auth.uid()
  where not exists (
    select 1 from public.follows as f
    where f.follower_id = requester_id
      and f.following_id = auth.uid()
  )
  on conflict do nothing;
  return true;
end;
$$;

create or replace function public.decline_follow_request(requester_id uuid)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if auth.uid() is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;
  delete from public.follow_requests
   where follower_id = requester_id
     and following_id = auth.uid();
  return found;
end;
$$;

create or replace function public.list_follow_requests()
returns table (
  requester_id uuid,
  username text,
  full_name text,
  created_at timestamptz
)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select r.follower_id, p.username, p.full_name, r.created_at
  from public.follow_requests as r
  join public.profiles as p on p.id = r.follower_id
  where auth.uid() is not null
    and r.following_id = auth.uid()
  order by r.created_at
  limit 100;
$$;

revoke all on function public.search_profiles(text, integer) from public, anon;
revoke all on function public.request_follow(uuid) from public, anon;
revoke all on function public.cancel_follow_request(uuid) from public, anon;
revoke all on function public.approve_follow_request(uuid) from public, anon;
revoke all on function public.decline_follow_request(uuid) from public, anon;
revoke all on function public.list_follow_requests() from public, anon;
grant execute on function public.search_profiles(text, integer) to authenticated;
grant execute on function public.request_follow(uuid) to authenticated;
grant execute on function public.cancel_follow_request(uuid) to authenticated;
grant execute on function public.approve_follow_request(uuid) to authenticated;
grant execute on function public.decline_follow_request(uuid) to authenticated;
grant execute on function public.list_follow_requests() to authenticated;

-- If an owner makes a profile public, pending requests are no longer pending:
-- accept them as ordinary follows so the UI does not leave stale request badges.
create or replace function public.approve_pending_follows_when_public()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  insert into public.follows (follower_id, following_id)
  select r.follower_id, new.id
  from public.follow_requests as r
  where r.following_id = new.id
    and not exists (
      select 1 from public.follows as f
      where f.follower_id = r.follower_id
        and f.following_id = new.id
    )
  on conflict do nothing;

  delete from public.follow_requests
   where following_id = new.id;
  return new;
end;
$$;

revoke all on function public.approve_pending_follows_when_public() from public, anon, authenticated;

drop trigger if exists approve_pending_follows_when_public on public.profiles;
create trigger approve_pending_follows_when_public
  after update of is_private on public.profiles
  for each row
  when (old.is_private is true and new.is_private is false)
  execute function public.approve_pending_follows_when_public();

-- Existing PERMISSIVE policies using true combine with OR. These RESTRICTIVE
-- gates intersect with every existing SELECT policy without deleting the
-- current insert/update/delete policies.
drop policy if exists profiles_private_visibility_gate on public.profiles;
create policy profiles_private_visibility_gate
  on public.profiles
  as restrictive
  for select
  to public
  using (
    is_private is not true
    or id = (select auth.uid())
    or exists (
      select 1
      from public.follows as f
      where f.follower_id = (select auth.uid())
        and f.following_id = profiles.id
    )
  );

drop policy if exists follows_participant_visibility_gate on public.follows;
create policy follows_participant_visibility_gate
  on public.follows
  as restrictive
  for select
  to public
  using (
    (select auth.uid()) is not null
    and (
      follower_id = (select auth.uid())
      or following_id = (select auth.uid())
    )
  );

drop policy if exists follows_public_insert_gate on public.follows;
create policy follows_public_insert_gate
  on public.follows
  as restrictive
  for insert
  to authenticated
  with check (
    follower_id = (select auth.uid())
    and exists (
      select 1
      from public.profiles as p
      where p.id = follows.following_id
        and p.is_private is false
    )
  );

drop policy if exists posts_private_visibility_gate on public.posts;
create policy posts_private_visibility_gate
  on public.posts
  as restrictive
  for select
  to public
  using (
    exists (
      select 1
      from public.profiles as p
      where p.id = posts.author_id
        and (
          p.is_private is not true
          or p.id = (select auth.uid())
          or exists (
            select 1
            from public.follows as f
            where f.follower_id = (select auth.uid())
              and f.following_id = p.id
          )
        )
    )
  );

drop policy if exists stories_private_visibility_gate on public.stories;
create policy stories_private_visibility_gate
  on public.stories
  as restrictive
  for select
  to public
  using (
    author_id = (select auth.uid())
    or (
      expires_at > now()
      and exists (
        select 1
        from public.profiles as p
        where p.id = stories.author_id
      )
    )
  );

drop policy if exists comments_private_visibility_gate on public.comments;
create policy comments_private_visibility_gate
  on public.comments
  as restrictive
  for select
  to public
  using (
    exists (
      select 1
      from public.posts as p
      where p.id = comments.post_id
    )
  );

drop policy if exists comments_private_insert_gate on public.comments;
create policy comments_private_insert_gate
  on public.comments
  as restrictive
  for insert
  to authenticated
  with check (
    author_id = (select auth.uid())
    and exists (
      select 1
      from public.posts as p
      where p.id = comments.post_id
    )
  );

drop policy if exists likes_private_visibility_gate on public.likes;
create policy likes_private_visibility_gate
  on public.likes
  as restrictive
  for select
  to public
  using (
    exists (
      select 1
      from public.posts as p
      where p.id = likes.post_id
    )
  );

drop policy if exists likes_private_insert_gate on public.likes;
create policy likes_private_insert_gate
  on public.likes
  as restrictive
  for insert
  to authenticated
  with check (
    user_id = (select auth.uid())
    and exists (
      select 1
      from public.posts as p
      where p.id = likes.post_id
    )
  );

-- Private buckets prevent old /object/public/ URLs from bypassing table RLS.
-- The client converts stored legacy URLs to short-lived signed URLs.
do $$
begin
  if exists (
    select required.id
    from unnest(array['avatars', 'post-media', 'stories']) as required(id)
    where not exists (
      select 1 from storage.buckets as b where b.id = required.id
    )
  ) then
    raise exception 'Expected Storage buckets avatars, post-media and stories to exist';
  end if;
end;
$$;

update storage.buckets
set public = false
where id in ('avatars', 'post-media', 'stories');

drop policy if exists avatars_read on storage.objects;
drop policy if exists uni_profile_media_read on storage.objects;
drop policy if exists uni_profile_media_visibility_gate on storage.objects;

create policy uni_profile_media_read
  on storage.objects
  for select
  to public
  using (
    (bucket_id = 'avatars' and exists (
      select 1
      from public.profiles as p
      where split_part(p.avatar_url, '/storage/v1/object/public/avatars/', 2)
            = storage.objects.name
    ))
    or
    (bucket_id = 'post-media' and exists (
      select 1
      from public.posts as p
      where split_part(p.media_url, '/storage/v1/object/public/post-media/', 2)
            = storage.objects.name
    ))
    or
    (bucket_id = 'stories' and exists (
      select 1
      from public.stories as s
      where split_part(s.image_url, '/storage/v1/object/public/stories/', 2)
            = storage.objects.name
    ))
  );

create policy uni_profile_media_visibility_gate
  on storage.objects
  as restrictive
  for select
  to public
  using (
    case
      when bucket_id = 'avatars' then exists (
        select 1
        from public.profiles as p
        where split_part(p.avatar_url, '/storage/v1/object/public/avatars/', 2)
              = storage.objects.name
      )
      when bucket_id = 'post-media' then exists (
        select 1
        from public.posts as p
        where split_part(p.media_url, '/storage/v1/object/public/post-media/', 2)
              = storage.objects.name
      )
      when bucket_id = 'stories' then exists (
        select 1
        from public.stories as s
        where split_part(s.image_url, '/storage/v1/object/public/stories/', 2)
              = storage.objects.name
      )
      else true
    end
  );

commit;
