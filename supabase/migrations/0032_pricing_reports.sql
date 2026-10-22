-- ===========================================================================
-- 0032 — Stage 8: pricing and operational reports.
--
-- Read-only reporting functions plus one controlled write:
--   * set_product_selling_price: the only way the pricing screen changes an
--     approved selling price (Owner, as for the product master), with an
--     insert-only history of old / new price and the costing basis used;
--   * commercial_overhead: expensed charges flagged for the commercial view
--     (storage etc.) spread per kg over the goods they relate to, following
--     receipts, rebagging and transfers — for pricing only, never posted;
--   * trace_receipt_units: where the units of one receipt went (held, sold
--     per sale, lost, in transit, in production), by the same weighted-average
--     replay the costing engine uses — the basis of shipment-provenance
--     profitability, which is therefore an allocation, not lot profit;
--   * sales_profitability: revenue, cost of sales at sale, returns and late
--     cost adjustments posted in the period, per branch and product.
-- Additive; nothing existing changes.
-- ===========================================================================

create table if not exists public.product_price_changes (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references public.companies(id) on delete restrict,
  product_id  uuid not null references public.products(id) on delete restrict,
  old_price   numeric(18,2) not null,
  new_price   numeric(18,2) not null check (new_price >= 0),
  basis       jsonb not null default '{}'::jsonb,
  reason      text,
  changed_by  uuid references auth.users(id) on delete set null,
  changed_at  timestamptz not null default clock_timestamp()
);
create index if not exists product_price_changes_product_idx on public.product_price_changes(product_id, changed_at);
drop trigger if exists trg_ppc_immutable on public.product_price_changes;
create trigger trg_ppc_immutable before update or delete on public.product_price_changes
  for each row execute function public.block_update_delete();
drop trigger if exists trg_ppc_company on public.product_price_changes;
create trigger trg_ppc_company before insert on public.product_price_changes
  for each row execute function public.check_company_consistency('product_id','products');

create or replace function public.set_product_selling_price(
  p_product uuid, p_user uuid, p_price numeric, p_basis jsonb, p_reason text, p_idem text
) returns uuid language plpgsql security definer set search_path = public as $$
declare p public.products; cid uuid;
begin
  perform public._require_key(p_idem);
  select * into p from public.products where id = p_product for update;
  if not found then raise exception 'Product not found' using errcode = 'P0001'; end if;
  if public._is_replay(p_idem, 'set_product_selling_price', p_product) then return p_product; end if;
  perform public.assert_actor(p_user, p.company_id, null);
  if not public._user_is_owner(p_user) then
    raise exception 'Only the Owner can change approved selling prices (product master)' using errcode = '42501'; end if;
  if p_price is null or p_price < 0 or p_price <> round(p_price, 2) then
    raise exception 'Price must be zero or more with at most 2 decimals' using errcode = 'P0001'; end if;
  if not public.claim_idempotency(p_idem, 'set_product_selling_price', p_product) then return p_product; end if;
  insert into public.product_price_changes(company_id, product_id, old_price, new_price, basis, reason, changed_by)
    values (p.company_id, p.id, p.selling_price, p_price, coalesce(p_basis, '{}'::jsonb), nullif(trim(coalesce(p_reason, '')), ''), p_user)
    returning id into cid;
  update public.products set selling_price = p_price, updated_by = p_user where id = p.id;
  return cid;
end; $$;

