-- ===========================================================================
-- 0029 — Stage 5: bulk-to-bag rebagging.
--
-- Extends the Stage 2 rebag tables (rebag_orders / rebag_inputs /
-- rebag_outputs, stock_lots) and the existing weighted-average stock engine:
--
--   draft ──issue──> issued ──complete──> completed ──void──> voided
--     │                │
--     └──cancel────────┴──> cancelled   (issued: bulk goes back at issue value)
--
-- Issue takes the bulk kg out of bulk stock at the weighted average; the value
-- is held on the order (work in progress, still inside 1150 - no clearing
-- account). Completion from draft issues and completes in one transaction;
-- completion from issued uses the issued kg and value (never issues twice).
--
-- Completion enforces  issued kg = good packaged net kg + bulk returned kg
--                                  + normal loss kg + abnormal loss kg
-- with normal loss limited to the bulk product's approved tolerance; any
-- abnormal loss needs rebagging.approve and is expensed (6300). Value:
--   bulk to outputs = issued value - returned share - abnormal share
--                     (normal loss absorbed), split by output net kg;
--   packaging       = actual materials consumed at weighted average, direct to
--                     their output, common materials by bag count;
--   conversion      = rebag cost sources accrued at completion (Cr 2140),
--                     capitalised by their documented basis (labour: bags);
-- each output is received into packaged stock with weighted-average logic.
--
-- Additive: new columns, wider status / movement-type checks, new functions;
-- _propagate_from_movement and post_cost_invoice are replaced (behaviour for
-- imports unchanged, plus conversion through rebagging).
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. Schema
-- ---------------------------------------------------------------------------
alter table public.products add column if not exists rebag_loss_tolerance_pct numeric(7,4) not null default 0;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'products_rebag_tolerance_range') then
    alter table public.products add constraint products_rebag_tolerance_range
      check (rebag_loss_tolerance_pct >= 0 and rebag_loss_tolerance_pct <= 100);
  end if;
end $$;

do $$
declare c record;
begin
  for c in select conname from pg_constraint where conrelid = 'public.rebag_orders'::regclass and contype = 'c'
             and conname <> 'rebag_orders_status_v2' and pg_get_constraintdef(oid) ilike '%document_status%' loop
    execute format('alter table public.rebag_orders drop constraint %I', c.conname);
  end loop;
  if not exists (select 1 from pg_constraint where conname = 'rebag_orders_status_v2') then
    alter table public.rebag_orders add constraint rebag_orders_status_v2
      check (document_status in ('draft','issued','completed','cancelled','voided'));
  end if;
  -- Packaging may be common to all outputs (thread, labels): target optional.
  for c in select conname from pg_constraint where conrelid = 'public.rebag_inputs'::regclass and contype = 'c'
             and conname <> 'rebag_inputs_target_v2' and pg_get_constraintdef(oid) ilike '%target_output_id%' loop
    execute format('alter table public.rebag_inputs drop constraint %I', c.conname);
  end loop;
  if not exists (select 1 from pg_constraint where conname = 'rebag_inputs_target_v2') then
    alter table public.rebag_inputs add constraint rebag_inputs_target_v2
      check (input_kind = 'packaging' or target_output_id is null);
  end if;
end $$;

alter table public.rebag_orders add column if not exists import_shipment_id uuid references public.import_shipments(id) on delete restrict;
alter table public.rebag_orders add column if not exists location text;
alter table public.rebag_orders add column if not exists operator_name text;
alter table public.rebag_orders add column if not exists issue_date date;
alter table public.rebag_orders add column if not exists completion_date date;
alter table public.rebag_orders add column if not exists issued_kg numeric(18,4) not null default 0;
alter table public.rebag_orders add column if not exists issued_value numeric(18,2) not null default 0;
alter table public.rebag_orders add column if not exists issue_unit_cost numeric(18,4);
alter table public.rebag_orders add column if not exists returned_kg numeric(18,4) not null default 0;
alter table public.rebag_orders add column if not exists returned_value numeric(18,2) not null default 0;
alter table public.rebag_orders add column if not exists abnormal_loss_value numeric(18,2) not null default 0;
alter table public.rebag_orders add column if not exists loss_tolerance_pct numeric(7,4);
alter table public.rebag_orders add column if not exists abnormal_approved_by uuid references auth.users(id) on delete set null;
alter table public.rebag_orders add column if not exists packaging_value numeric(18,2) not null default 0;
alter table public.rebag_orders add column if not exists conversion_value numeric(18,2) not null default 0;
alter table public.rebag_orders add column if not exists output_value numeric(18,2) not null default 0;
alter table public.rebag_orders add column if not exists issued_at timestamptz;
alter table public.rebag_orders add column if not exists issued_by uuid references auth.users(id) on delete set null;
alter table public.rebag_orders add column if not exists cancelled_at timestamptz;
alter table public.rebag_orders add column if not exists cancelled_by uuid references auth.users(id) on delete set null;
alter table public.rebag_orders add column if not exists voided_at timestamptz;
alter table public.rebag_orders add column if not exists voided_by uuid references auth.users(id) on delete set null;
alter table public.rebag_orders add column if not exists void_reason text;
alter table public.rebag_orders add column if not exists client_request_id text;
create unique index if not exists rebag_orders_client_request on public.rebag_orders(company_id, client_request_id) where client_request_id is not null;
create index if not exists rebag_orders_shipment_idx on public.rebag_orders(import_shipment_id);
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'rebag_orders_kg_nonneg') then
    alter table public.rebag_orders add constraint rebag_orders_kg_nonneg check (issued_kg >= 0 and returned_kg >= 0 and returned_kg <= issued_kg);
  end if;
end $$;
drop trigger if exists trg_rebag_orders_company on public.rebag_orders;
create trigger trg_rebag_orders_company before insert or update on public.rebag_orders
  for each row execute function public.check_company_consistency('branch_id','branches','bulk_product_id','products','import_shipment_id','import_shipments');

alter table public.rebag_outputs add column if not exists bulk_value numeric(18,2) not null default 0;
alter table public.rebag_outputs add column if not exists packaging_value numeric(18,2) not null default 0;
alter table public.rebag_outputs add column if not exists conversion_value numeric(18,2) not null default 0;
alter table public.rebag_outputs add column if not exists value_tzs numeric(18,2) not null default 0;
alter table public.rebag_outputs add column if not exists cost_delta_tzs numeric(18,2) not null default 0;
alter table public.rebag_outputs add column if not exists movement_id uuid references public.stock_movements(id) on delete restrict;
alter table public.rebag_outputs add column if not exists lot_id uuid references public.stock_lots(id) on delete restrict;

alter table public.rebag_inputs add column if not exists lot_id uuid references public.stock_lots(id) on delete restrict;
alter table public.rebag_inputs add column if not exists qty_per_bag numeric(18,4) check (qty_per_bag is null or qty_per_bag > 0);
alter table public.rebag_inputs add column if not exists damaged_qty numeric(18,4) not null default 0 check (damaged_qty >= 0);
alter table public.rebag_inputs add column if not exists returned_qty numeric(18,4) not null default 0 check (returned_qty >= 0);
alter table public.rebag_inputs add column if not exists value_tzs numeric(18,2) not null default 0;

-- Movement types for rebagging.
do $$
begin
  alter table public.stock_movements drop constraint if exists stock_movements_type_v2;
  if not exists (select 1 from pg_constraint where conname = 'stock_movements_type_v3') then
    alter table public.stock_movements add constraint stock_movements_type_v3 check (movement_type in (
      'opening','sale','sale_void','sales_return','sales_return_void',
      'adjustment_increase','adjustment_decrease','adjustment_void',
      'transfer_out','transfer_in','transfer_void',
      'purchase','purchase_return','import_receipt','import_receipt_void','cost_adjustment',
      'rebag_issue','rebag_return','rebag_consume','rebag_produce','rebag_void'));
  end if;
end $$;

