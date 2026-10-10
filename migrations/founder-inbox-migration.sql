-- Founder inbox (Founder -> Inbox). Applied to the live project.
--
-- Mail to any @voxprints.com address is received by Resend (the domain's MX points at Resend).
-- Resend only keeps received mail for a limited time, so a cron job copies new mail into
-- founder_mail every 2 minutes. Sent mail is stored here when it's sent from the inbox.
-- Reading mail needs a FULL-ACCESS Resend key (private_config.resend_inbox_api_key); the
-- existing resend_api_key is sending-only and keeps being used for order emails.
-- Everything goes through founder-only functions; the table itself has no client access.

create table if not exists public.founder_mail (
  id text primary key,                         -- Resend email id
  box text not null check (box in ('inbox', 'sent')),
  from_addr text not null default '',
  to_addrs jsonb not null default '[]'::jsonb,
  cc_addrs jsonb not null default '[]'::jsonb,
  reply_to jsonb not null default '[]'::jsonb,
  subject text not null default '',
  text_body text,
  html_body text,
  message_id text,
  references_hdr text,
  attachments jsonb not null default '[]'::jsonb,  -- [{id, filename, content_type, size}]
  created_at timestamptz not null default now(),
  read_at timestamptz,
  archived boolean not null default false
);
alter table public.founder_mail enable row level security;
revoke all on table public.founder_mail from anon, authenticated;
create index if not exists founder_mail_box_idx on public.founder_mail (box, archived, created_at desc);

-- Resend call with the full-access inbox key. Internal only.
create or replace function public.resend_mail_api(p_method text, p_path text, p_body jsonb default null, p_timeout_ms int default 15000)
returns jsonb language plpgsql security definer set search_path to 'public', 'extensions' as $$
declare api_key text; res extensions.http_response;
begin
  select value into api_key from public.private_config where key = 'resend_inbox_api_key';
  if api_key is null or api_key = '' then return jsonb_build_object('status', 0, 'error', 'no inbox key saved'); end if;
  perform extensions.http_set_curlopt('CURLOPT_TIMEOUT_MS', p_timeout_ms::text);
  select * into res from extensions.http((
    p_method, 'https://api.resend.com' || p_path,
    array[extensions.http_header('Authorization', 'Bearer ' || api_key)],
    'application/json', case when p_body is null then null else p_body::text end
  )::extensions.http_request);
  return jsonb_build_object('status', res.status, 'body',
    case when res.content is null or res.content = '' then '{}'::jsonb else res.content::jsonb end);
exception when others then
  return jsonb_build_object('status', 0, 'error', sqlerrm);
end $$;
revoke all on function public.resend_mail_api(text, text, jsonb, int) from public, anon, authenticated;

-- Copy any received mail we don't have yet. Run by cron and by the inbox's Refresh button.
create or replace function public.founder_mail_sync() returns jsonb
language plpgsql security definer set search_path to 'public' as $$
declare lst jsonb; item jsonb; det jsonb; added int := 0; e jsonb;
begin
  lst := public.resend_mail_api('GET', '/emails/receiving?limit=50');
  if (lst->>'status')::int is distinct from 200 then
    return jsonb_build_object('ok', false, 'error', coalesce(lst->'body'->>'message', lst->>'error', 'Resend returned ' || (lst->>'status')));
  end if;
  for item in select * from jsonb_array_elements(coalesce(lst->'body'->'data', '[]'::jsonb)) loop
    continue when exists (select 1 from public.founder_mail where id = item->>'id');
    det := public.resend_mail_api('GET', '/emails/receiving/' || (item->>'id'));
    e := case when (det->>'status')::int = 200 then det->'body' else item end;
    insert into public.founder_mail (id, box, from_addr, to_addrs, cc_addrs, reply_to, subject, text_body, html_body, message_id, references_hdr, attachments, created_at)
    values (
      item->>'id', 'inbox',
      coalesce(e->>'from', item->>'from', ''),
      case when jsonb_typeof(e->'to') = 'array' then e->'to' else '[]'::jsonb end,
      case when jsonb_typeof(e->'cc') = 'array' then e->'cc' else '[]'::jsonb end,
      case when jsonb_typeof(e->'reply_to') = 'array' then e->'reply_to' else '[]'::jsonb end,
      left(coalesce(e->>'subject', item->>'subject', ''), 1000),
      e->>'text', e->>'html',
      coalesce(e->>'message_id', item->>'message_id'),
      coalesce(e->'headers'->>'references', e->'headers'->>'References'),
      coalesce((select jsonb_agg(jsonb_build_object('id', a->>'id', 'filename', a->>'filename', 'content_type', a->>'content_type', 'size', a->'size'))
                from jsonb_array_elements(case when jsonb_typeof(e->'attachments') = 'array' then e->'attachments' else '[]'::jsonb end) a), '[]'::jsonb),
      coalesce((e->>'created_at')::timestamptz, now())
    ) on conflict (id) do nothing;
    added := added + 1;
  end loop;
  return jsonb_build_object('ok', true, 'added', added);
exception when others then
  return jsonb_build_object('ok', false, 'error', sqlerrm);
end $$;
revoke all on function public.founder_mail_sync() from public, anon, authenticated;

create or replace function public.founder_mail_refresh() returns jsonb
language plpgsql security definer set search_path to 'public' as $$
begin
  if not public.is_founder() then raise exception 'founders only'; end if;
  return public.founder_mail_sync();
end $$;

-- Settings shown in the inbox (never returns the key itself).
create or replace function public.founder_mail_settings() returns jsonb
language plpgsql security definer set search_path to 'public' as $$
begin
  if not public.is_founder() then raise exception 'founders only'; end if;
  return jsonb_build_object(
    'has_key', exists (select 1 from public.private_config where key = 'resend_inbox_api_key' and coalesce(value, '') <> ''),
    'address', coalesce(nullif(trim((select value from public.private_config where key = 'mail_address')), ''), 'josh@voxprints.com'),
    'from_name', coalesce(nullif(trim((select value from public.private_config where key = 'mail_from_name')), ''), 'Josh from Voxprints'),
    'unread', (select count(*) from public.founder_mail where box = 'inbox' and read_at is null and not archived)
  );
end $$;

create or replace function public.founder_mail_list(p_box text, p_search text default null, p_limit int default 100)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare q text := nullif(trim(coalesce(p_search, '')), '');
begin
  if not public.is_founder() then raise exception 'founders only'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object(
      'id', m.id, 'box', m.box, 'from', m.from_addr, 'to', m.to_addrs, 'subject', m.subject,
      'snippet', left(regexp_replace(coalesce(m.text_body, regexp_replace(coalesce(m.html_body, ''), '<[^>]*>', ' ', 'g')), '\s+', ' ', 'g'), 160),
      'created_at', m.created_at, 'read', m.read_at is not null, 'archived', m.archived,
      'attachments', jsonb_array_length(m.attachments)) order by m.created_at desc)
    from (select * from public.founder_mail m
          where (case when p_box = 'archived' then m.archived else m.box = p_box and not m.archived end)
            and (q is null or m.subject ilike '%' || q || '%' or m.from_addr ilike '%' || q || '%' or m.to_addrs::text ilike '%' || q || '%' or coalesce(m.text_body, '') ilike '%' || q || '%')
          order by m.created_at desc limit least(greatest(coalesce(p_limit, 100), 1), 300)) m), '[]'::jsonb);
