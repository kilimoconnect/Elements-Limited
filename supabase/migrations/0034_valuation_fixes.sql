-- 0034_valuation_fixes.sql
-- Stage 1 defects D1 and D8 (additive; no posted row is changed).
--
-- D1  Voiding an inventory opening or a stock-increase adjustment removed the
--     stock at the CURRENT average but credited 1150 with the ORIGINAL value,
--     so the stock subledger and GL 1150 drifted apart whenever the average
--     had moved. Voids now credit 1150 with exactly the value removed and
--     post the difference to the purchase price variance mapping
--     (inventory.price_variance), as void_purchase does since 0026.
--     Voiding a stock decrease restored the units at the line's unit cost
--     (often 0) while debiting 1150 with the value originally removed; it now
--     restores exactly that value. Both voids also require the period of the
--     void date to be open, since their journal is dated on the void date.
--
-- D8  Dates were taken in UTC (Supabase default), so between 00:00 and 03:00
--     in Dar es Salaam current_date, column defaults and timestamp-to-date
--     casts fell on the previous day. The database default time zone is set
--     to Africa/Dar_es_Salaam (fixed UTC+03:00, no daylight saving). Stored
--     timestamps (timestamptz) are unchanged; only their local reading is.
--     The voids below also take their date explicitly in that zone.
--
-- Existing drift from voids posted before this migration is not rewritten:
-- Reports -> Cost Reconciliation (inventory_gl) shows any residual
-- difference, which is corrected with a dated adjusting journal.

-- ---------------------------------------------------------------------------
-- D8: database default time zone (applies to new sessions)
-- ---------------------------------------------------------------------------
do $$
begin
  execute format('alter database %I set timezone to %L', current_database(), 'Africa/Dar_es_Salaam');
exception when insufficient_privilege then
  raise warning 'Could not set the database time zone (insufficient privilege). Set it to Africa/Dar_es_Salaam in the Supabase dashboard before go-live.';
end $$;
set timezone to 'Africa/Dar_es_Salaam';

-- ---------------------------------------------------------------------------
-- D1: helper — the 1150 / variance lines for a stock-removing void
-- ---------------------------------------------------------------------------
-- original: the value 1150 was debited with when the document posted
-- removed:  the value the stock movements actually took out now
create or replace function public._void_inventory_lines(p_company uuid, p_original numeric, p_removed numeric)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare jl jsonb; diff numeric(18,2) := round(p_original - p_removed, 2);
begin
  jl := jsonb_build_array(jsonb_build_object('account_id', public.account_id_by_code(p_company, '1150'),
    'debit', 0, 'credit', round(p_removed, 2), 'memo', 'Stock removed at average'));
  if diff > 0 then
    jl := jl || jsonb_build_object('account_id', public.account_for(p_company, 'inventory.price_variance'),
      'debit', 0, 'credit', diff, 'memo', 'Average cost difference on void');
  elsif diff < 0 then
    jl := jl || jsonb_build_object('account_id', public.account_for(p_company, 'inventory.price_variance'),
      'debit', -diff, 'credit', 0, 'memo', 'Average cost difference on void');
  end if;
  return jl;
end; $$;
revoke all on function public._void_inventory_lines(uuid, numeric, numeric) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- D1: inventory opening void
-- ---------------------------------------------------------------------------
create or replace function public.void_inventory_opening(p_id uuid, p_user uuid, p_reason text)
returns uuid language plpgsql security definer set search_path = public as $$
declare o public.inventory_openings; ln record; removed numeric(18,2) := 0;
  vdate date := (now() at time zone 'Africa/Dar_es_Salaam')::date;