-- Lines may be edited while draft or issued (actual bags, packaging, losses);
-- they freeze on completion. Bulk lines freeze at issue. Posting functions
-- set letiq.rebag_posting to record values.
create or replace function public.rebag_lines_guard()
returns trigger language plpgsql security definer set search_path = public as $$
declare o public.rebag_orders; p public.products; tgt public.rebag_outputs; posting boolean; oid uuid; is_bulk boolean := false;
begin
  posting := coalesce(current_setting('letiq.rebag_posting', true), 'off') = 'on';
  if TG_OP = 'DELETE' then oid := OLD.order_id; else oid := NEW.order_id; end if;
  if TG_TABLE_NAME = 'rebag_inputs' then
    if TG_OP <> 'INSERT' then is_bulk := OLD.input_kind = 'bulk'; end if;
    if TG_OP <> 'DELETE' then is_bulk := is_bulk or NEW.input_kind = 'bulk'; end if;
  end if;
  select * into o from public.rebag_orders where id = oid;
  if not posting and o.id is not null then
    if o.document_status not in ('draft','issued') then
      raise exception 'Lines of a % rebag order cannot change', o.document_status using errcode = 'P0001';
    end if;
    if o.document_status = 'issued' and is_bulk then
      raise exception 'The bulk issue is fixed once issued; cancel the order to change it' using errcode = 'P0001';
    end if;
  end if;
  if TG_OP = 'DELETE' then return OLD; end if;
  select * into p from public.products where id = NEW.product_id;
  if TG_TABLE_NAME = 'rebag_outputs' then
    if p.stock_role <> 'packaged' or p.bulk_product_id <> o.bulk_product_id then
      raise exception 'Rebag outputs must be bags filled from the order''s bulk product' using errcode = '23514';
    end if;
    if NEW.net_kg <> round(NEW.bags * p.net_weight_kg, 4) then
      raise exception 'Output net kg must equal bags x % kg', p.net_weight_kg using errcode = '23514';
    end if;
  else
    if NEW.input_kind = 'bulk' and NEW.product_id <> o.bulk_product_id then
      raise exception 'The bulk input must be the order''s bulk product' using errcode = '23514';
    end if;
    if NEW.input_kind = 'bulk' and NEW.lot_id is not null
       and not exists (select 1 from public.stock_lots where id = NEW.lot_id and product_id = o.bulk_product_id) then
      raise exception 'The batch is not a batch of the order''s bulk product' using errcode = '23514';
    end if;
    if NEW.input_kind = 'packaging' then
      if p.stock_role <> 'packaging_material' then
        raise exception 'Packaging inputs must be packaging materials' using errcode = '23514';
      end if;
      if NEW.target_output_id is not null then
        select * into tgt from public.rebag_outputs where id = NEW.target_output_id;
        if tgt.order_id <> NEW.order_id then
          raise exception 'Packaging must target an output of the same order' using errcode = '23514';
        end if;
      end if;
      if NEW.damaged_qty > NEW.quantity then
        raise exception 'Damaged packaging cannot exceed the quantity consumed' using errcode = '23514';
      end if;
    end if;
  end if;
  return NEW;
end; $$;
drop trigger if exists trg_rebag_outputs_guard on public.rebag_outputs;
create trigger trg_rebag_outputs_guard before insert or update or delete on public.rebag_outputs
  for each row execute function public.rebag_lines_guard();
drop trigger if exists trg_rebag_inputs_guard on public.rebag_inputs;
create trigger trg_rebag_inputs_guard before insert or update or delete on public.rebag_inputs
  for each row execute function public.rebag_lines_guard();

-- Header: key figures freeze once issued (except through the posting functions).
create or replace function public.rebag_orders_guard()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from public.products where id = NEW.bulk_product_id and stock_role = 'bulk') then
    raise exception 'A rebag order consumes a bulk product' using errcode = '23514';
  end if;
  if TG_OP = 'UPDATE' and coalesce(current_setting('letiq.rebag_posting', true), 'off') <> 'on' then
    if OLD.document_status <> NEW.document_status then
      raise exception 'Rebag order status changes only through issue / complete / cancel / void' using errcode = 'P0001';
    end if;
    if OLD.document_status not in ('draft','issued') then
      raise exception 'A % rebag order cannot be edited', OLD.document_status using errcode = 'P0001';
    end if;
    if OLD.document_status = 'issued' and (NEW.branch_id, NEW.bulk_product_id, NEW.issued_kg, NEW.issued_value, NEW.import_shipment_id)
         is distinct from (OLD.branch_id, OLD.bulk_product_id, OLD.issued_kg, OLD.issued_value, OLD.import_shipment_id) then
      raise exception 'Branch, bulk product, shipment and the issue are fixed once issued' using errcode = 'P0001';
    end if;
    if (NEW.issued_value, NEW.returned_value, NEW.abnormal_loss_value, NEW.packaging_value, NEW.conversion_value, NEW.output_value, NEW.document_number)
         is distinct from (OLD.issued_value, OLD.returned_value, OLD.abnormal_loss_value, OLD.packaging_value, OLD.conversion_value, OLD.output_value, OLD.document_number) then
      raise exception 'Rebag values are set by posting only' using errcode = 'P0001';
    end if;
  end if;
  if TG_OP = 'INSERT' and NEW.document_status <> 'draft' and coalesce(current_setting('letiq.rebag_posting', true), 'off') <> 'on' then
    raise exception 'A rebag order starts as a draft' using errcode = 'P0001';
  end if;
  return NEW;
end; $$;

-- ---------------------------------------------------------------------------
-- 2. Stock helpers
-- ---------------------------------------------------------------------------
-- Outflow at the weighted average; taking the whole balance takes its whole
-- value (no residue left in the subledger). Returns the value.
create or replace function public._stock_out_avg(
  p_company uuid, p_branch uuid, p_product uuid, p_type text, p_source_type text, p_source_id uuid,
  p_source_number text, p_qty numeric, p_user uuid
) returns numeric language plpgsql security definer set search_path = public as $$
declare bal public.stock_balances; v numeric(18,2); nq numeric(18,4); nv numeric(18,2); pname text;
begin
  if p_qty is null or p_qty <= 0 then raise exception 'Quantity must be positive' using errcode = 'P0001'; end if;
  select * into bal from public.stock_balances where company_id = p_company and branch_id = p_branch and product_id = p_product for update;
  if not found or bal.quantity < p_qty then
    select name into pname from public.products where id = p_product;
    raise exception 'Insufficient stock of % (available %, needed %)', pname, coalesce(bal.quantity, 0), p_qty using errcode = 'P0001';
  end if;
  v := case when p_qty = bal.quantity then bal.stock_value else least(round(p_qty * bal.avg_unit_cost, 2), bal.stock_value) end;
  nq := bal.quantity - p_qty; nv := bal.stock_value - v;
  insert into public.stock_movements(company_id, branch_id, product_id, movement_type, source_type, source_id, source_number,
      qty_in, qty_out, unit_cost, movement_value, balance_qty, avg_cost_after, balance_value, created_by, created_at)
    values (p_company, p_branch, p_product, p_type, p_source_type, p_source_id, p_source_number,
      0, p_qty, round(v / p_qty, 4), v, nq, case when nq > 0 then round(nv / nq, 4) else bal.avg_unit_cost end, nv, p_user, clock_timestamp());
  update public.stock_balances set quantity = nq, stock_value = nv,
    avg_unit_cost = case when nq > 0 then round(nv / nq, 4) else avg_unit_cost end, last_movement_at = now(), updated_at = now()
    where id = bal.id;
  return v;
end; $$;

