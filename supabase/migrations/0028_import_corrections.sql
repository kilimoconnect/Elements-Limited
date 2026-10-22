-- ===========================================================================
-- 0028 — Stage 4 completion: corrections for import goods invoices and
-- return-aware late-cost propagation.
--
-- 1. void_import_goods_invoice: a posted import goods invoice can be voided
--    with a reason while its supplier balance is untouched (no payments,
--    credits or revaluations). The invoice entries are reversed; when
--    ownership is already recorded the shipment line goes back to its
--    provisional (accrual-rate) value and only that difference moves cost.
--    The posted invoice and its journals stay as they were.
-- 2. _propagate_from_movement: units of a receipt that were sold and later
--    came back through a sale void or a sales return rejoin the stock pool,
--    so a later cost follows them back into stock instead of cost of sales.
--
-- Additive: replaces functions only; no data changes.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- The purchase-void path stays blocked for import invoices; the dedicated
-- function below sets letiq.import_posting while it voids.
-- ---------------------------------------------------------------------------
create or replace function public.purchases_block_import_reversal()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if TG_TABLE_NAME = 'purchases' then
    if NEW.posting_mode = 'invoice_only' and OLD.document_status = 'posted' and NEW.document_status = 'voided'
       and coalesce(current_setting('letiq.import_posting', true), 'off') <> 'on' then
      raise exception 'Import goods invoices are voided from the shipment (Void goods invoice)' using errcode = 'P0001';
    end if;
    return NEW;
  end if;
  if exists (select 1 from public.purchases where id = NEW.purchase_id and posting_mode = 'invoice_only') then
    raise exception 'Import goods invoices have no stock to return through purchase returns' using errcode = 'P0001';
  end if;
  return NEW;
end; $$;

create or replace function public.void_import_goods_invoice(p_id uuid, p_user uuid, p_reason text, p_idem text)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v public.purchases; sh public.import_shipments; pb public.supplier_payables; ln record; l public.import_shipment_lines;
  cost_val numeric(18,2); fc_cost numeric(18,2); v_cost numeric(18,2) := 0; v_rec numeric(18,2) := 0;
  target numeric(18,2); delta numeric(18,2); jl jsonb := '[]'::jsonb; is_fc boolean; d date := current_date;
