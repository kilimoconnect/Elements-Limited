-- ===========================================================================
-- 0033 — Stage 9: release hardening.
--
-- Additive only:
--   * account_mappings.created_by so the Admin → Account Mappings screen can
--     create a missing mapping (existing rows unchanged);
--   * indexes for the access paths used by posting replays, reconciliation and
--     the Stage 8 reports at realistic volumes (movements by source and pool
--     order, journals by source, trip / receipt / resolution links, lots,
--     allocations, documents).
-- ===========================================================================

alter table public.account_mappings add column if not exists created_by uuid references auth.users(id) on delete set null;

-- Stock movements: the weighted-average replay walks one pool in (created_at, id)
-- order after a start movement; many lookups go by source document only.
create index if not exists stock_movements_replay_idx on public.stock_movements(company_id, branch_id, product_id, created_at, id);
create index if not exists stock_movements_source_id_idx on public.stock_movements(source_id);

-- Journals looked up by source document alone (late-cost report, reversals).
create index if not exists journal_entries_source_id_idx on public.journal_entries(source_id);

-- Transfer trips, receipts and resolutions.
create index if not exists stdl_movement_idx on public.stock_transfer_dispatch_lines(movement_id);
create index if not exists stdl_transfer_line_idx on public.stock_transfer_dispatch_lines(transfer_line_id);
create index if not exists strl_dispatch_line_idx on public.stock_transfer_receipt_lines(dispatch_line_id);
create index if not exists strl_receipt_idx on public.stock_transfer_receipt_lines(receipt_id);
create index if not exists str_transfer_idx on public.stock_transfer_receipts(transfer_id);
create index if not exists stres_receipt_line_idx on public.stock_transfer_resolutions(receipt_line_id);

-- Imports and rebagging.
create index if not exists irl_movement_idx on public.import_receipt_lines(movement_id);
create index if not exists irl_shipment_line_idx on public.import_receipt_lines(shipment_line_id);
create index if not exists isl_shipment_line_idx on public.import_shipment_lines(shipment_id);
create index if not exists rebag_outputs_order_idx on public.rebag_outputs(order_id);
create index if not exists rebag_outputs_movement_idx on public.rebag_outputs(movement_id);
create index if not exists rebag_inputs_order_idx on public.rebag_inputs(order_id);

-- Lots, allocations, costs, documents.
create index if not exists stock_lot_balances_lot_idx on public.stock_lot_balances(lot_id);
create index if not exists cost_allocations_run_idx on public.cost_allocations(run_id);
create index if not exists cost_delta_lines_company_idx on public.cost_delta_lines(company_id, target);
create index if not exists cost_sources_company_status_idx on public.cost_sources(company_id, status);
create index if not exists supplier_payables_cost_invoice_idx on public.supplier_payables(cost_invoice_id);
create index if not exists document_attachments_company_cat_idx on public.document_attachments(company_id, category);
create index if not exists purchase_cost_adjustments_purchase_idx on public.purchase_cost_adjustments(purchase_id);
create index if not exists sales_return_lines_return_idx on public.sales_return_lines(return_id);

-- Trigger functions cannot be called directly, but keep them off the Data API
-- anyway (the 0023 default privileges grant execute on new functions).
do $$
declare f record;
begin
  for f in select p.oid::regprocedure sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.prorettype = 'trigger'::regtype loop
    execute format('revoke all on function %s from public, anon, authenticated', f.sig);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Cross-company references on the original transaction tables (found by the
-- Stage 9 negative tests: e.g. a purchase could name another company's
-- supplier). Headers use the existing check_company_consistency(); line
-- tables (no company_id) check their references against the parent's
-- company. Only inserts / updates are checked; existing rows are unchanged.
-- ---------------------------------------------------------------------------
create or replace function public.check_line_company()
returns trigger language plpgsql as $$
declare co uuid; i int := 2; ref uuid; refco uuid;
begin
  execute format('select company_id from public.%I where id = $1', TG_ARGV[0]) into co using (to_jsonb(NEW) ->> TG_ARGV[1])::uuid;
  if co is null then return NEW; end if;
  while i < TG_NARGS loop
    ref := (to_jsonb(NEW) ->> TG_ARGV[i])::uuid;
    if ref is not null then
      execute format('select company_id from public.%I where id = $1', TG_ARGV[i + 1]) into refco using ref;
      if refco is null or refco <> co then
        raise exception 'Cross-company reference on %.% -> % (id %) does not match company %', TG_TABLE_NAME, TG_ARGV[i], TG_ARGV[i + 1], ref, co
          using errcode = '23514';
      end if;
    end if;
    i := i + 2;
  end loop;
  return NEW;