-- Outflow at an exact value (reversals). Returns the value actually removed
-- (capped at the balance value; the caller books any difference).
create or replace function public._stock_out_value(
  p_company uuid, p_branch uuid, p_product uuid, p_type text, p_source_type text, p_source_id uuid,
  p_source_number text, p_qty numeric, p_value numeric, p_user uuid
) returns numeric language plpgsql security definer set search_path = public as $$
declare bal public.stock_balances; v numeric(18,2); nq numeric(18,4); nv numeric(18,2); pname text;
begin
  select * into bal from public.stock_balances where company_id = p_company and branch_id = p_branch and product_id = p_product for update;
  if not found or bal.quantity < p_qty then
    select name into pname from public.products where id = p_product;
    raise exception 'Insufficient stock of % to reverse (available %, needed %)', pname, coalesce(bal.quantity, 0), p_qty using errcode = 'P0001';
  end if;
  nq := bal.quantity - p_qty;
  v := case when nq = 0 then bal.stock_value else least(round(p_value, 2), bal.stock_value) end;
  nv := bal.stock_value - v;
  insert into public.stock_movements(company_id, branch_id, product_id, movement_type, source_type, source_id, source_number,
      qty_in, qty_out, unit_cost, movement_value, balance_qty, avg_cost_after, balance_value, created_by, created_at)
    values (p_company, p_branch, p_product, p_type, p_source_type, p_source_id, p_source_number,
      0, p_qty, round(v / p_qty, 4), v, nq, case when nq > 0 then round(nv / nq, 4) else bal.avg_unit_cost end, nv, p_user, clock_timestamp());
  update public.stock_balances set quantity = nq, stock_value = nv,
    avg_unit_cost = case when nq > 0 then round(nv / nq, 4) else avg_unit_cost end, last_movement_at = now(), updated_at = now()
    where id = bal.id;
  return v;
end; $$;

-- Lock every stock row an order touches, in (branch, product) order.
create or replace function public._rebag_lock(p_order uuid)
returns void language plpgsql security definer set search_path = public as $$
declare o public.rebag_orders; k jsonb;
begin
  select * into o from public.rebag_orders where id = p_order;
  select coalesce(jsonb_agg(jsonb_build_object('branch_id', o.branch_id, 'product_id', x.p)), '[]'::jsonb) into k from (
    select o.bulk_product_id p union select product_id from public.rebag_inputs where order_id = p_order
    union select product_id from public.rebag_outputs where order_id = p_order) x;
  perform public.lock_stock_balances(o.company_id, k);
end; $$;

-- Allocation factors over an order's outputs for a basis.
create or replace function public._rebag_targets(p_order uuid, p_basis text, p_targets jsonb)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare t jsonb := '[]'::jsonb; op record; e jsonb; f numeric;
begin
  if p_basis in ('direct','manual','percent') then
    if p_targets is null or jsonb_array_length(p_targets) = 0 then
      raise exception 'Choose the output(s) for a % allocation', p_basis using errcode = 'P0001'; end if;
    for e in select * from jsonb_array_elements(p_targets) loop
      if not exists (select 1 from public.rebag_outputs where id = (e->>'id')::uuid and order_id = p_order) then
        raise exception 'Allocation target is not an output of this rebag order' using errcode = '23514'; end if;
      f := case p_basis when 'direct' then 1 when 'manual' then (e->>'amount')::numeric else (e->>'percent')::numeric end;
      if f is null or f < 0 then raise exception 'Invalid allocation target' using errcode = 'P0001'; end if;
      t := t || jsonb_build_object('id', e->>'id', 'factor', f);
    end loop;
    if p_basis = 'direct' and jsonb_array_length(t) <> 1 then
      raise exception 'Direct allocation needs exactly one output' using errcode = 'P0001'; end if;
    return t;
  end if;
  for op in select * from public.rebag_outputs where order_id = p_order order by line_no, id loop
    f := case p_basis when 'weight' then op.net_kg when 'quantity' then op.bags when 'value' then op.bulk_value
           else null end;
    if f is null then raise exception 'Allocation basis % is not available for rebagging', p_basis using errcode = 'P0001'; end if;
    t := t || jsonb_build_object('id', op.id, 'factor', f);
  end loop;
  return t;
end; $$;

-- ---------------------------------------------------------------------------
-- 3. Issue (bulk out of stock at weighted average, held on the order)
-- ---------------------------------------------------------------------------
create or replace function public._rebag_issue(p_order uuid, p_user uuid, p_date date)
returns void language plpgsql security definer set search_path = public as $$
declare
  o public.rebag_orders; kg numeric(18,4); v numeric(18,2); docnum text; ln record; lb public.stock_lot_balances; mid uuid;
  ship uuid; n_ship int;
begin
  select * into o from public.rebag_orders where id = p_order for update;
  select coalesce(sum(quantity), 0) into kg from public.rebag_inputs where order_id = p_order and input_kind = 'bulk';
  if kg <= 0 then raise exception 'Enter the bulk kg issued to rebagging' using errcode = 'P0001'; end if;
  -- Provenance: batches must be at this branch with enough quantity, and all
  -- from the order's shipment when one is set.
  select count(distinct isl.shipment_id), min(isl.shipment_id::text)::uuid into n_ship, ship
    from public.rebag_inputs ri join public.stock_lots sl on sl.id = ri.lot_id
    join public.import_receipt_lines irl on sl.origin_type = 'import_receipt_line' and irl.id = sl.origin_id
    join public.import_shipment_lines isl on isl.id = irl.shipment_line_id
    where ri.order_id = p_order and ri.input_kind = 'bulk';
  if o.import_shipment_id is not null and n_ship > 0 and (n_ship > 1 or ship <> o.import_shipment_id) then
    raise exception 'The batches issued are not all from the order''s shipment' using errcode = 'P0001'; end if;
  docnum := coalesce(o.document_number, public.next_document_number(o.company_id, o.branch_id, 'rebag_order'));
  v := public._stock_out_avg(o.company_id, o.branch_id, o.bulk_product_id, 'rebag_issue', 'rebag_order', o.id, docnum, kg, p_user);
  select id into mid from public.stock_movements where source_id = o.id and movement_type = 'rebag_issue' order by created_at desc, id desc limit 1;
  for ln in select * from public.rebag_inputs where order_id = p_order and input_kind = 'bulk' and lot_id is not null order by lot_id loop
    select * into lb from public.stock_lot_balances where branch_id = o.branch_id and product_id = o.bulk_product_id and lot_id = ln.lot_id for update;
    if lb.id is null or lb.quantity < ln.quantity then
      raise exception 'Batch % has only % kg at this branch', (select lot_code from public.stock_lots where id = ln.lot_id), coalesce(lb.quantity, 0)
        using errcode = 'P0001'; end if;
    update public.stock_lot_balances set quantity = quantity - ln.quantity where id = lb.id;
    insert into public.stock_lot_flows(company_id, movement_id, flow_type, from_lot_id, branch_id, quantity)
      values (o.company_id, mid, 'rebag_consume', ln.lot_id, o.branch_id, ln.quantity);
  end loop;
  perform set_config('letiq.rebag_posting', 'on', true);
  update public.rebag_orders set document_status = 'issued', document_number = docnum, issued_kg = kg, issued_value = v,
    issue_unit_cost = round(v / kg, 4), issue_date = p_date, issued_at = now(), issued_by = p_user,
    import_shipment_id = coalesce(import_shipment_id, case when n_ship = 1 then ship end), updated_by = p_user
    where id = p_order;
  perform set_config('letiq.rebag_posting', 'off', true);
  insert into public.transaction_status_history(company_id, source_type, source_id, from_status, to_status, changed_by)
    values (o.company_id, 'rebag_order', o.id, 'draft', 'issued', p_user);
end; $$;

create or replace function public.issue_rebag_order(p_id uuid, p_user uuid, p_idem text)
returns uuid language plpgsql security definer set search_path = public as $$
declare o public.rebag_orders; d date;
begin
  perform public._require_key(p_idem);
  select * into o from public.rebag_orders where id = p_id for update;
  if not found then raise exception 'Rebag order not found' using errcode = 'P0001'; end if;
  if public._is_replay(p_idem, 'issue_rebag_order', p_id) then return p_id; end if;
  perform public.assert_feature(o.company_id, 'rebagging');
  perform public.assert_actor(p_user, o.company_id, 'rebagging.post', o.branch_id);
  if o.document_status <> 'draft' then raise exception 'Only a draft order can be issued (it is %)', o.document_status using errcode = 'P0001'; end if;
  if not public.claim_idempotency(p_idem, 'issue_rebag_order', p_id) then return p_id; end if;
  d := coalesce(o.issue_date, o.order_date);
  perform public.assert_period_open(o.company_id, d);
  perform public._rebag_lock(p_id);
  perform public._rebag_issue(p_id, p_user, d);
  return p_id;