begin
  perform public._require_key(p_idem);
  select * into v from public.purchases where id = p_id for update;
  if not found then raise exception 'Invoice not found' using errcode = 'P0001'; end if;
  if public._is_replay(p_idem, 'void_import_goods_invoice', p_id) then return p_id; end if;
  if v.posting_mode <> 'invoice_only' or v.import_shipment_id is null then
    raise exception 'Not an import goods invoice' using errcode = 'P0001'; end if;
  if v.document_status <> 'posted' then raise exception 'Only posted invoices can be voided' using errcode = 'P0001'; end if;
  if coalesce(trim(p_reason), '') = '' then raise exception 'A reason is required' using errcode = 'P0001'; end if;
  select * into sh from public.import_shipments where id = v.import_shipment_id for update;
  perform public.assert_feature(v.company_id, 'imports');
  perform public.assert_actor(p_user, v.company_id, 'imports.void', v.branch_id);
  perform public.assert_period_open(v.company_id, d);

  select * into pb from public.supplier_payables where purchase_id = p_id for update;
  if pb.id is not null then
    if exists (select 1 from public.supplier_payable_events where payable_id = pb.id and event_type <> 'invoice') then
      raise exception 'This invoice has payments, credits or revaluations; reverse those first' using errcode = 'P0001'; end if;
    if pb.outstanding <> pb.original_amount then
      raise exception 'This invoice is partly settled; reverse the settlement first' using errcode = 'P0001'; end if;
  end if;
  if not public.claim_idempotency(p_idem, 'void_import_goods_invoice', p_id) then return p_id; end if;

  is_fc := v.currency_code <> 'TZS';
  for ln in select * from public.purchase_lines where purchase_id = p_id order by import_shipment_line_id, line_no, id loop
    cost_val := round(ln.net_amount + ln.nonrecoverable_tax, 2);
    fc_cost := case when is_fc then round(coalesce(ln.fc_net_amount, 0) + case when ln.is_recoverable then 0 else coalesce(ln.fc_tax_amount, 0) end, 2)
                    else cost_val end;
    v_cost := v_cost + cost_val; v_rec := v_rec + ln.recoverable_tax;

    select * into l from public.import_shipment_lines where id = ln.import_shipment_line_id for update;
    update public.import_shipment_lines set goods_invoiced_tzs = goods_invoiced_tzs - cost_val,
      goods_invoiced_fc = goods_invoiced_fc - fc_cost, goods_invoiced_qty = goods_invoiced_qty - ln.quantity,
      -- With no accrual rate on file (the line was fully invoiced at ownership),
      -- the voided invoice's rate stays the provisional rate.
      goods_accrual_rate = coalesce(goods_accrual_rate, case when is_fc then v.exchange_rate else 1 end)
      where id = l.id returning * into l;
    perform public._ship_ledger(sh.id, l.id, null, 'grir', -cost_val, 'purchase_void', p_id, d);
    if sh.ownership_recognised_date is not null then
      target := l.goods_invoiced_tzs + round(greatest(l.fc_amount - l.goods_invoiced_fc, 0) * l.goods_accrual_rate, 2);
      delta := target - l.goods_recognised_tzs;
      if delta <> 0 then
        jl := jl || public._apply_line_cost_delta(l.id, delta, d, 'purchase_void', p_id, v.document_number, p_user, null)
                 || public._jl(public.account_for(v.company_id, 'import.gr_ir'), -delta, 'Goods value back to provisional');
        perform public._ship_ledger(sh.id, l.id, null, 'grir', -delta, 'purchase_void', p_id, d);
        update public.import_shipment_lines set goods_recognised_tzs = goods_recognised_tzs + delta where id = l.id;
      end if;
    end if;
  end loop;

  jl := public._jl(public.account_for(v.company_id, 'import.gr_ir'), -v_cost, 'Import goods invoice voided')
     || public._jl(public.account_for(v.company_id, 'tax.input_vat'), -v_rec, 'Input VAT reversed')
     || public._jl(public.account_id_by_code(v.company_id, '2110'), v.grand_total,
          case when is_fc then 'Accounts payable reversed ('||v.currency_code||' '||v.fc_grand_total||')' else 'Accounts payable reversed' end)
     || jl;
  perform public.create_journal(v.company_id, v.branch_id, d, 'purchase_void', v.id, v.document_number,
    'Void import goods invoice '||v.document_number, p_user, jl);

  if pb.id is not null then
    perform public._payable_event(pb, 'invoice_void', 'purchase', p_id, d, -pb.fc_outstanding, -pb.outstanding);
    update public.supplier_payables set outstanding = 0, fc_outstanding = 0, status = 'voided' where id = pb.id;
  end if;
  perform set_config('letiq.import_posting', 'on', true);
  update public.purchases set document_status = 'voided', voided_by = p_user, voided_at = now(), void_reason = trim(p_reason) where id = p_id;
  perform set_config('letiq.import_posting', 'off', true);
  if sh.cost_status = 'finalized' then update public.import_shipments set cost_status = 'adjusted' where id = sh.id; end if;
  insert into public.transaction_status_history(company_id, source_type, source_id, from_status, to_status, reason, changed_by)
    values (v.company_id, 'purchase', p_id, 'posted', 'voided', trim(p_reason), p_user);
  return p_id;
end; $$;