-- ---------------------------------------------------------------------------
-- Commercial overhead per kg (pricing only).
-- ---------------------------------------------------------------------------
create or replace function public.commercial_overhead(p_company uuid)
returns table(branch_id uuid, product_id uuid, basis_kg numeric, amount numeric, per_kg numeric)
language plpgsql security definer set search_path = public as $$
#variable_conflict use_column
declare sh record; r record; o record; x record; per numeric; chg numeric; kgsum numeric;
begin
  create temp table if not exists _co(branch_id uuid, product_id uuid, kg numeric, amount numeric) on commit drop;
  delete from _co;
  -- 1. import shipments: commercial extra per kg of each line, onto the kg received
  for sh in select id from public.import_shipments where company_id = p_company and logistics_status not in ('draft','cancelled') loop
    for r in select s.line_id, (s.commercial_per_kg - s.act_per_kg) extra from public.landed_cost_sheet(sh.id) s loop
      insert into _co select ir.branch_id, il.product_id, irl.net_kg_received, round(irl.net_kg_received * coalesce(r.extra, 0), 2)
        from public.import_receipt_lines irl join public.import_receipts ir on ir.id = irl.receipt_id and ir.document_status = 'posted'
        join public.import_shipment_lines il on il.id = irl.shipment_line_id
        where irl.shipment_line_id = r.line_id and irl.net_kg_received > 0;
    end loop;
  end loop;
  -- 2. rebagging: the bulk's commercial per kg plus the order's own expensed commercial charges, onto output kg
  for o in select * from public.rebag_orders where company_id = p_company and document_status = 'completed' order by completion_date, id loop
    select case when sum(kg) > 0 then sum(amount) / sum(kg) else 0 end into per from _co c where c.branch_id = o.branch_id and c.product_id = o.bulk_product_id;
    select coalesce(sum(case status when 'invoiced' then actual_amount when 'accrued' then accrued_amount else 0 end), 0) into chg
      from public.cost_sources where rebag_order_id = o.id and inventory_treatment = 'expense' and include_in_commercial_cost and status <> 'voided';
    select sum(net_kg) into kgsum from public.rebag_outputs where order_id = o.id;
    insert into _co select o.branch_id, op.product_id, op.net_kg, round(op.net_kg * coalesce(per, 0) + chg * op.net_kg / nullif(kgsum, 0), 2)
      from public.rebag_outputs op where op.order_id = o.id;
  end loop;
  -- 3. transfers: the source's commercial per kg plus the transfer's own expensed commercial charges, onto kg accepted
  for x in select t.id, t.source_branch_id, t.destination_branch_id, l.product_id, coalesce(l.kg_per_unit, public._kg_per_unit(l.product_id), 0) kgu, l.qty_received, l.qty_dispatched
           from public.stock_transfers t join public.stock_transfer_lines l on l.transfer_id = t.id
           where t.company_id = p_company and t.posts_in_transit and l.qty_received > 0 order by t.created_at, t.id loop
    select case when sum(kg) > 0 then sum(amount) / sum(kg) else 0 end into per from _co c where c.branch_id = x.source_branch_id and c.product_id = x.product_id;
    select coalesce(sum(case status when 'invoiced' then actual_amount when 'accrued' then accrued_amount else 0 end), 0) into chg
      from public.cost_sources where stock_transfer_id = x.id and inventory_treatment = 'expense' and include_in_commercial_cost and status <> 'voided';
    select sum(l2.qty_dispatched * coalesce(l2.kg_per_unit, 0)) into kgsum from public.stock_transfer_lines l2 where l2.transfer_id = x.id;
    insert into _co values (x.destination_branch_id, x.product_id, x.qty_received * x.kgu,
      round(x.qty_received * x.kgu * coalesce(per, 0) + chg * (x.qty_received * x.kgu) / nullif(kgsum, 0), 2));
  end loop;
  return query select c.branch_id, c.product_id, sum(c.kg), sum(coalesce(c.amount, 0)),
    case when sum(c.kg) > 0 then round(sum(coalesce(c.amount, 0)) / sum(c.kg), 4) else 0 end
    from _co c group by c.branch_id, c.product_id;
end; $$;

