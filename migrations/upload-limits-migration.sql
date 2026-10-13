-- Raise attachment limits: 50 files per order (was 10) and 50 attachments per customer message (was 10).
-- Applied in place by rewriting just the count check inside each function.
-- The per-file size limit (2GB, was 500MB) lives in the r2-sign edge function.
do $$
declare d text;
begin
  d := pg_get_functiondef('public.guard_order_insert()'::regprocedure);
  d := replace(d, 'jsonb_array_length(new.files) > 10 then raise exception ''Too many files (10 max).''',
                  'jsonb_array_length(new.files) > 50 then raise exception ''Too many files (50 max).''');
  execute d;
  d := pg_get_functiondef('public.add_customer_message(uuid,text,text,text,jsonb)'::regprocedure);
  d := replace(d, 'jsonb_array_length(p_files) > 10 then raise exception ''Too many attachments (10 max)''',
                  'jsonb_array_length(p_files) > 50 then raise exception ''Too many attachments (50 max)''');
  execute d;
end $$;
