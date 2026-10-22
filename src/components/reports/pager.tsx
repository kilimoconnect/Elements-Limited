import Link from "next/link";

/** Server-rendered pager: keeps the other query parameters, changes ?page=. */
export function Pager({ basePath, params, page, pageSize, total }: {
  basePath: string; params: Record<string, string | undefined>; page: number; pageSize: number; total: number;
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const href = (p: number) => {
    const q = new URLSearchParams(Object.entries(params).filter(([, v]) => v) as [string, string][]);
    q.set("page", String(p));
    return `${basePath}?${q.toString()}`;
  };
  if (pages <= 1) return <p className="mt-2 text-xs text-muted-foreground print-hide">{total} row(s)</p>;
  return (
    <div className="mt-3 flex items-center justify-between text-sm print-hide">
      <span className="text-xs text-muted-foreground">{total} rows · page {page} of {pages}</span>
      <span className="flex gap-2">
        {page > 1 ? <Link className="rounded-md border border-border px-3 py-1" href={href(page - 1)}>Previous</Link> : <span className="rounded-md border border-border px-3 py-1 opacity-40">Previous</span>}
        {page < pages ? <Link className="rounded-md border border-border px-3 py-1" href={href(page + 1)}>Next</Link> : <span className="rounded-md border border-border px-3 py-1 opacity-40">Next</span>}
      </span>
    </div>
  );
}

export const PAGE_SIZE = 50;
export function pageOf(sp: Record<string, string | string[] | undefined>): number {
  const p = Number(Array.isArray(sp.page) ? sp.page[0] : sp.page);
  return Number.isInteger(p) && p > 0 ? p : 1;
}
export function str(sp: Record<string, string | string[] | undefined>, k: string): string {
  const v = sp[k];
  return (Array.isArray(v) ? v[0] : v) ?? "";
}