-- ---------------------------------------------------------------------------
-- Where a receipt's units went (read-only replay, same rules as the costing
-- engine: pro-rata outflows, returned units rejoin, rebagging and transfers
-- followed).
-- ---------------------------------------------------------------------------
create or replace function public.trace_receipt_units(
  p_company uuid, p_branch uuid, p_product uuid, p_start_at timestamptz, p_start_id uuid, p_units numeric, p_depth int default 0
) returns table(kind text, ref_id uuid, branch_id uuid, product_id uuid, units numeric)
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
declare
  mv record; remaining numeric := p_units; take numeric; before numeric; sold jsonb := '{}'::jsonb; doc uuid; tot numeric; back numeric;
  k text; typ text; o public.rebag_orders; op record; consumed numeric; dl public.stock_transfer_dispatch_lines; t public.stock_transfers; g numeric; m record;
  d numeric; rc numeric;
begin
  if p_units <= 0 or p_depth > 10 then return; end if;
  for mv in select * from public.stock_movements s
            where s.company_id = p_company and s.branch_id = p_branch and s.product_id = p_product and (s.created_at, s.id) > (p_start_at, p_start_id)
              and ((s.qty_out > 0 and s.movement_type <> 'rebag_void') or (s.qty_in > 0 and s.movement_type in ('sale_void','sales_return','rebag_return','rebag_void')))
            order by s.created_at, s.id loop
    if mv.qty_in > 0 then
      if mv.movement_type in ('sale_void','sales_return') then
        typ := 'sale'; doc := case when mv.movement_type = 'sale_void' then mv.source_id else (select r.sale_id from public.sales_returns r where r.id = mv.source_id) end;
      else typ := 'rebag'; doc := mv.source_id; end if;
      k := doc::text;
      if doc is null or not (sold ? k) then continue; end if;
      select coalesce(sum(s2.qty_out), 0) into tot from public.stock_movements s2 where s2.source_id = doc and s2.branch_id = p_branch and s2.product_id = p_product
        and s2.movement_type = any(case when typ = 'sale' then array['sale'] else array['rebag_issue','rebag_consume'] end);
      if tot <= 0 then continue; end if;
      back := least((sold->k->>'cur')::numeric, (sold->k->>'orig')::numeric * mv.qty_in / tot);
      if back <= 0 then continue; end if;
      sold := jsonb_set(sold, array[k, 'cur'], to_jsonb((sold->k->>'cur')::numeric - back));
      remaining := remaining + back;
      continue;
    end if;
    if remaining <= 0 then continue; end if;
    before := mv.balance_qty + mv.qty_out;
    if before <= 0 then continue; end if;
    take := least(remaining, remaining * mv.qty_out / before);
    remaining := remaining - take;
    if mv.movement_type in ('sale','rebag_issue','rebag_consume') then
      k := mv.source_id::text;
      sold := jsonb_set(sold, array[k], jsonb_build_object('orig', coalesce((sold->k->>'orig')::numeric, 0) + take,
                'cur', coalesce((sold->k->>'cur')::numeric, 0) + take, 'typ', case when mv.movement_type = 'sale' then 'sale' else 'rebag' end));
    elsif mv.movement_type = 'transfer_out' then
      select * into t from public.stock_transfers where id = mv.source_id;
      if t.posts_in_transit then
        select * into dl from public.stock_transfer_dispatch_lines where movement_id = mv.id;
        if dl.id is null then continue; end if;
        g := take / dl.qty;
        if dl.qty - dl.qty_accepted - dl.qty_lost_normal - dl.qty_lost_abnormal > 0 then
          return query select 'transit'::text, dl.dispatch_id, t.destination_branch_id, p_product, (dl.qty - dl.qty_accepted - dl.qty_lost_normal - dl.qty_lost_abnormal) * g;
        end if;
        if dl.qty_lost_abnormal + dl.qty_lost_normal > 0 then
          return query select 'loss'::text, dl.dispatch_id, t.destination_branch_id, p_product, (dl.qty_lost_abnormal + dl.qty_lost_normal) * g;
        end if;
        for m in select s3.id, s3.created_at, s3.qty_in from public.stock_movements s3 where s3.id in (
                   select rl.movement_id from public.stock_transfer_receipt_lines rl where rl.dispatch_line_id = dl.id and rl.movement_id is not null
                   union select r.movement_id from public.stock_transfer_resolutions r join public.stock_transfer_receipt_lines rl on rl.id = r.receipt_line_id
                     where rl.dispatch_line_id = dl.id and r.movement_id is not null) loop
          return query select * from public.trace_receipt_units(p_company, t.destination_branch_id, p_product, m.created_at, m.id, m.qty_in * g, p_depth + 1);
        end loop;
      else
        select coalesce(sum(qty_dispatched), 0), coalesce(sum(qty_received), 0) into d, rc from public.stock_transfer_lines where transfer_id = t.id and stock_transfer_lines.product_id = p_product;
        if d <= 0 then continue; end if;
        if d - rc > 0 and t.status <> 'voided' then return query select 'transit'::text, t.id, t.destination_branch_id, p_product, take * (d - rc) / d; end if;
        for m in select s3.id, s3.created_at, s3.qty_in from public.stock_movements s3 where s3.source_id = t.id and s3.product_id = p_product
                   and s3.branch_id = t.destination_branch_id and s3.movement_type = 'transfer_in' loop
          return query select * from public.trace_receipt_units(p_company, t.destination_branch_id, p_product, m.created_at, m.id, take * m.qty_in / d, p_depth + 1);
        end loop;
      end if;
    elsif mv.movement_type in ('adjustment_decrease','adjustment_void','import_receipt_void') then
      return query select 'loss'::text, mv.source_id, p_branch, p_product, take;
    else
      return query select 'out'::text, mv.source_id, p_branch, p_product, take;
    end if;
  end loop;
  for k in select jsonb_object_keys(sold) loop
    if (sold->k->>'cur')::numeric <= 0 then continue; end if;
    if sold->k->>'typ' = 'sale' then
      return query select 'sale'::text, k::uuid, p_branch, p_product, (sold->k->>'cur')::numeric;
    else
      select * into o from public.rebag_orders where id = k::uuid;
      if o.document_status = 'issued' then
        return query select 'wip'::text, o.id, p_branch, p_product, (sold->k->>'cur')::numeric;
      elsif o.document_status = 'completed' and p_product = o.bulk_product_id then
        consumed := o.issued_kg - o.returned_kg;
        if consumed <= 0 then continue; end if;
        g := (sold->k->>'cur')::numeric / consumed;
        if o.abnormal_loss_kg > 0 then return query select 'loss'::text, o.id, p_branch, p_product, o.abnormal_loss_kg * g; end if;
        for op in select r.product_id pid, r.bags, s4.id mid, s4.created_at at from public.rebag_outputs r join public.stock_movements s4 on s4.id = r.movement_id where r.order_id = o.id loop
          return query select * from public.trace_receipt_units(p_company, o.branch_id, op.pid, op.at, op.mid, op.bags * g, p_depth + 1);
        end loop;
      end if;
    end if;
  end loop;
  if remaining > 0 then return query select 'held'::text, null::uuid, p_branch, p_product, remaining; end if;