end $$;

create or replace function public.founder_mail_get(p_id text) returns jsonb
language plpgsql security definer set search_path to 'public' as $$
declare m public.founder_mail;
begin
  if not public.is_founder() then raise exception 'founders only'; end if;
  update public.founder_mail set read_at = coalesce(read_at, now()) where id = p_id returning * into m;
  if not found then return null; end if;
  return jsonb_build_object('id', m.id, 'box', m.box, 'from', m.from_addr, 'to', m.to_addrs, 'cc', m.cc_addrs, 'reply_to', m.reply_to,
    'subject', m.subject, 'text', m.text_body, 'html', m.html_body, 'message_id', m.message_id, 'attachments', m.attachments,
    'created_at', m.created_at, 'archived', m.archived);
end $$;

create or replace function public.founder_mail_set(p_id text, p_read boolean default null, p_archived boolean default null) returns void
language plpgsql security definer set search_path to 'public' as $$
begin
  if not public.is_founder() then raise exception 'founders only'; end if;
  update public.founder_mail set
    read_at = case when p_read is null then read_at when p_read then coalesce(read_at, now()) else null end,
    archived = coalesce(p_archived, archived)
  where id = p_id;
end $$;

-- A short-lived download link for a received attachment.
create or replace function public.founder_mail_attachment(p_id text, p_attachment_id text) returns jsonb
language plpgsql security definer set search_path to 'public' as $$
declare r jsonb; a jsonb;
begin
  if not public.is_founder() then raise exception 'founders only'; end if;
  if p_id !~ '^[A-Za-z0-9-]{8,80}$' then raise exception 'bad id'; end if;
  r := public.resend_mail_api('GET', '/emails/receiving/' || p_id || '/attachments');
  if (r->>'status')::int is distinct from 200 then
    return jsonb_build_object('error', coalesce(r->'body'->>'message', r->>'error', 'Resend returned ' || (r->>'status')));
  end if;
  select x into a from jsonb_array_elements(coalesce(r->'body'->'data', '[]'::jsonb)) x where x->>'id' = p_attachment_id limit 1;
  if a is null then return jsonb_build_object('error', 'That attachment is no longer available from Resend.'); end if;
  return jsonb_build_object('url', a->>'download_url', 'filename', a->>'filename');