end; $$;

-- ---------------------------------------------------------------------------
-- 4. Completion
-- ---------------------------------------------------------------------------
create or replace function public.complete_rebag_order(p_id uuid, p_user uuid, p_idem text)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  o public.rebag_orders; bulk public.products; co uuid; br uuid; d date; tol numeric; allowed numeric(18,4);
  out_kg numeric(18,4); out_bags numeric(18,4); n_out int; loss numeric(18,4);
  ret_val numeric(18,2) := 0; abn_val numeric(18,2) := 0; bulk_to_out numeric(18,2);
  t jsonb; a record; ip record; op record; s record; pv numeric(18,2); jl jsonb := '[]'::jsonb;
  pk_total numeric(18,2) := 0; conv_cap numeric(18,2) := 0; out_total numeric(18,2) := 0; mid uuid; lot uuid;
  accrued_any boolean := false; run uuid; good numeric(18,4); need numeric(18,4); from_status text; lb record;
begin
  perform public._require_key(p_idem);
  select * into o from public.rebag_orders where id = p_id for update;
  if not found then raise exception 'Rebag order not found' using errcode = 'P0001'; end if;
  if public._is_replay(p_idem, 'complete_rebag_order', p_id) then return p_id; end if;
  co := o.company_id; br := o.branch_id; from_status := o.document_status;
  perform public.assert_feature(co, 'rebagging');
  perform public.assert_actor(p_user, co, 'rebagging.post', br);
  if o.document_status not in ('draft','issued') then
    raise exception 'Rebag order is already %', o.document_status using errcode = 'P0001'; end if;
  select * into bulk from public.products where id = o.bulk_product_id;
  select count(*), coalesce(sum(net_kg), 0), coalesce(sum(bags), 0) into n_out, out_kg, out_bags
    from public.rebag_outputs where order_id = p_id;
  if n_out = 0 then raise exception 'Record at least one packaged output' using errcode = 'P0001'; end if;
  if o.document_status = 'draft' then
    select coalesce(sum(quantity), 0) into good from public.rebag_inputs where order_id = p_id and input_kind = 'bulk';
    if good <= 0 then raise exception 'Enter the bulk kg issued to rebagging' using errcode = 'P0001'; end if;
    o.issued_kg := good;
  end if;
  if o.returned_kg < 0 or o.normal_loss_kg < 0 or o.abnormal_loss_kg < 0 then
    raise exception 'Quantities cannot be negative' using errcode = 'P0001'; end if;
  loss := o.normal_loss_kg + o.abnormal_loss_kg;
  if o.issued_kg <> out_kg + o.returned_kg + loss then
    raise exception 'Bulk does not balance: % kg issued <> % kg packed + % kg returned + % kg loss (difference % kg)',
      o.issued_kg, out_kg, o.returned_kg, loss, o.issued_kg - out_kg - o.returned_kg - loss using errcode = 'P0001';
  end if;
  tol := coalesce(bulk.rebag_loss_tolerance_pct, 0);
  allowed := round(o.issued_kg * tol / 100, 4);
  if o.normal_loss_kg > allowed then
    raise exception 'Normal loss % kg exceeds the approved tolerance of % kg (% %%); record % kg as abnormal loss',
      o.normal_loss_kg, allowed, tol, o.normal_loss_kg - allowed using errcode = 'P0001';
  end if;
  if o.abnormal_loss_kg > 0 then
    perform public.assert_actor(p_user, co, 'rebagging.approve', br);
  end if;
  -- Packaging reconciles: consumed - damaged = good bags x quantity per bag.
  for ip in select * from public.rebag_inputs where order_id = p_id and input_kind = 'packaging' order by line_no, id loop
    if ip.qty_per_bag is not null then
      good := ip.quantity - ip.damaged_qty;
      need := case when ip.target_output_id is not null
                then (select bags from public.rebag_outputs where id = ip.target_output_id) else out_bags end * ip.qty_per_bag;
      if good <> need then
        raise exception 'Packaging % does not reconcile: % used - % damaged = % good, but % bags need %',
          (select name from public.products where id = ip.product_id), ip.quantity, ip.damaged_qty, good,
          case when ip.target_output_id is not null then (select bags from public.rebag_outputs where id = ip.target_output_id) else out_bags end, need
          using errcode = 'P0001';
      end if;
    end if;
  end loop;
  for s in select * from public.cost_sources where rebag_order_id = p_id and status <> 'voided' loop
    if s.status <> 'estimated' then raise exception 'Conversion charge % is already %', coalesce(s.description, 'cost'), s.status using errcode = 'P0001'; end if;
    if s.estimated_amount <= 0 then
      raise exception 'Enter the amount of conversion charge "%" or remove it', coalesce(s.description, 'cost') using errcode = 'P0001'; end if;
  end loop;
  if not public.claim_idempotency(p_idem, 'complete_rebag_order', p_id) then return p_id; end if;
  d := coalesce(o.completion_date, o.order_date);
  perform public.assert_period_open(co, d);
  perform public._rebag_lock(p_id);
  if from_status = 'draft' then
    perform public._rebag_issue(p_id, p_user, coalesce(o.issue_date, d));
  end if;
  select * into o from public.rebag_orders where id = p_id;
  perform set_config('letiq.rebag_posting', 'on', true);

  -- Unused bulk back to bulk stock at the issue value; batches restored pro rata.
  if o.returned_kg > 0 then
    ret_val := case when o.returned_kg = o.issued_kg then o.issued_value else round(o.issued_value * o.returned_kg / o.issued_kg, 2) end;
    perform public._stock_in_value(co, br, o.bulk_product_id, 'rebag_return', 'rebag_order', o.id, o.document_number, o.returned_kg, ret_val, p_user);
    for lb in select ri.lot_id, ri.quantity from public.rebag_inputs ri where ri.order_id = p_id and ri.input_kind = 'bulk' and ri.lot_id is not null loop
      update public.stock_lot_balances set quantity = quantity + round(lb.quantity * o.returned_kg / o.issued_kg, 4)
        where branch_id = br and product_id = o.bulk_product_id and lot_id = lb.lot_id;
    end loop;
  end if;
  -- Abnormal loss is expensed at the issue cost; normal loss stays in the outputs.
  if o.abnormal_loss_kg > 0 then
    abn_val := round(o.issued_value * o.abnormal_loss_kg / o.issued_kg, 2);
  end if;
  bulk_to_out := o.issued_value - ret_val - abn_val;
  select jsonb_agg(jsonb_build_object('id', id, 'factor', net_kg)) into t from public.rebag_outputs where order_id = p_id;
  for a in select * from public.allocate_amount(bulk_to_out, 'weight', t) loop
    update public.rebag_outputs set bulk_value = a.amount, packaging_value = 0, conversion_value = 0 where id = a.target_id;
  end loop;

  -- Packaging actually consumed, at weighted average; direct to its output,
  -- common materials by bag count.
  for ip in select * from public.rebag_inputs where order_id = p_id and input_kind = 'packaging' order by product_id, line_no, id loop
    pv := public._stock_out_avg(co, br, ip.product_id, 'rebag_consume', 'rebag_order', o.id, o.document_number, ip.quantity, p_user);
    update public.rebag_inputs set value_tzs = pv where id = ip.id;
    pk_total := pk_total + pv;
    if ip.target_output_id is not null then
      update public.rebag_outputs set packaging_value = packaging_value + pv where id = ip.target_output_id;
    else
      select jsonb_agg(jsonb_build_object('id', id, 'factor', bags)) into t from public.rebag_outputs where order_id = p_id;
      for a in select * from public.allocate_amount(pv, 'quantity', t) loop
        update public.rebag_outputs set packaging_value = packaging_value + a.amount where id = a.target_id;
      end loop;
    end if;
  end loop;

  -- Conversion charges: accrued now (Cr 2140); the supplier's invoice later
  -- replaces the accrual and only the difference changes cost.
  for s in select * from public.cost_sources where rebag_order_id = p_id and status = 'estimated' order by id for update loop
    if s.inventory_treatment = 'capitalize' then
      t := public._rebag_targets(p_id, s.allocation_basis, s.allocation_targets);
      insert into public.cost_allocation_runs(company_id, cost_source_id, amount_kind, basis, total_amount, is_current, created_by)
        values (co, s.id, 'accrued', s.allocation_basis, s.estimated_amount, true, p_user) returning id into run;
      for a in select * from public.allocate_amount(s.estimated_amount, 'value', t) loop
        update public.rebag_outputs set conversion_value = conversion_value + a.amount where id = a.target_id;
        insert into public.cost_allocations(company_id, run_id, target_type, target_id, factor, amount)
          values (co, run, 'rebag_output', a.target_id, (select (x->>'factor')::numeric from jsonb_array_elements(t) x where (x->>'id')::uuid = a.target_id), a.amount);
      end loop;
      conv_cap := conv_cap + s.estimated_amount;
    else
      jl := jl || public._jl(s.expense_account_id, s.estimated_amount, 'Rebagging charge (expensed): ' || coalesce(s.description, ''));
    end if;
    jl := jl || public._jl(public.account_for(co, 'import.accrued_costs'), -s.estimated_amount, 'Accrued rebagging charge');
    update public.cost_sources set status = 'accrued', accrued_amount = s.estimated_amount, accrual_date = d, updated_by = p_user where id = s.id;
    accrued_any := true;
  end loop;

  -- Outputs into packaged stock (weighted-average receipt), each with a lot
  -- traced to the bulk batches.
  for op in select * from public.rebag_outputs where order_id = p_id order by line_no, id loop
    pv := op.bulk_value + op.packaging_value + op.conversion_value;
    mid := public._stock_in_value(co, br, op.product_id, 'rebag_produce', 'rebag_order', o.id, o.document_number, op.bags, pv, p_user);
    insert into public.stock_lots(company_id, product_id, origin_type, origin_id, original_quantity, lot_code)
      values (co, op.product_id, 'rebag_output', op.id, op.bags, o.document_number || '-' || op.line_no) returning id into lot;
    insert into public.stock_lot_balances(company_id, branch_id, product_id, lot_id, quantity) values (co, br, op.product_id, lot, op.bags);
    insert into public.stock_lot_flows(company_id, movement_id, flow_type, from_lot_id, to_lot_id, branch_id, quantity)
      select co, mid, 'rebag_produce', ri.lot_id, lot, br, round(op.net_kg * ri.quantity / o.issued_kg, 4)
      from public.rebag_inputs ri where ri.order_id = p_id and ri.input_kind = 'bulk' and ri.lot_id is not null
        and round(op.net_kg * ri.quantity / o.issued_kg, 4) > 0;
    update public.rebag_outputs set value_tzs = pv, movement_id = mid, lot_id = lot where id = op.id;
    out_total := out_total + pv;
  end loop;
  if out_total <> bulk_to_out + pk_total + conv_cap then
    raise exception 'Internal: output value % does not equal inputs %', out_total, bulk_to_out + pk_total + conv_cap using errcode = 'P0001';
  end if;

  jl := public._jl(public.account_for(co, 'inventory.packaged'), out_total, 'Packaged output ' || o.document_number)
     || public._jl(public.account_for(co, 'inventory.bulk'), -(o.issued_value - ret_val), 'Bulk consumed (incl. loss)')
     || public._jl(public.account_for(co, 'inventory.loss'), abn_val, 'Abnormal rebagging loss')
     || public._jl(public.account_for(co, 'inventory.packaging'), -pk_total, 'Packaging materials consumed')
     || jl;
  perform public.create_journal(co, br, d, 'rebag_order', o.id, o.document_number, 'Rebagging ' || o.document_number, p_user, jl);

  update public.rebag_orders set document_status = 'completed', completion_date = d, returned_value = ret_val,
    abnormal_loss_value = abn_val, loss_tolerance_pct = tol, packaging_value = pk_total, conversion_value = conv_cap,
    output_value = out_total, abnormal_approved_by = case when o.abnormal_loss_kg > 0 then p_user end,
    cost_status = case when accrued_any then 'provisional' else 'finalized' end,
    posted_at = now(), posted_by = p_user, updated_by = p_user
    where id = p_id;
  perform set_config('letiq.rebag_posting', 'off', true);
  insert into public.transaction_status_history(company_id, source_type, source_id, from_status, to_status, changed_by)
    values (co, 'rebag_order', p_id, 'issued', 'completed', p_user);
  return p_id;