end; $$;

-- Shipment provenance of sales (allocation): units of each import receipt
-- traced to the sales that took them; revenue and cost of sales at the sale's
-- own per-unit figures (the blended weighted average at that time).
create or replace function public.shipment_sales_trace(p_company uuid, p_from date, p_to date)
returns table(shipment_id uuid, branch_id uuid, product_id uuid, units numeric, revenue numeric, cogs numeric, held_units numeric)
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
declare r record; tr record; sl record;
begin
  for r in select s.id sid, irl.movement_id, m.branch_id, m.product_id, m.created_at, m.qty_in
           from public.import_receipt_lines irl join public.import_receipts ir on ir.id = irl.receipt_id and ir.document_status = 'posted'
           join public.import_shipment_lines il on il.id = irl.shipment_line_id join public.import_shipments s on s.id = il.shipment_id
           join public.stock_movements m on m.id = irl.movement_id
           where s.company_id = p_company and irl.movement_id is not null loop
    for tr in select * from public.trace_receipt_units(p_company, r.branch_id, r.product_id, r.created_at, r.movement_id, r.qty_in, 0) loop
      if tr.kind = 'sale' then
        select sa.document_date, sum(x.quantity) q, sum(x.net_amount) rev, sum(x.cogs) cg into sl
          from public.sales sa join public.sale_lines x on x.sale_id = sa.id and x.product_id = tr.product_id
          where sa.id = tr.ref_id and sa.document_status = 'posted' group by sa.document_date;
        if sl.q > 0 and sl.document_date between p_from and p_to then
          shipment_id := r.sid; branch_id := tr.branch_id; product_id := tr.product_id; units := tr.units;
          revenue := round(sl.rev * tr.units / sl.q, 2); cogs := round(sl.cg * tr.units / sl.q, 2); held_units := 0;
          return next;
        end if;
      elsif tr.kind = 'held' then
        shipment_id := r.sid; branch_id := tr.branch_id; product_id := tr.product_id; units := 0; revenue := 0; cogs := 0; held_units := tr.units;
        return next;
      end if;
    end loop;
  end loop;