revoke all on function public.void_import_goods_invoice(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.void_import_goods_invoice(uuid, uuid, text, text) to service_role;

-- ---------------------------------------------------------------------------
-- Return-aware replay. Sale outflows are tracked per sale; a later sale void
-- or sales return of that sale gives back its share of the receipt's units,
-- which rejoin the pool (and then follow later outflows like any other unit).
-- ---------------------------------------------------------------------------
create or replace function public._propagate_from_movement(
  p_company uuid, p_branch uuid, p_product uuid, p_start_at timestamptz, p_start_id uuid,
  p_units numeric, p_amount numeric, p_src_type text, p_src_id uuid, p_docnum text, p_user uuid, p_depth int default 0
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  mv record; remaining numeric := p_units; take numeric; before numeric; parts jsonb := '[]'::jsonb;
  s record; jl jsonb := '[]'::jsonb; unabsorbed numeric(18,2); kind text;
  sold jsonb := '{}'::jsonb; sale_id uuid; sale_qty numeric; back numeric; k text;
begin
  if p_amount = 0 or p_units <= 0 then return '[]'::jsonb; end if;
  if p_depth > 10 then raise exception 'Cost propagation chain too deep' using errcode = 'P0001'; end if;
  for mv in select * from public.stock_movements
            where company_id = p_company and branch_id = p_branch and product_id = p_product
              and (created_at, id) > (p_start_at, p_start_id)
              and (qty_out > 0 or (movement_type in ('sale_void','sales_return') and qty_in > 0))
            order by created_at, id loop
    if mv.qty_in > 0 then
      -- Units coming back from a sale this receipt contributed to.
      sale_id := case when mv.movement_type = 'sale_void' then mv.source_id
                      else (select r.sale_id from public.sales_returns r where r.id = mv.source_id) end;
      k := sale_id::text;
      if sale_id is null or not (sold ? k) then continue; end if;
      select coalesce(sum(qty_out), 0) into sale_qty from public.stock_movements
        where source_id = sale_id and movement_type = 'sale' and branch_id = p_branch and product_id = p_product;
      if sale_qty <= 0 then continue; end if;
      back := least((sold->k->>'cur')::numeric, (sold->k->>'orig')::numeric * mv.qty_in / sale_qty);
      if back <= 0 then continue; end if;
      sold := jsonb_set(sold, array[k, 'cur'], to_jsonb((sold->k->>'cur')::numeric - back));
      remaining := remaining + back;
      continue;
    end if;
    exit when remaining <= 0;
    before := mv.balance_qty + mv.qty_out;
    if before <= 0 then continue; end if;
    take := least(remaining, remaining * mv.qty_out / before);
    remaining := remaining - take;
    if mv.movement_type = 'sale' then
      k := mv.source_id::text;
      sold := jsonb_set(sold, array[k], jsonb_build_object(
                'orig', coalesce((sold->k->>'orig')::numeric, 0) + take,
                'cur',  coalesce((sold->k->>'cur')::numeric, 0) + take));
      continue;
    end if;
    kind := case mv.movement_type
              when 'sales_return_void' then 'cogs'
              when 'adjustment_decrease' then 'loss' when 'adjustment_void' then 'loss' when 'import_receipt_void' then 'loss'
              when 'purchase_return' then 'ppv'
              when 'transfer_out' then 'transfer'
              else 'cogs' end;
    parts := parts || jsonb_build_object('id', gen_random_uuid(), 'kind', kind, 'factor', take, 'mv', mv.id);
  end loop;
  for k in select jsonb_object_keys(sold) loop
    if (sold->k->>'cur')::numeric > 0 then
      parts := parts || jsonb_build_object('id', gen_random_uuid(), 'kind', 'cogs', 'factor', (sold->k->>'cur')::numeric);
    end if;
  end loop;
  if remaining > 0 then parts := parts || jsonb_build_object('id', gen_random_uuid(), 'kind', 'held', 'factor', remaining); end if;
  if jsonb_array_length(parts) = 0 then
    parts := jsonb_build_array(jsonb_build_object('id', gen_random_uuid(), 'kind', 'cogs', 'factor', 1));
  end if;

  for s in select p.value as part, a.amount from jsonb_array_elements(parts) p
           join public.allocate_amount(round(p_amount, 2), 'quantity', parts) a on a.target_id = (p.value->>'id')::uuid loop
    kind := s.part->>'kind';
    if kind = 'held' then
      unabsorbed := public._stock_value_adjust(p_company, p_branch, p_product, s.amount, p_src_type, p_src_id, p_docnum, p_user);
      jl := jl || public._jl(public.account_id_by_code(p_company, '1150'), s.amount - unabsorbed, 'Late cost to stock held')
               || public._jl(public.account_for(p_company, 'inventory.cost_of_sales'), unabsorbed, 'Late cost (stock no longer held)');
    elsif kind = 'cogs' then
      jl := jl || public._jl(public.account_for(p_company, 'inventory.cost_of_sales'), s.amount, 'Late cost to cost of sales');
    elsif kind = 'loss' then
      jl := jl || public._jl(public.account_for(p_company, 'inventory.loss'), s.amount, 'Late cost to stock written off');
    elsif kind = 'ppv' then
      jl := jl || public._jl(public.account_for(p_company, 'inventory.price_variance'), s.amount, 'Late cost to returned stock');
    else
      jl := jl || public._propagate_transfer((s.part->>'mv')::uuid, (s.part->>'factor')::numeric, s.amount,
                    p_src_type, p_src_id, p_docnum, p_user, p_depth);
    end if;
  end loop;
  return jl;
end; $$;
