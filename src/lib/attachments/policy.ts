/**
 * Attachment policy: pure, dependency-free rules shared by the upload service
 * and its tests. The database enforces the same limits (migration 0025,
 * document_attachments checks) so a bypass of this layer still fails.
 */

export const ATTACHMENT_BUCKET = "documents";
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024; // 10 MB
/** Signed download links expire quickly; a new one is issued per click. */
export const SIGNED_URL_TTL_SECONDS = 60;

export const OWNER_TYPES = [
  "import_shipment", "import_receipt", "cost_invoice", "purchase",
  "stock_transfer", "stock_transfer_receipt", "rebag_order", "stock_transfer_dispatch",
  "sale",
] as const;
export type OwnerType = (typeof OWNER_TYPES)[number];

export const CATEGORIES = [
  "bill_of_lading", "packing_list", "customs_entry", "supplier_invoice", "cost_invoice",
  "delivery_note", "proof_of_delivery", "photo", "other",
  // transfer cargo file (Stage 6)
  "driver_licence", "cargo_papers", "loading_photo", "weighbridge_ticket", "transport_invoice", "signed_delivery_note", "offloading_photo",
  // sales order approval
  "proof_of_payment",
] as const;
export type AttachmentCategory = (typeof CATEGORIES)[number];

/** Categories that need documents.view_financial to read or upload. */
export const FINANCIAL_CATEGORIES: readonly AttachmentCategory[] = ["supplier_invoice", "cost_invoice", "transport_invoice"];
/** Driver licence images need documents.view_licence (physical access does not imply it). */
export const LICENCE_CATEGORIES: readonly AttachmentCategory[] = ["driver_licence"];

/** Extra permission a category needs beyond access to its record (mirrors attachment_category_permission in the database). */
export function categoryPermission(category: string): "documents.view_financial" | "documents.view_licence" | null {
  if (FINANCIAL_CATEGORIES.includes(category as AttachmentCategory)) return "documents.view_financial";
  if (LICENCE_CATEGORIES.includes(category as AttachmentCategory)) return "documents.view_licence";
  return null;
}

export const CATEGORY_LABEL: Record<AttachmentCategory, string> = {
  bill_of_lading: "Bill of lading", packing_list: "Packing list", customs_entry: "Customs entry", supplier_invoice: "Supplier invoice",
  cost_invoice: "Cost invoice", delivery_note: "Delivery note", proof_of_delivery: "Proof of delivery", photo: "Photo", other: "Other",
  driver_licence: "Driver licence", cargo_papers: "Cargo papers / B/L", loading_photo: "Loading photo", weighbridge_ticket: "Weighbridge ticket",
  transport_invoice: "Transport invoice", signed_delivery_note: "Signed delivery note", offloading_photo: "Offloading photo",
  proof_of_payment: "Proof of payment",
};

/** Only inert document / image types; nothing a browser would execute (no HTML, SVG, scripts). */
const TYPES: Record<string, { ext: string; magic: (b: Uint8Array) => boolean }> = {
  "application/pdf": { ext: "pdf", magic: (b) => startsWith(b, [0x25, 0x50, 0x44, 0x46, 0x2d]) }, // %PDF-
  "image/jpeg": { ext: "jpg", magic: (b) => startsWith(b, [0xff, 0xd8, 0xff]) },
  "image/png": { ext: "png", magic: (b) => startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) },
  "image/webp": {
    ext: "webp",
    magic: (b) => startsWith(b, [0x52, 0x49, 0x46, 0x46]) && b.length >= 12 &&
      b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50, // RIFF....WEBP
  },
};
export const ALLOWED_CONTENT_TYPES = Object.keys(TYPES);

function startsWith(b: Uint8Array, sig: number[]): boolean {
  return b.length >= sig.length && sig.every((v, i) => b[i] === v);
}

export type ValidationResult = { ok: true; contentType: string; ext: string } | { ok: false; error: string };

/**
 * Validates size and type. The declared type must be allowed AND the file's
 * leading bytes must match it, so a renamed .html / .exe cannot pass as PDF.
 */
export function validateAttachment(declaredType: string, size: number, head: Uint8Array): ValidationResult {
  if (!Number.isInteger(size) || size <= 0) return { ok: false, error: "The file is empty." };
  if (size > MAX_ATTACHMENT_BYTES) return { ok: false, error: "Files can be at most 10 MB." };
  const t = TYPES[declaredType];
  if (!t) return { ok: false, error: "Only PDF, JPEG, PNG or WebP files can be attached." };
  if (!t.magic(head)) return { ok: false, error: "The file content does not match its type." };
  return { ok: true, contentType: declaredType, ext: t.ext };
}

/**
 * A safe download name: ASCII letters, digits, dot, dash, underscore and
 * space only; no path parts; forced extension matching the real type.
 * Matches the database check ^[A-Za-z0-9._ -]{1,120}$.
 */
export function safeDownloadName(original: string, ext: string): string {
  const base = (original.split(/[\\/]/).pop() ?? "")
    .normalize("NFKD")
    .replace(/\.[^.]*$/, "")
    .replace(/[^A-Za-z0-9._ -]+/g, "_")
    .replace(/^[.\s_-]+/, "")
    .replace(/\.{2,}/g, ".")
    .trim()
    .slice(0, 100);
  return `${base || "document"}.${ext}`;
}

/** Storage key: never contains the user's file name. */
export function storagePath(companyId: string, ownerType: OwnerType, ownerId: string, objectId: string, ext: string): string {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (![companyId, ownerId, objectId].every((v) => uuid.test(v))) throw new Error("Invalid id in storage path.");
  if (!OWNER_TYPES.includes(ownerType)) throw new Error("Invalid owner type.");
  return `${companyId}/${ownerType}/${ownerId}/${objectId}.${ext}`;
}