end; $$;

-- Per branch and product: sales, returns and late cost adjustments posted in the period.
create or replace function public.sales_profitability(p_company uuid, p_from date, p_to date)
returns table(branch_id uuid, product_id uuid, qty_sold numeric, revenue numeric, cogs numeric, qty_returned numeric, returns_revenue numeric,
  returns_cogs numeric, late_cost numeric)
language sql stable security definer set search_path = public as $$
  with s as (
    select sa.branch_id, x.product_id, sum(x.quantity) q, sum(x.net_amount) rev, sum(x.cogs) cg
    from public.sales sa join public.sale_lines x on x.sale_id = sa.id
    where sa.company_id = p_company and sa.document_status = 'posted' and sa.document_date between p_from and p_to group by 1, 2
  ), r as (
    select rt.branch_id, x.product_id, sum(x.quantity) q, sum(x.net_amount) rev, sum(x.cogs_reversal) cg
    from public.sales_returns rt join public.sales_return_lines x on x.return_id = rt.id
    where rt.company_id = p_company and rt.document_status = 'posted' and rt.document_date between p_from and p_to group by 1, 2
  ), l as (
    select c.branch_id, c.product_id, sum(case when c.target = 'cogs' then c.amount when c.target = 'return_restore' then -c.amount else 0 end) amt
    from public.cost_delta_lines c
    where c.company_id = p_company and c.target in ('cogs','return_restore') and exists (
      select 1 from public.journal_entries j where j.source_id = c.src_id and j.company_id = p_company and j.entry_date between p_from and p_to)
    group by 1, 2
  ), keys as (select branch_id, product_id from s union select branch_id, product_id from r union select branch_id, product_id from l)
  select k.branch_id, k.product_id, coalesce(s.q, 0), coalesce(s.rev, 0), coalesce(s.cg, 0), coalesce(r.q, 0), coalesce(r.rev, 0), coalesce(r.cg, 0), coalesce(l.amt, 0)
  from keys k left join s using (branch_id, product_id) left join r using (branch_id, product_id) left join l using (branch_id, product_id);
$$;

do $$
declare f record;
begin
  for f in select p.oid::regprocedure sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname in ('set_product_selling_price','commercial_overhead','trace_receipt_units','shipment_sales_trace','sales_profitability') loop
    execute format('revoke all on function %s from public, anon, authenticated', f.sig);
    execute format('grant execute on function %s to service_role', f.sig);
  end loop;
end $$;
alter table public.product_price_changes enable row level security;
alter table public.product_price_changes force row level security;
drop policy if exists product_price_changes_select on public.product_price_changes;
create policy product_price_changes_select on public.product_price_changes for select to authenticated using (public.has_company_access(company_id));
grant select, insert, update, delete on public.product_price_changes to service_role;
revoke all on public.product_price_changes from anon, authenticated;
grant select on public.product_price_changes to authenticated;
