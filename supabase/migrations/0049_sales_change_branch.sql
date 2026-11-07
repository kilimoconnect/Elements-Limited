-- =========================================================================
-- Elements ERP - Migration 0049: amendment "change branch" for a Sales Order.
-- The undispatched rest of the order is reserved and fulfilled from another
-- branch. Approved by a manager of both branches (not the requester), only
-- when no truck is being loaded, and only if the new branch has the stock.
-- Trucks already dispatched keep their branch, invoice and documents.
-- =========================================================================

alter table public.sales_order_amendments drop constraint if exists sales_order_amendments_kind_check;
alter table public.sales_order_amendments add constraint sales_order_amendments_kind_check
  check (kind in ('change_lines','delivery','cancel_remaining','change_branch'));

create or replace function public.approve_sales_amendment(p_amendment uuid, p_user uuid, p_funds jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare
  am public.sales_order_amendments; o public.sales_orders; old_total numeric(18,2); new_total numeric(18,2); e jsonb; ol public.sales_order_lines;
  nq numeric; np numeric; ndisc numeric(18,2); rem numeric; a record; per_unit numeric; pr record; onhand numeric; reserved numeric;
  need numeric(18,2); excess numeric(18,2); f record; take numeric(18,2); nxt int; sku text; nb public.branches; ob public.branches;
begin
  select * into am from public.sales_order_amendments where id = p_amendment for update;
  if not found then raise exception 'Amendment not found' using errcode = 'P0001'; end if;
  select * into o from public.sales_orders where id = am.order_id for update;
  perform public.assert_actor(p_user, o.company_id, 'sales.approve', o.branch_id);
  if am.status <> 'pending' then raise exception 'This amendment was already decided' using errcode = 'P0001'; end if;
  if p_user = am.requested_by then raise exception 'Another authorised manager must approve an amendment you requested' using errcode = '42501'; end if;
  if o.status not in ('approved','in_fulfilment') then raise exception 'Order % is %', o.document_number, o.status using errcode = 'P0001'; end if;
  old_total := o.grand_total;

  if am.kind = 'delivery' then
    update public.sales_orders set
      destination = coalesce(nullif(am.changes->>'destination', ''), destination),
      consignee_name = coalesce(nullif(am.changes->>'consignee_name', ''), consignee_name),
      consignee_phone = coalesce(nullif(am.changes->>'consignee_phone', ''), consignee_phone),
      fulfilment_mode = coalesce(nullif(am.changes->>'fulfilment_mode', ''), fulfilment_mode)
     where id = o.id;
    update public.sales_shipments set
      destination = coalesce(nullif(am.changes->>'destination', ''), destination),
      consignee_name = coalesce(nullif(am.changes->>'consignee_name', ''), consignee_name),
      consignee_phone = coalesce(nullif(am.changes->>'consignee_phone', ''), consignee_phone)
     where order_id = o.id and status in ('planned','loading_order_issued','loaded');

  elsif am.kind = 'change_branch' then
    -- The rest of the order is fulfilled (reserved, loaded, dispatched) from another branch.
    select * into nb from public.branches where id = nullif(am.changes->>'branch_id', '')::uuid;
    if nb.id is null or nb.company_id <> o.company_id or not nb.is_active then raise exception 'Choose an active branch' using errcode = 'P0001'; end if;
    if nb.id = o.branch_id then raise exception 'The order is already at this branch' using errcode = 'P0001'; end if;
    perform public.assert_actor(p_user, o.company_id, 'sales.approve', nb.id);
    if exists (select 1 from public.sales_shipments where order_id = o.id and status in ('planned','loading_order_issued','loaded')) then
      raise exception 'Cancel the trucks that are not yet dispatched before changing the branch' using errcode = 'P0001';
    end if;
    for pr in select l.product_id, sum(l.quantity - l.qty_dispatched) q from public.sales_order_lines l
               where l.order_id = o.id and l.track_inventory and l.quantity > l.qty_dispatched group by l.product_id loop
      onhand := null;
      select quantity into onhand from public.stock_balances where company_id = o.company_id and branch_id = nb.id and product_id = pr.product_id for update;
      reserved := public.sales_reserved_qty(o.company_id, nb.id, pr.product_id, o.id);
      if coalesce(onhand, 0) - reserved < pr.q - 0.00005 then
        select p.sku into sku from public.products p where p.id = pr.product_id;
        raise exception 'Not enough stock at %: % available for %, the order still needs %', nb.name, coalesce(onhand, 0) - reserved, sku, pr.q using errcode = 'P0001';
      end if;
    end loop;
    select * into ob from public.branches where id = o.branch_id;
    update public.sales_orders set branch_id = nb.id,
      fulfilment_location = coalesce(nullif(btrim(coalesce(am.changes->>'fulfilment_location', '')), ''), fulfilment_location)
     where id = o.id;
    perform public._sales_event(o.company_id, null, o.id, null, 'branch_changed', 'Branch changed from ' || ob.name || ' to ' || nb.name, p_user);

  elsif am.kind = 'cancel_remaining' then
    if exists (select 1 from public.sales_shipments where order_id = o.id and status in ('planned','loading_order_issued','loaded')) then
      raise exception 'Cancel the trucks that are not yet dispatched first' using errcode = 'P0001';
    end if;
    update public.sales_order_lines set quantity = qty_dispatched, net_amount = invoiced_net, tax_amount = invoiced_tax,
      line_total = invoiced_net + invoiced_tax,
      discount = case when quantity > 0 then round(discount * qty_dispatched / quantity, 2) else 0 end
     where order_id = o.id;

  elsif am.kind = 'change_lines' then
    for e in select * from jsonb_array_elements(coalesce(am.changes->'lines', '[]'::jsonb)) loop
      select * into ol from public.sales_order_lines where id = (e->>'order_line_id')::uuid and order_id = o.id for update;
      if not found then raise exception 'A changed line is not on this order' using errcode = 'P0001'; end if;
      nq := coalesce((e->>'quantity')::numeric, ol.quantity); np := coalesce((e->>'unit_price')::numeric, ol.unit_price);
      if nq < ol.qty_dispatched + ol.qty_allocated - 0.00005 then
        raise exception '%: the quantity cannot go below what is dispatched or on trucks (%)', coalesce(ol.description, 'Product'), ol.qty_dispatched + ol.qty_allocated using errcode = 'P0001';
      end if;
      per_unit := case when ol.quantity > 0 then ol.discount / ol.quantity else 0 end;
      rem := nq - ol.qty_dispatched;
      ndisc := round(per_unit * rem, 2);
      a := public._sale_line_amounts(rem, np, least(ndisc, round(rem * np, 2)), ol.tax_rate, ol.tax_inclusive);
      update public.sales_order_lines set quantity = nq, unit_price = np, discount = round(per_unit * nq, 2),
        net_amount = invoiced_net + a.net, tax_amount = invoiced_tax + a.tax, line_total = invoiced_net + invoiced_tax + a.total
       where id = ol.id;
    end loop;
    select coalesce(max(line_no), 0) into nxt from public.sales_order_lines where order_id = o.id;
    for e in select * from jsonb_array_elements(coalesce(am.changes->'add', '[]'::jsonb)) loop
      nxt := nxt + 1;
      a := public._sale_line_amounts((e->>'quantity')::numeric, (e->>'unit_price')::numeric, coalesce((e->>'discount')::numeric, 0),
             coalesce((e->>'tax_rate')::numeric, 0), coalesce((e->>'tax_inclusive')::boolean, false));
      insert into public.sales_order_lines(order_id, line_no, product_id, description, quantity, unit_price, original_price, discount,
          tax_code_id, tax_rate, tax_type, tax_name, tax_inclusive, track_inventory, net_amount, tax_amount, line_total)
        values (o.id, nxt, (e->>'product_id')::uuid, nullif(e->>'description', ''), (e->>'quantity')::numeric, (e->>'unit_price')::numeric,
          coalesce((e->>'original_price')::numeric, (e->>'unit_price')::numeric), coalesce((e->>'discount')::numeric, 0),
          nullif(e->>'tax_code_id', '')::uuid, coalesce((e->>'tax_rate')::numeric, 0), nullif(e->>'tax_type', ''), nullif(e->>'tax_name', ''),
          coalesce((e->>'tax_inclusive')::boolean, false), coalesce((e->>'track_inventory')::boolean, true), a.net, a.tax, a.total);
    end loop;
    -- Increased quantities must still be in stock after other orders' reservations.
    for pr in select l.product_id, sum(l.quantity - l.qty_dispatched) q from public.sales_order_lines l
               where l.order_id = o.id and l.track_inventory group by l.product_id loop
      onhand := null;
      select quantity into onhand from public.stock_balances where company_id = o.company_id and branch_id = o.branch_id and product_id = pr.product_id for update;
      reserved := public.sales_reserved_qty(o.company_id, o.branch_id, pr.product_id, o.id);
      if coalesce(onhand, 0) - reserved < pr.q - 0.00005 then
        select p.sku into sku from public.products p where p.id = pr.product_id;
        raise exception 'Not enough stock for %: available %, the amended order still needs %', sku, coalesce(onhand, 0) - reserved, pr.q using errcode = 'P0001';
      end if;
    end loop;
  else
    raise exception 'Unknown amendment' using errcode = 'P0001';
  end if;

  perform public._recalc_sales_order(o.id);
  select grand_total into new_total from public.sales_orders where id = o.id;
  need := public._order_uncovered(o.id);
  if need > 0.004 then
    -- An increase needs additional verified funds before it takes effect.
    need := public._commit_order_funds(o.id, p_funds, need);
    if need > 0.004 then raise exception 'The amendment needs % TZS more verified funds', need using errcode = 'P0001'; end if;
  elsif need < -0.004 then
    -- A reduction releases committed funds back to the customer's credit, newest first.
    excess := -need;
    for f in select * from public.sales_order_funds where order_id = o.id and amount_committed - amount_applied - amount_released > 0
              order by created_at desc, id desc for update loop
      exit when excess <= 0;
      take := least(f.amount_committed - f.amount_applied - f.amount_released, excess);
      update public.sales_order_funds set amount_released = amount_released + take where id = f.id;
      excess := excess - take;
    end loop;
  end if;

  update public.sales_order_amendments set status = 'approved', decided_by = p_user, decided_at = now(), value_change = new_total - old_total where id = am.id;
  perform public._sales_event(o.company_id, null, o.id, null, 'amendment_approved',
    am.kind || case when new_total <> old_total then ', order value ' || old_total || ' -> ' || new_total else '' end, p_user);
  if am.kind = 'cancel_remaining' then
    if not exists (select 1 from public.sales_order_lines where order_id = o.id and qty_dispatched > 0) then
      update public.sales_order_funds set amount_released = amount_committed - amount_applied where order_id = o.id;
      update public.sales_orders set status = 'cancelled', cancelled_at = now(), cancelled_by = p_user, cancel_reason = am.reason where id = o.id;
      perform public._sales_event(o.company_id, null, o.id, null, 'cancelled', am.reason, p_user);
    else
      perform public._sales_order_check_completion(o.id, p_user);
    end if;
  end if;
end; $$;

revoke all on function public.approve_sales_amendment(uuid,uuid,jsonb) from public, anon, authenticated;
grant execute on function public.approve_sales_amendment(uuid,uuid,jsonb) to service_role;