end $$;

-- Send from the inbox address. p_to / p_cc: json arrays of addresses. p_attachments: [{filename, content (base64)}].
create or replace function public.founder_mail_send(p_to jsonb, p_cc jsonb, p_subject text, p_text text, p_reply_to_id text default null, p_attachments jsonb default '[]'::jsonb)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare
  addr text; from_name text; from_hdr text; orig public.founder_mail; hdrs jsonb := '{}'::jsonb;
  body jsonb; r jsonb; new_id text; html text; att_size bigint;
  re text := '^[^@\s<>",;]+@[^@\s<>",;]+\.[^@\s<>",;]+$';
begin
  if not public.is_founder() then raise exception 'founders only'; end if;
  p_cc := coalesce(p_cc, '[]'::jsonb); p_attachments := coalesce(p_attachments, '[]'::jsonb);
  if jsonb_typeof(p_to) <> 'array' or jsonb_array_length(p_to) = 0 then return jsonb_build_object('error', 'Add at least one recipient.'); end if;
  if jsonb_typeof(p_cc) <> 'array' or jsonb_array_length(p_to) + jsonb_array_length(p_cc) > 20 then return jsonb_build_object('error', 'Too many recipients (20 max).'); end if;
  if exists (select 1 from jsonb_array_elements_text(p_to || p_cc) x where x !~ re) then return jsonb_build_object('error', 'One of the email addresses doesn''t look right.'); end if;
  if coalesce(trim(p_subject), '') = '' then return jsonb_build_object('error', 'Add a subject.'); end if;
  if length(coalesce(p_text, '')) > 200000 then return jsonb_build_object('error', 'The message is too long.'); end if;
  select coalesce(sum(length(a->>'content')), 0) into att_size from jsonb_array_elements(p_attachments) a;
  if jsonb_array_length(p_attachments) > 10 or att_size > 14000000 then return jsonb_build_object('error', 'Attachments are too big (10 MB total max).'); end if;

  addr := coalesce(nullif(trim((select value from public.private_config where key = 'mail_address')), ''), 'josh@voxprints.com');
  from_name := coalesce(nullif(trim((select value from public.private_config where key = 'mail_from_name')), ''), 'Josh from Voxprints');
  from_hdr := replace(from_name, '"', '') || ' <' || addr || '>';

  if p_reply_to_id is not null then
    select * into orig from public.founder_mail where id = p_reply_to_id;
    if found and orig.message_id is not null then
      hdrs := jsonb_build_object('In-Reply-To', orig.message_id, 'References', trim(coalesce(orig.references_hdr, '') || ' ' || orig.message_id));
    end if;
  end if;

  html := '<div style="font-family:-apple-system,BlinkMacSystemFont,''Segoe UI'',Helvetica,Arial,sans-serif;font-size:15px;line-height:1.55;color:#1f2328;white-space:pre-wrap;">'
    || replace(replace(replace(replace(coalesce(p_text, ''), '&', '&amp;'), '<', '&lt;'), '>', '&gt;'), '"', '&quot;') || '</div>';
  body := jsonb_build_object('from', from_hdr, 'to', p_to, 'subject', left(trim(p_subject), 300), 'text', coalesce(p_text, ''), 'html', html, 'reply_to', jsonb_build_array(addr));
  if jsonb_array_length(p_cc) > 0 then body := body || jsonb_build_object('cc', p_cc); end if;
  if hdrs <> '{}'::jsonb then body := body || jsonb_build_object('headers', hdrs); end if;
  if jsonb_array_length(p_attachments) > 0 then
    body := body || jsonb_build_object('attachments', (select jsonb_agg(jsonb_build_object('filename', left(a->>'filename', 200), 'content', a->>'content')) from jsonb_array_elements(p_attachments) a));
  end if;

  r := public.resend_mail_api('POST', '/emails', body, 45000);
  if (r->>'status')::int not between 200 and 299 then
    return jsonb_build_object('error', coalesce(r->'body'->>'message', r->>'error', 'Resend returned ' || (r->>'status')));
  end if;
  new_id := coalesce(r->'body'->>'id', gen_random_uuid()::text);
  insert into public.founder_mail (id, box, from_addr, to_addrs, cc_addrs, subject, text_body, html_body, attachments, read_at)
  values (new_id, 'sent', from_hdr, p_to, p_cc, left(trim(p_subject), 300), p_text, html,
          coalesce((select jsonb_agg(jsonb_build_object('filename', a->>'filename', 'size', (length(a->>'content') * 3) / 4)) from jsonb_array_elements(p_attachments) a), '[]'::jsonb), now())
  on conflict (id) do nothing;
  return jsonb_build_object('ok', true, 'id', new_id);
end $$;

revoke all on function public.founder_mail_refresh() from public, anon;
revoke all on function public.founder_mail_settings() from public, anon;
revoke all on function public.founder_mail_list(text, text, int) from public, anon;
revoke all on function public.founder_mail_get(text) from public, anon;
revoke all on function public.founder_mail_set(text, boolean, boolean) from public, anon;
revoke all on function public.founder_mail_attachment(text, text) from public, anon;
revoke all on function public.founder_mail_send(jsonb, jsonb, text, text, text, jsonb) from public, anon;
grant execute on function public.founder_mail_refresh() to authenticated;
grant execute on function public.founder_mail_settings() to authenticated;
grant execute on function public.founder_mail_list(text, text, int) to authenticated;
grant execute on function public.founder_mail_get(text) to authenticated;
grant execute on function public.founder_mail_set(text, boolean, boolean) to authenticated;
grant execute on function public.founder_mail_attachment(text, text) to authenticated;
grant execute on function public.founder_mail_send(jsonb, jsonb, text, text, text, jsonb) to authenticated;

-- every 2 minutes: copy new mail before Resend clears it
select cron.schedule('founder-mail-sync', '*/2 * * * *', 'select public.founder_mail_sync();');