end; $$;

-- ---------------------------------------------------------------------------
-- 5. Cancellation (before production) and protected void (after)
-- ---------------------------------------------------------------------------
create or replace function public.cancel_rebag_order(p_id uuid, p_user uuid, p_reason text, p_idem text)
returns uuid language plpgsql security definer set search_path = public as $$
declare o public.rebag_orders; ln record;
begin
  perform public._require_key(p_idem);
  select * into o from public.rebag_orders where id = p_id for update;
  if not found then raise exception 'Rebag order not found' using errcode = 'P0001'; end if;
  if public._is_replay(p_idem, 'cancel_rebag_order', p_id) then return p_id; end if;
  perform public.assert_feature(o.company_id, 'rebagging');
  perform public.assert_actor(p_user, o.company_id, 'rebagging.post', o.branch_id);
  if o.document_status not in ('draft','issued') then
    raise exception 'Only a draft or issued order can be cancelled (it is %); a completed order is voided', o.document_status using errcode = 'P0001'; end if;
  if coalesce(trim(p_reason), '') = '' then raise exception 'A reason is required' using errcode = 'P0001'; end if;
  if not public.claim_idempotency(p_idem, 'cancel_rebag_order', p_id) then return p_id; end if;
  if o.document_status = 'issued' then
    perform public.assert_period_open(o.company_id, current_date);
    perform public._rebag_lock(p_id);
    perform public._stock_in_value(o.company_id, o.branch_id, o.bulk_product_id, 'rebag_return', 'rebag_order', o.id, o.document_number,
      o.issued_kg, o.issued_value, p_user);
    for ln in select * from public.rebag_inputs where order_id = p_id and input_kind = 'bulk' and lot_id is not null loop
      update public.stock_lot_balances set quantity = quantity + ln.quantity
        where branch_id = o.branch_id and product_id = o.bulk_product_id and lot_id = ln.lot_id;
    end loop;
  end if;
  update public.cost_sources set status = 'voided', updated_by = p_user where rebag_order_id = p_id and status = 'estimated';
  perform set_config('letiq.rebag_posting', 'on', true);
  update public.rebag_orders set document_status = 'cancelled', returned_kg = case when o.document_status = 'issued' then o.issued_kg else 0 end,
    returned_value = case when o.document_status = 'issued' then o.issued_value else 0 end,
    cancelled_at = now(), cancelled_by = p_user, void_reason = trim(p_reason), updated_by = p_user where id = p_id;
  perform set_config('letiq.rebag_posting', 'off', true);
  insert into public.transaction_status_history(company_id, source_type, source_id, from_status, to_status, reason, changed_by)
    values (o.company_id, 'rebag_order', p_id, o.document_status, 'cancelled', trim(p_reason), p_user);
  return p_id;
end; $$;

-- Documents that took bags of an output and are not reversed.
create or replace function public.rebag_order_dependents(p_id uuid)
returns table(source_type text, source_number text, quantity numeric)
language sql stable security definer set search_path = public as $$
  select m.movement_type, coalesce(m.source_number, m.source_id::text), m.qty_out
  from public.rebag_outputs op
  join public.rebag_orders o on o.id = op.order_id
  join public.stock_movements p on p.id = op.movement_id
  join public.stock_movements m on m.company_id = o.company_id and m.branch_id = o.branch_id and m.product_id = op.product_id
    and (m.created_at, m.id) > (p.created_at, p.id) and m.qty_out > 0 and m.movement_type <> 'rebag_void'
  where op.order_id = p_id
    and m.qty_out > coalesce((select sum(r.qty_in) from public.stock_movements r
          where r.branch_id = m.branch_id and r.product_id = m.product_id and r.qty_in > 0
            and ((r.movement_type in ('sale_void','transfer_void','adjustment_void') and r.source_id = m.source_id)
              or (r.movement_type = 'sales_return' and m.movement_type = 'sale'
                  and r.source_id in (select id from public.sales_returns where sale_id = m.source_id)))), 0);
