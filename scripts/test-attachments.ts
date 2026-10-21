/** Unit tests for the attachment policy (no database, no Storage). */
import {
  MAX_ATTACHMENT_BYTES, SIGNED_URL_TTL_SECONDS, safeDownloadName, storagePath, validateAttachment,
} from "../src/lib/attachments/policy";

let passed = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) { passed++; console.log(`  ok  ${name}`); }
  else { console.error(`  FAIL ${name} ${detail}`); process.exitCode = 1; }
}
const bytes = (...b: number[]) => new Uint8Array([...b, ...new Array(16).fill(0)]);
const PDF = bytes(0x25, 0x50, 0x44, 0x46, 0x2d, 0x31);
const PNG = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
const JPG = bytes(0xff, 0xd8, 0xff, 0xe0);
const WEBP = bytes(0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x45, 0x42, 0x50);
const HTML = new TextEncoder().encode("<!doctype html><script>alert(1)</script>");

check("PDF accepted", validateAttachment("application/pdf", 1000, PDF).ok);
check("PNG accepted", validateAttachment("image/png", 1000, PNG).ok);
check("JPEG accepted", validateAttachment("image/jpeg", 1000, JPG).ok);
check("WebP accepted", validateAttachment("image/webp", 1000, WEBP).ok);
check("HTML rejected", !validateAttachment("text/html", 100, HTML).ok);
check("SVG rejected", !validateAttachment("image/svg+xml", 100, HTML).ok);
check("HTML disguised as PDF rejected", !validateAttachment("application/pdf", 100, HTML).ok);
check("PNG disguised as PDF rejected", !validateAttachment("application/pdf", 100, PNG).ok);
check("Windows executable rejected", !validateAttachment("application/octet-stream", 100, bytes(0x4d, 0x5a)).ok);
check("empty file rejected", !validateAttachment("application/pdf", 0, PDF).ok);
check("10 MB accepted", validateAttachment("application/pdf", MAX_ATTACHMENT_BYTES, PDF).ok);
check("10 MB + 1 byte rejected", !validateAttachment("application/pdf", MAX_ATTACHMENT_BYTES + 1, PDF).ok);

const dbPattern = /^[A-Za-z0-9._ -]{1,120}$/;
const names: [string, string][] = [
  ["../../etc/passwd", "pdf"], ["C:\\Users\\x\\Invoice 12.pdf", "pdf"], ["<script>.pdf", "pdf"],
  ["mbolea ya urea – ankara.pdf", "pdf"], ["", "png"], ["....", "jpg"], ["a".repeat(500) + ".pdf", "pdf"],
  ["report.pdf.exe", "pdf"], ["photo.HTML", "png"],
];
for (const [n, ext] of names) {
  const s = safeDownloadName(n, ext);
  check(`safe name for ${JSON.stringify(n.slice(0, 30))} -> ${s.slice(0, 40)}`,
    dbPattern.test(s) && s.endsWith(`.${ext}`) && !s.includes("/") && !s.includes("\\") && !s.includes(".."));
}
check("extension forced to the real type", safeDownloadName("report.pdf.exe", "pdf") === "report.pdf.pdf");

const u = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
check("storage path has no user file name", storagePath(u, "stock_transfer", u, u, "pdf") === `${u}/stock_transfer/${u}/${u}.pdf`);
let threw = false;
try { storagePath("../x", "stock_transfer", u, u, "pdf"); } catch { threw = true; }
check("path traversal in ids rejected", threw);
check("signed links are short-lived (<= 5 minutes)", SIGNED_URL_TTL_SECONDS > 0 && SIGNED_URL_TTL_SECONDS <= 300);

console.log(`\n${passed} attachment policy checks passed.`);