end; $$;
revoke all on function public.check_line_company() from public, anon, authenticated;

do $$
declare
  spec text[];
  -- header tables: {table, col, ref, col, ref, col, ref}
  specs text[][] := array[
    array['sales','branch_id','branches','customer_id','customers','',''],
    array['customer_receipts','branch_id','branches','customer_id','customers','',''],
    array['sales_returns','branch_id','branches','customer_id','customers','sale_id','sales'],
    array['purchases','branch_id','branches','supplier_id','suppliers','',''],
    array['purchase_returns','branch_id','branches','supplier_id','suppliers','purchase_id','purchases'],
    array['expenses','branch_id','branches','supplier_id','suppliers','expense_category_id','expense_categories'],
    array['supplier_payments','branch_id','branches','supplier_id','suppliers','',''],
    array['stock_adjustments','branch_id','branches','','','',''],
    array['inventory_openings','branch_id','branches','','','',''],
    array['other_income_transactions','branch_id','branches','customer_id','customers','',''],
    array['journal_entries','branch_id','branches','','','','']
  ];
  -- line tables: {table, parent table, parent fk, col, ref, col, ref}
  lines text[][] := array[
    array['sale_lines','sales','sale_id','product_id','products','tax_code_id','tax_codes'],
    array['sale_payments','sales','sale_id','payment_account_id','payment_accounts','',''],
    array['purchase_lines','purchases','purchase_id','product_id','products','tax_code_id','tax_codes'],
    array['purchase_payments','purchases','purchase_id','payment_account_id','payment_accounts','',''],
    array['sales_return_lines','sales_returns','return_id','product_id','products','',''],
    array['purchase_return_lines','purchase_returns','return_id','product_id','products','',''],
    array['stock_adjustment_lines','stock_adjustments','adjustment_id','product_id','products','',''],
    array['inventory_opening_lines','inventory_openings','opening_id','product_id','products','',''],
    array['expense_payments','expenses','expense_id','payment_account_id','payment_accounts','',''],
    array['supplier_payment_funding','supplier_payments','payment_id','payment_account_id','payment_accounts','',''],
    array['journal_lines','journal_entries','journal_id','account_id','chart_of_accounts','','']
  ];
  args text; j int;
  col_ok boolean;
begin
  foreach spec slice 1 in array specs loop
    continue when to_regclass('public.' || spec[1]) is null;
    continue when not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = spec[1] and column_name = 'company_id');
    args := '';
    j := 2;
    while j < array_length(spec, 1) loop
      col_ok := spec[j] <> '' and exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = spec[1] and column_name = spec[j])
         and exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = spec[j + 1] and column_name = 'company_id');
      if col_ok then
        args := args || case when args = '' then '' else ',' end || quote_literal(spec[j]) || ',' || quote_literal(spec[j + 1]);
      end if;
      j := j + 2;
    end loop;
    continue when args = '';
    execute format('drop trigger if exists %I on public.%I', 'trg_' || spec[1] || '_company_v9', spec[1]);
    execute format('create trigger %I before insert or update on public.%I for each row execute function public.check_company_consistency(%s)',
      'trg_' || spec[1] || '_company_v9', spec[1], args);
  end loop;
  foreach spec slice 1 in array lines loop
    continue when to_regclass('public.' || spec[1]) is null;
    continue when not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = spec[1] and column_name = spec[3]);
    args := quote_literal(spec[2]) || ',' || quote_literal(spec[3]);
    j := 4;
    while j < array_length(spec, 1) loop
      if spec[j] <> '' and exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = spec[1] and column_name = spec[j])
         and exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = spec[j + 1] and column_name = 'company_id') then
        args := args || ',' || quote_literal(spec[j]) || ',' || quote_literal(spec[j + 1]);
      end if;
      j := j + 2;
    end loop;
    execute format('drop trigger if exists %I on public.%I', 'trg_' || spec[1] || '_line_company_v9', spec[1]);
    execute format('create trigger %I before insert or update on public.%I for each row execute function public.check_line_company(%s)',
      'trg_' || spec[1] || '_line_company_v9', spec[1], args);
  end loop;
end $$;