begin
  select * into o from public.inventory_openings where id=p_id for update;
  if not found then raise exception 'Opening not found' using errcode='P0001'; end if;
  if o.document_status <> 'posted' then raise exception 'Only posted openings can be voided' using errcode='P0001'; end if;
  if coalesce(p_reason,'') = '' then raise exception 'A reason is required' using errcode='P0001'; end if;
  perform public.assert_period_open(o.company_id, o.opening_date);
  perform public.assert_period_open(o.company_id, vdate);

  -- product order keeps the lock order of every other stock posting
  for ln in select * from public.inventory_opening_lines where opening_id=p_id order by product_id, line_no loop
    removed := removed + public.record_stock_movement(o.company_id, o.branch_id, ln.product_id,
      'adjustment_void', 'inventory_opening_void', o.id, o.document_number, 0, ln.quantity, 0, p_user);
  end loop;

  perform public.create_journal(o.company_id, o.branch_id, vdate, 'inventory_opening_void', o.id, o.document_number,
    'Void opening '||o.document_number, p_user,
    jsonb_build_array(jsonb_build_object('account_id', public.account_id_by_code(o.company_id,'3200'),
      'debit', o.total_cost, 'credit', 0, 'memo', 'Opening balance equity'))
    || public._void_inventory_lines(o.company_id, o.total_cost, removed));

  update public.inventory_openings set document_status='voided', voided_by=p_user, voided_at=now(), void_reason=p_reason where id=p_id;
  insert into public.transaction_status_history(company_id, source_type, source_id, from_status, to_status, reason, changed_by)
    values (o.company_id, 'inventory_opening', p_id, 'posted', 'voided', p_reason, p_user);
  return p_id;
end; $$;

-- ---------------------------------------------------------------------------
-- D1: stock adjustment void
-- ---------------------------------------------------------------------------
create or replace function public.void_stock_adjustment(p_id uuid, p_user uuid, p_reason text)
returns uuid language plpgsql security definer set search_path = public as $$
declare a public.stock_adjustments; ln record; removed numeric(18,2) := 0;
  vdate date := (now() at time zone 'Africa/Dar_es_Salaam')::date;
begin
  select * into a from public.stock_adjustments where id=p_id for update;
  if not found then raise exception 'Adjustment not found' using errcode='P0001'; end if;
  if a.document_status <> 'posted' then raise exception 'Only posted adjustments can be voided' using errcode='P0001'; end if;
  if coalesce(p_reason,'')='' then raise exception 'A reason is required' using errcode='P0001'; end if;
  perform public.assert_period_open(a.company_id, a.adjustment_date);
  perform public.assert_period_open(a.company_id, vdate);

  for ln in select * from public.stock_adjustment_lines where adjustment_id=p_id order by product_id, line_no loop
    if a.direction='increase' then
      removed := removed + public.record_stock_movement(a.company_id, a.branch_id, ln.product_id,
        'adjustment_void','stock_adjustment_void', a.id, a.document_number, 0, ln.quantity, 0, p_user);
    else
      -- put back exactly the value the decrease took out
      perform public.record_stock_movement_value(a.company_id, a.branch_id, ln.product_id,
        'adjustment_void','stock_adjustment_void', a.id, a.document_number, ln.quantity, ln.total_value, p_user);
    end if;
  end loop;

  if a.direction='increase' then
    perform public.create_journal(a.company_id, a.branch_id, vdate, 'stock_adjustment_void', a.id, a.document_number,
      'Void adjustment '||a.document_number, p_user,
      jsonb_build_array(jsonb_build_object('account_id', public.account_id_by_code(a.company_id,'4300'),
        'debit', a.total_value, 'credit', 0, 'memo', 'Stock gain reversed'))
      || public._void_inventory_lines(a.company_id, a.total_value, removed));
  else
    perform public.create_journal(a.company_id, a.branch_id, vdate, 'stock_adjustment_void', a.id, a.document_number,
      'Void adjustment '||a.document_number, p_user, jsonb_build_array(
        jsonb_build_object('account_id', public.account_id_by_code(a.company_id,'1150'),'debit',a.total_value,'credit',0),
        jsonb_build_object('account_id', public.account_id_by_code(a.company_id,'6300'),'debit',0,'credit',a.total_value)));
  end if;

  update public.stock_adjustments set document_status='voided', voided_by=p_user, voided_at=now(), void_reason=p_reason where id=p_id;
  insert into public.transaction_status_history(company_id, source_type, source_id, from_status, to_status, reason, changed_by)
    values (a.company_id, 'stock_adjustment', p_id, 'posted', 'voided', p_reason, p_user);
  return p_id;
end; $$;

-- create or replace keeps grants; restate the service-role-only rule anyway
revoke all on function public.void_inventory_opening(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.void_stock_adjustment(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.void_inventory_opening(uuid, uuid, text) to service_role;
grant execute on function public.void_stock_adjustment(uuid, uuid, text) to service_role;
