-- =========================================================================
-- Elements ERP - Migration 0047: a Sales Manager may approve a Sales Request
-- they prepared or submitted themselves (permission sales.approve_own,
-- granted to the Sales Manager role only by db:seed:upgrade). Everyone else
-- still needs a second authorised manager. The approval stays one atomic
-- step and its basis is still recorded.
-- =========================================================================

create or replace function public.approve_sales_request(p_request uuid, p_user uuid, p_idem text, p_verifications jsonb, p_note text)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  rq public.sales_requests; ln record; pm record; v jsonb; rid uuid; oid uuid; docnum text;
  a record; t_sub numeric(18,2) := 0; t_disc numeric(18,2) := 0; t_net numeric(18,2) := 0; t_tax numeric(18,2) := 0; t_grand numeric(18,2) := 0;
  need numeric(18,2); avail numeric(18,2); take numeric(18,2); pr record; onhand numeric; reserved numeric;
  basis text := ''; claimed int; expected int; sku text; sel jsonb;
begin
  select * into rq from public.sales_requests where id = p_request for update;
  if not found then raise exception 'Sales request not found' using errcode = 'P0001'; end if;
  if rq.status = 'converted' and rq.sales_order_id is not null then return rq.sales_order_id; end if;
  if rq.status <> 'pending_approval' then raise exception 'Only requests awaiting approval can be approved (this one is %)', rq.status using errcode = 'P0001'; end if;
  perform public.assert_actor(p_user, rq.company_id, 'sales.approve', rq.branch_id);
  if (p_user = rq.created_by or p_user = rq.submitted_by) and not public._user_can(p_user, 'sales.approve_own') then
    raise exception 'You cannot approve a sales request you prepared or submitted; another authorised manager must approve it' using errcode = '42501';
  end if;
  if not public.claim_idempotency(p_idem, 'approve_sales_request', p_request) then
    return (select sales_order_id from public.sales_requests where id = p_request);
  end if;
  if not exists (select 1 from public.sales_request_lines where request_id = p_request) then
    raise exception 'The request has no products' using errcode = 'P0001';
  end if;

  -- 1. Totals from the lines (the request's own totals are not trusted).
  for ln in select * from public.sales_request_lines where request_id = p_request order by line_no loop
    a := public._sale_line_amounts(ln.quantity, ln.unit_price, ln.discount, ln.tax_rate, ln.tax_inclusive);
    t_sub := t_sub + round(ln.quantity * ln.unit_price, 2); t_disc := t_disc + ln.discount;
    t_net := t_net + a.net; t_tax := t_tax + a.tax; t_grand := t_grand + a.total;
  end loop;

  -- 2. Each new payment must be independently verified by the approver, then recorded once.
  for pm in select * from public.sales_request_payments where request_id = p_request order by created_at, id loop
    v := null;
    select e into v from jsonb_array_elements(coalesce(p_verifications, '[]'::jsonb)) e where e->>'payment_id' = pm.id::text;
    if v is null or coalesce(btrim(v->>'basis'), '') = '' then
      raise exception 'Payment % of % TZS is not verified. Check it against the bank or collection record and state how it was verified.', pm.reference, pm.amount using errcode = 'P0001';
    end if;
    if pm.receipt_id is null then
      rid := public._post_advance_receipt(rq.company_id, rq.branch_id, rq.customer_id, pm.payment_account_id, pm.payment_method,
        pm.payment_date, pm.amount, pm.reference, p_user, v->>'basis', 'Sales request ' || coalesce(rq.document_number, ''));
      update public.sales_request_payments set receipt_id = rid where id = pm.id;
    end if;
    basis := basis || case when basis = '' then '' else '; ' end || pm.reference || ': ' || btrim(v->>'basis');
  end loop;

  -- 3. The official order, directly approved.
  docnum := public.next_document_number(rq.company_id, rq.branch_id, 'sales_order');
  insert into public.sales_orders(company_id, branch_id, request_id, document_number, status, customer_id, contact_name, contact_phone,
      fulfilment_location, fulfilment_mode, destination, consignee_name, consignee_phone, notes, order_discount,
      subtotal, discount_total, net_total, tax_total, grand_total, approved_by, approved_at, verification_basis)
    values (rq.company_id, rq.branch_id, rq.id, docnum, 'approved', rq.customer_id, rq.contact_name, rq.contact_phone,
      rq.fulfilment_location, rq.fulfilment_mode, rq.destination, rq.consignee_name, rq.consignee_phone, rq.notes, rq.order_discount,
      t_sub, t_disc, t_net, t_tax, t_grand, p_user, now(), nullif(concat_ws(' | ', nullif(basis, ''), nullif(btrim(coalesce(p_note, '')), '')), ''))
    returning id into oid;
  for ln in select * from public.sales_request_lines where request_id = p_request order by line_no loop
    a := public._sale_line_amounts(ln.quantity, ln.unit_price, ln.discount, ln.tax_rate, ln.tax_inclusive);
    insert into public.sales_order_lines(order_id, request_line_id, line_no, product_id, description, quantity, unit_price, original_price, discount,
        tax_code_id, tax_rate, tax_type, tax_name, tax_inclusive, track_inventory, is_free, promotion_id, net_amount, tax_amount, line_total)
      values (oid, ln.id, ln.line_no, ln.product_id, ln.description, ln.quantity, ln.unit_price, ln.original_price, ln.discount,
        ln.tax_code_id, ln.tax_rate, ln.tax_type, ln.tax_name, ln.tax_inclusive, ln.track_inventory, ln.is_free, ln.promotion_id, a.net, a.tax, a.total);
  end loop;

  -- 4. Stock: on hand minus what other open orders have reserved must cover this order.
  for pr in select l.product_id, sum(l.quantity) q from public.sales_order_lines l where l.order_id = oid and l.track_inventory group by l.product_id loop
    onhand := null;
    select quantity into onhand from public.stock_balances where company_id = rq.company_id and branch_id = rq.branch_id and product_id = pr.product_id for update;
    reserved := public.sales_reserved_qty(rq.company_id, rq.branch_id, pr.product_id, oid);
    if coalesce(onhand, 0) - reserved < pr.q - 0.00005 then
      select p.sku into sku from public.products p where p.id = pr.product_id;
      raise exception 'Not enough stock for %: on hand %, reserved for other orders %, this order needs %', sku, coalesce(onhand, 0), reserved, pr.q using errcode = 'P0001';
    end if;
  end loop;

  -- 5. Commit verified funds: selected existing funds first, then the new receipts.
  select coalesce(jsonb_agg(jsonb_build_object('receipt_id', receipt_id, 'amount', amount) order by id), '[]'::jsonb) into sel
    from public.sales_request_funds where request_id = p_request;
  need := public._commit_order_funds(oid, sel, t_grand);
  for pm in select * from public.sales_request_payments where request_id = p_request and receipt_id is not null order by created_at, id loop
    exit when need <= 0;
    avail := public.customer_receipt_available(pm.receipt_id);
    take := least(avail, need);
    if take > 0 then
      insert into public.sales_order_funds(order_id, receipt_id, amount_committed) values (oid, pm.receipt_id, take);
      need := need - take;
    end if;
  end loop;
  if need > 0.004 then
    raise exception 'Verified funds do not cover the sale: order value % TZS, verified funds short by % TZS', t_grand, need using errcode = 'P0001';
  end if;

  -- 6. Free goods earned in earlier orders that this order gives out.
  select count(*) into expected from public.sales_request_lines where request_id = p_request and promotion_reward_id is not null;
  if expected > 0 then
    update public.promotion_rewards set status = 'redeemed', redeemed_at = now()
     where id in (select promotion_reward_id from public.sales_request_lines where request_id = p_request and promotion_reward_id is not null)
       and status = 'available' and customer_id = rq.customer_id;
    get diagnostics claimed = row_count;
    if claimed <> expected then raise exception 'Free goods earned earlier were already given in another order; return the request for correction' using errcode = 'P0001'; end if;
  end if;

  update public.sales_requests set status = 'converted', sales_order_id = oid, decided_by = p_user, decided_at = now(),
    subtotal = t_sub, discount_total = t_disc, net_total = t_net, tax_total = t_tax, grand_total = t_grand,
    decision_reason = nullif(btrim(coalesce(p_note, '')), ''), updated_at = now() where id = p_request;
  perform public._sales_event(rq.company_id, p_request, oid, null, 'approved', 'Sale approved: payment verified, order ' || docnum || ' created' || case when p_user in (rq.created_by, rq.submitted_by) then ' (approved by the person who prepared it)' else '' end, p_user);
  return oid;
end; $$;

revoke all on function public.approve_sales_request(uuid,uuid,text,jsonb,text) from public, anon, authenticated;
grant execute on function public.approve_sales_request(uuid,uuid,text,jsonb,text) to service_role;