$$;

create or replace function public.void_rebag_order(p_id uuid, p_user uuid, p_reason text, p_idem text)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  o public.rebag_orders; co uuid; br uuid; dep text; op record; ip record; removed numeric(18,2); diff numeric(18,2) := 0;
  j uuid; jl record; lines jsonb := '[]'::jsonb; ln record;
begin
  perform public._require_key(p_idem);
  select * into o from public.rebag_orders where id = p_id for update;
  if not found then raise exception 'Rebag order not found' using errcode = 'P0001'; end if;
  if public._is_replay(p_idem, 'void_rebag_order', p_id) then return p_id; end if;
  co := o.company_id; br := o.branch_id;
  perform public.assert_feature(co, 'rebagging');
  perform public.assert_actor(p_user, co, 'rebagging.void', br);
  if o.document_status <> 'completed' then
    raise exception 'Only a completed order can be voided (it is %)', o.document_status using errcode = 'P0001'; end if;
  if coalesce(trim(p_reason), '') = '' then raise exception 'A reason is required' using errcode = 'P0001'; end if;
  perform public._rebag_lock(p_id);
  select string_agg(source_type || ' ' || source_number || ' (' || quantity::numeric(18,0) || ')', ', ') into dep
    from public.rebag_order_dependents(p_id);
  if dep is not null then
    raise exception 'Bags from this order were already used: %. Reverse those documents first', dep using errcode = 'P0001'; end if;
  if exists (select 1 from public.cost_sources where rebag_order_id = p_id and status = 'invoiced') then
    raise exception 'A conversion charge of this order has its supplier invoice; it cannot be voided' using errcode = 'P0001'; end if;
  if exists (select 1 from public.rebag_outputs where order_id = p_id and cost_delta_tzs <> 0) then
    raise exception 'Later cost adjustments reached this order''s bags; it cannot be voided' using errcode = 'P0001'; end if;
  if not public.claim_idempotency(p_idem, 'void_rebag_order', p_id) then return p_id; end if;
  perform public.assert_period_open(co, current_date);
  perform set_config('letiq.rebag_posting', 'on', true);

  for op in select * from public.rebag_outputs where order_id = p_id order by line_no, id loop
    removed := public._stock_out_value(co, br, op.product_id, 'rebag_void', 'rebag_order', o.id, o.document_number, op.bags, op.value_tzs, p_user);
    diff := diff + (op.value_tzs - removed);
    update public.stock_lot_balances set quantity = greatest(quantity - op.bags, 0) where lot_id = op.lot_id and branch_id = br;
  end loop;
  if o.issued_kg - o.returned_kg > 0 then
    perform public._stock_in_value(co, br, o.bulk_product_id, 'rebag_void', 'rebag_order', o.id, o.document_number,
      o.issued_kg - o.returned_kg, o.issued_value - o.returned_value, p_user);
    for ln in select * from public.rebag_inputs where order_id = p_id and input_kind = 'bulk' and lot_id is not null loop
      update public.stock_lot_balances set quantity = quantity + ln.quantity - round(ln.quantity * o.returned_kg / o.issued_kg, 4)
        where branch_id = br and product_id = o.bulk_product_id and lot_id = ln.lot_id;
    end loop;
  end if;
  for ip in select * from public.rebag_inputs where order_id = p_id and input_kind = 'packaging' order by product_id, line_no, id loop
    perform public._stock_in_value(co, br, ip.product_id, 'rebag_void', 'rebag_order', o.id, o.document_number, ip.quantity, ip.value_tzs, p_user);
  end loop;

  -- Mirror the completion journal; any output value no longer in stock goes to price variance.
  select id into j from public.journal_entries where source_type = 'rebag_order' and source_id = p_id order by created_at limit 1;
  for jl in select account_id, debit d, credit c, memo from public.journal_lines where journal_id = j order by line_no loop
    lines := lines || jsonb_build_object('account_id', jl.account_id, 'debit', jl.c, 'credit', jl.d, 'memo', 'Reversal: ' || coalesce(jl.memo, ''));
  end loop;
  lines := lines || public._jl(public.account_for(co, 'inventory.packaged'), diff, 'Output value difference')
                 || public._jl(public.account_for(co, 'inventory.price_variance'), -diff, 'Output value difference');
  perform public.create_journal(co, br, current_date, 'rebag_void', o.id, o.document_number, 'Void rebagging ' || o.document_number, p_user, lines);

  update public.cost_sources set status = 'voided', updated_by = p_user where rebag_order_id = p_id and status in ('estimated','accrued');
  update public.rebag_orders set document_status = 'voided', voided_at = now(), voided_by = p_user, void_reason = trim(p_reason), updated_by = p_user
    where id = p_id;
  perform set_config('letiq.rebag_posting', 'off', true);
  insert into public.transaction_status_history(company_id, source_type, source_id, from_status, to_status, reason, changed_by)
    values (co, 'rebag_order', p_id, 'completed', 'voided', trim(p_reason), p_user);
  return p_id;
end; $$;

-- ---------------------------------------------------------------------------
-- 6. Late costs through conversion
-- ---------------------------------------------------------------------------
-- A cost amount that belongs to units of p_product consumed by a rebag order
-- (bulk or a packaging material) follows them into the order's outputs.
create or replace function public._propagate_rebag(
  p_order uuid, p_product uuid, p_amount numeric, p_src_type text, p_src_id uuid, p_docnum text, p_user uuid, p_depth int
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  o public.rebag_orders; t jsonb := '[]'::jsonb; a record; op record; ip record; jl jsonb := '[]'::jsonb;
  consumed numeric; f numeric; out_bags numeric; loss_id uuid := gen_random_uuid(); mv public.stock_movements;
begin
  if p_amount = 0 then return '[]'::jsonb; end if;
  select * into o from public.rebag_orders where id = p_order for update;
  if o.document_status = 'issued' then
    -- Still in production: the bulk held on the order carries the cost.
    perform set_config('letiq.rebag_posting', 'on', true);
    update public.rebag_orders set issued_value = issued_value + p_amount, issue_unit_cost = round((issued_value + p_amount) / issued_kg, 4)
      where id = p_order;
    perform set_config('letiq.rebag_posting', 'off', true);
    return public._jl(public.account_for(o.company_id, 'inventory.bulk'), p_amount, 'Late cost to bulk in rebagging ' || o.document_number);
  end if;
  if o.document_status <> 'completed' then
    return public._jl(public.account_for(o.company_id, 'inventory.cost_of_sales'), p_amount, 'Late cost (reversed rebagging)');
  end if;
  if p_product = o.bulk_product_id then
    -- Consumed kg = packed kg + normal loss + abnormal loss. Outputs carry the
    -- packed kg plus the normal loss (in proportion to kg); abnormal loss is
    -- expensed, as at completion.
    consumed := o.issued_kg - o.returned_kg;
    select sum(net_kg) into f from public.rebag_outputs where order_id = p_order;
    for op in select * from public.rebag_outputs where order_id = p_order order by line_no, id loop
      t := t || jsonb_build_object('id', op.id, 'factor', op.net_kg * (consumed - o.abnormal_loss_kg) / f);
    end loop;
    if o.abnormal_loss_kg > 0 then t := t || jsonb_build_object('id', loss_id, 'factor', o.abnormal_loss_kg); end if;
  else
    select sum(bags) into out_bags from public.rebag_outputs where order_id = p_order;
    for op in select * from public.rebag_outputs where order_id = p_order order by line_no, id loop
      f := 0;
      for ip in select * from public.rebag_inputs where order_id = p_order and input_kind = 'packaging' and product_id = p_product loop
        f := f + case when ip.target_output_id = op.id then ip.quantity
                      when ip.target_output_id is null then ip.quantity * op.bags / out_bags else 0 end;
      end loop;
      if f > 0 then t := t || jsonb_build_object('id', op.id, 'factor', f); end if;
    end loop;
  end if;
  if jsonb_array_length(t) = 0 then
    return public._jl(public.account_for(o.company_id, 'inventory.cost_of_sales'), p_amount, 'Late cost (untraced rebagging)');
  end if;
  for a in select * from public.allocate_amount(round(p_amount, 2), 'quantity', t) loop
    if a.target_id = loss_id then
      jl := jl || public._jl(public.account_for(o.company_id, 'inventory.loss'), a.amount, 'Late cost to abnormal rebagging loss');
      continue;
    end if;
    select * into op from public.rebag_outputs where id = a.target_id;
    select * into mv from public.stock_movements where id = op.movement_id;
    perform set_config('letiq.rebag_posting', 'on', true);
    update public.rebag_outputs set cost_delta_tzs = cost_delta_tzs + a.amount where id = op.id;
    perform set_config('letiq.rebag_posting', 'off', true);
    jl := jl || public._propagate_from_movement(o.company_id, o.branch_id, op.product_id, mv.created_at, mv.id, op.bags, a.amount,
                  p_src_type, p_src_id, p_docnum, p_user, p_depth + 1);
  end loop;
  return jl;
end; $$;

-- Replay with rebagging: rebag issues / packaging consumption are tracked per
-- order like sales; units handed back (returned bulk, cancellation, void)
-- rejoin the pool; units kept by a completed order follow it into its outputs.
create or replace function public._propagate_from_movement(
  p_company uuid, p_branch uuid, p_product uuid, p_start_at timestamptz, p_start_id uuid,
  p_units numeric, p_amount numeric, p_src_type text, p_src_id uuid, p_docnum text, p_user uuid, p_depth int default 0
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  mv record; remaining numeric := p_units; take numeric; before numeric; parts jsonb := '[]'::jsonb;
  s record; jl jsonb := '[]'::jsonb; unabsorbed numeric(18,2); kind text;
  sold jsonb := '{}'::jsonb; doc uuid; tot numeric; back numeric; k text; typ text;
begin
  if p_amount = 0 or p_units <= 0 then return '[]'::jsonb; end if;
  if p_depth > 10 then raise exception 'Cost propagation chain too deep' using errcode = 'P0001'; end if;
  for mv in select * from public.stock_movements
            where company_id = p_company and branch_id = p_branch and product_id = p_product
              and (created_at, id) > (p_start_at, p_start_id)
              and ((qty_out > 0 and movement_type <> 'rebag_void')
                or (qty_in > 0 and movement_type in ('sale_void','sales_return','rebag_return','rebag_void')))
            order by created_at, id loop
    if mv.qty_in > 0 then
      if mv.movement_type in ('sale_void','sales_return') then
        typ := 'sale';
        doc := case when mv.movement_type = 'sale_void' then mv.source_id
                    else (select r.sale_id from public.sales_returns r where r.id = mv.source_id) end;
      else
        typ := 'rebag'; doc := mv.source_id;
      end if;
      k := doc::text;
      if doc is null or not (sold ? k) then continue; end if;
      select coalesce(sum(qty_out), 0) into tot from public.stock_movements
        where source_id = doc and branch_id = p_branch and product_id = p_product
          and movement_type = any(case when typ = 'sale' then array['sale'] else array['rebag_issue','rebag_consume'] end);
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
      sold := jsonb_set(sold, array[k], jsonb_build_object(
                'orig', coalesce((sold->k->>'orig')::numeric, 0) + take,
                'cur',  coalesce((sold->k->>'cur')::numeric, 0) + take,
                'typ',  case when mv.movement_type = 'sale' then 'sale' else 'rebag' end));
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
      parts := parts || jsonb_build_object('id', gen_random_uuid(),
                 'kind', case when sold->k->>'typ' = 'sale' then 'cogs' else 'rebag' end,
                 'factor', (sold->k->>'cur')::numeric, 'doc', k);
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
    elsif kind = 'rebag' then
      jl := jl || public._propagate_rebag((s.part->>'doc')::uuid, p_product, s.amount, p_src_type, p_src_id, p_docnum, p_user, p_depth);
    else
      jl := jl || public._propagate_transfer((s.part->>'mv')::uuid, (s.part->>'factor')::numeric, s.amount,
                    p_src_type, p_src_id, p_docnum, p_user, p_depth);
    end if;
  end loop;
  return jl;
end; $$;

-- A conversion-charge difference (actual invoice vs accrual, credit notes,
-- charges added after completion): to the outputs by the charge's basis, then
-- wherever those bags went.
create or replace function public._apply_rebag_delta(
  p_source uuid, p_delta numeric, p_date date, p_src_type text, p_src_id uuid, p_docnum text, p_user uuid
) returns jsonb language plpgsql security definer set search_path = public as $$
declare s public.cost_sources; o public.rebag_orders; t jsonb; a record; op record; mv public.stock_movements; jl jsonb := '[]'::jsonb; run uuid;
begin
  if p_delta = 0 then return '[]'::jsonb; end if;
  select * into s from public.cost_sources where id = p_source for update;
  select * into o from public.rebag_orders where id = s.rebag_order_id for update;
  t := public._rebag_targets(o.id, s.allocation_basis, s.allocation_targets);
  insert into public.cost_allocation_runs(company_id, cost_source_id, amount_kind, basis, total_amount, is_current, created_by)
    values (s.company_id, s.id, 'delta', s.allocation_basis, p_delta, false, p_user) returning id into run;
  for a in select * from public.allocate_amount(round(p_delta, 2), 'value', t) loop
    insert into public.cost_allocations(company_id, run_id, target_type, target_id, factor, amount)
      values (s.company_id, run, 'rebag_output', a.target_id, (select (x->>'factor')::numeric from jsonb_array_elements(t) x where (x->>'id')::uuid = a.target_id), a.amount);
    select * into op from public.rebag_outputs where id = a.target_id;
    select * into mv from public.stock_movements where id = op.movement_id;
    perform set_config('letiq.rebag_posting', 'on', true);
    update public.rebag_outputs set cost_delta_tzs = cost_delta_tzs + a.amount where id = op.id;
    perform set_config('letiq.rebag_posting', 'off', true);
    jl := jl || public._propagate_from_movement(o.company_id, o.branch_id, op.product_id, mv.created_at, mv.id, op.bags, a.amount,
                  p_src_type, p_src_id, p_docnum, p_user, 1);
  end loop;
  return jl;
end; $$;


-- ---------------------------------------------------------------------------
-- 7. Cost invoices also settle rebagging charges (accrued at completion).
-- Same rules as imports: a capitalised line must link its charge; the actual
-- replaces the accrual and only the difference changes cost; one actual per
-- charge, so a contractor invoice can never be expensed twice.
-- ---------------------------------------------------------------------------
create or replace function public.post_cost_invoice(p_id uuid, p_user uuid, p_idem text)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  ci public.cost_invoices; cr public.cost_invoices; ln record; s public.cost_sources; cat public.cost_categories;
  sh public.import_shipments; ro public.rebag_orders; pb public.supplier_payables; docnum text; sgn int;
  rec numeric(18,2); nonrec numeric(18,2); cost numeric(18,2); delta numeric(18,2); acc numeric(18,2);
  v_net numeric(18,2) := 0; v_tax numeric(18,2) := 0; v_grand numeric(18,2) := 0; jl jsonb := '[]'::jsonb;
begin
  perform public._require_key(p_idem);
  select * into ci from public.cost_invoices where id = p_id for update;
  if not found then raise exception 'Cost invoice not found' using errcode = 'P0001'; end if;
  if public._is_replay(p_idem, 'post_cost_invoice', p_id) then return p_id; end if;
  if ci.document_status <> 'draft' then raise exception 'Cost invoice already %', ci.document_status using errcode = 'P0001'; end if;
  if not (public.feature_enabled(ci.company_id, 'imports') or public.feature_enabled(ci.company_id, 'rebagging')) then
    raise exception 'The imports feature is not enabled for this company' using errcode = 'P0001'; end if;
  perform public.assert_actor(p_user, ci.company_id, 'cost_invoices.post', ci.branch_id);
  if not exists (select 1 from public.cost_invoice_lines where cost_invoice_id = p_id) then
    raise exception 'Cost invoice has no lines' using errcode = 'P0001'; end if;
  sgn := case when ci.document_kind = 'invoice' then 1 else -1 end;
  if sgn < 0 then
    select * into cr from public.cost_invoices where id = ci.credited_invoice_id;
    if cr.document_status <> 'posted' then raise exception 'The credited invoice must be posted' using errcode = 'P0001'; end if;
  end if;
  if not public.claim_idempotency(p_idem, 'post_cost_invoice', p_id) then return p_id; end if;
  perform public.assert_period_open(ci.company_id, ci.document_date);
  docnum := public.next_document_number(ci.company_id, ci.branch_id, 'cost_invoice');

  for ln in select * from public.cost_invoice_lines where cost_invoice_id = p_id order by cost_source_id nulls last, line_no, id loop
    rec := case when ln.is_recoverable then ln.tax_amount else 0 end; nonrec := ln.tax_amount - rec;
    cost := round(ln.net_amount + nonrec, 2);
    v_net := v_net + ln.net_amount; v_tax := v_tax + ln.tax_amount;
    jl := jl || public._jl(public.account_for(ci.company_id, 'tax.input_vat'), sgn * rec, 'Input VAT');
    select * into cat from public.cost_categories where id = ln.cost_category_id;
    if ln.cost_source_id is null then
      if cat.inventory_treatment = 'capitalize' then
        raise exception 'Line "%": a capitalised cost must be linked to a shipment or rebagging cost line', coalesce(ln.description, cat.name) using errcode = 'P0001';
      end if;
      jl := jl || public._jl(cat.expense_account_id, sgn * cost, coalesce(ln.description, cat.name));
      continue;
    end if;
    select * into s from public.cost_sources where id = ln.cost_source_id for update;
    if s.cost_category_id <> ln.cost_category_id then raise exception 'Line category must match the linked cost' using errcode = 'P0001'; end if;
    if s.status = 'voided' then raise exception 'The linked cost is voided' using errcode = 'P0001'; end if;
    sh := null; ro := null;
    if s.owner_type = 'import_shipment' then
      perform public.assert_feature(ci.company_id, 'imports');
      select * into sh from public.import_shipments where id = s.import_shipment_id for update;
    elsif s.owner_type = 'rebag_order' then
      perform public.assert_feature(ci.company_id, 'rebagging');
      select * into ro from public.rebag_orders where id = s.rebag_order_id for update;
      if ro.document_status <> 'completed' then
        raise exception 'Rebagging order % is %; its charges are invoiced after completion', coalesce(ro.document_number, 'draft'), ro.document_status
          using errcode = 'P0001'; end if;
    else
      raise exception 'Only import shipment and rebagging costs are supported here' using errcode = 'P0001';
    end if;
    if sgn > 0 then
      if exists (select 1 from public.cost_source_actuals where cost_source_id = s.id) then
        raise exception 'This cost already has its actual invoice; use a credit note or a new cost line' using errcode = 'P0001'; end if;
      acc := case when s.status = 'accrued' then s.accrued_amount else 0 end;
      delta := cost - acc;
      if acc > 0 then
        jl := jl || public._jl(public.account_for(ci.company_id, 'import.accrued_costs'), acc, 'Accrual replaced by actual');
        if sh.id is not null then perform public._ship_ledger(sh.id, null, s.id, 'accrual', acc, 'cost_invoice', p_id, ci.document_date); end if;
      end if;
      insert into public.cost_source_actuals(cost_source_id, cost_invoice_line_id, company_id) values (s.id, ln.id, ci.company_id);
      update public.cost_sources set status = 'invoiced', actual_amount = cost, supplier_id = coalesce(supplier_id, ci.supplier_id), updated_by = p_user where id = s.id;
    else
      if s.status <> 'invoiced' then raise exception 'A credit note can only adjust an invoiced cost' using errcode = 'P0001'; end if;
      if cost > s.actual_amount then raise exception 'Credit exceeds the invoiced cost' using errcode = 'P0001'; end if;
      delta := -cost;
      update public.cost_sources set actual_amount = actual_amount - cost, updated_by = p_user where id = s.id;
    end if;
    if s.inventory_treatment = 'capitalize' then
      if ro.id is not null then
        jl := jl || public._apply_rebag_delta(s.id, delta, ci.document_date, 'cost_invoice', p_id, docnum, p_user);
      else
        jl := jl || public._apply_source_delta(s.id, delta, ci.document_date, 'cost_invoice', p_id, docnum, p_user);
      end if;
    else
      jl := jl || public._jl(s.expense_account_id, delta, coalesce(ln.description, cat.name));
      if sh.id is not null then perform public._ship_ledger(sh.id, null, s.id, 'expense', delta, 'cost_invoice', p_id, ci.document_date); end if;
    end if;
    if sh.id is not null then
      update public.import_shipments set cost_status = case when cost_status = 'finalized' then 'adjusted'
        when cost_status = 'estimated' then 'provisional' else cost_status end where id = sh.id;
    else
      perform set_config('letiq.rebag_posting', 'on', true);
      update public.rebag_orders set cost_status = case
          when cost_status in ('finalized','adjusted') then 'adjusted'
          when not exists (select 1 from public.cost_sources where rebag_order_id = ro.id and status in ('estimated','accrued')) then 'finalized'
          else cost_status end
        where id = ro.id;
      perform set_config('letiq.rebag_posting', 'off', true);
    end if;
  end loop;

  v_grand := round(v_net + v_tax, 2);
  if sgn > 0 then
    jl := jl || public._jl(public.account_id_by_code(ci.company_id, '2110'), -v_grand, 'Accounts payable');
  else
    select * into pb from public.supplier_payables where cost_invoice_id = cr.id for update;
    if pb.id is null or pb.outstanding < v_grand then
      raise exception 'Credit exceeds the open balance of the credited invoice' using errcode = 'P0001'; end if;
    update public.supplier_payables set outstanding = outstanding - v_grand,
      status = case when outstanding - v_grand <= 0 then 'settled' else 'partial' end where id = pb.id;
    jl := jl || public._jl(public.account_id_by_code(ci.company_id, '2110'), v_grand, 'Credit note reduces payable');
  end if;
  perform public.create_journal(ci.company_id, ci.branch_id, ci.document_date, 'cost_invoice', ci.id, docnum,
    case when sgn > 0 then 'Cost invoice ' else 'Cost credit note ' end || docnum, p_user, jl);

  update public.cost_invoices set document_status = 'posted', document_number = docnum, net_total = v_net, tax_total = v_tax,
    grand_total = v_grand, posted_at = now(), posted_by = p_user where id = p_id;
  if sgn > 0 then
    perform public.register_supplier_invoice(ci.company_id, ci.supplier_id, ci.supplier_invoice_number, 'cost_invoice', ci.id);
    if v_grand > 0 then
      insert into public.supplier_payables(company_id, branch_id, supplier_id, source_type, cost_invoice_id, original_amount, outstanding, status)
        values (ci.company_id, ci.branch_id, ci.supplier_id, 'cost_invoice', ci.id, v_grand, v_grand, 'open');
    end if;
  end if;
  return p_id;
end; $$;

-- ---------------------------------------------------------------------------
-- 8. Privileges: posting runs only through the service role.
-- ---------------------------------------------------------------------------
do $$
declare f record;
begin
  for f in select p.oid::regprocedure sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname in (
             '_stock_out_avg','_stock_out_value','_rebag_lock','_rebag_targets','_rebag_issue','issue_rebag_order',
             'complete_rebag_order','cancel_rebag_order','rebag_order_dependents','void_rebag_order',
             '_propagate_rebag','_propagate_from_movement','_apply_rebag_delta','post_cost_invoice') loop
    execute format('revoke all on function %s from public, anon, authenticated', f.sig);
    execute format('grant execute on function %s to service_role', f.sig);
  end loop;
end $$;
