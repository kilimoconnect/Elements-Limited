/**
 * Who may see and enter a driver's licence NUMBER on a transfer trip: users
 * who dispatch transfers (e.g. the Storekeeper) or who may view licences.
 * Licence PHOTOS stay behind documents.view_licence only (attachments policy).
 */
export function canUseLicenceNumber(user: { isOwner: boolean; permissions: Set<string> }): boolean {
  return user.isOwner || user.permissions.has("documents.view_licence") || user.permissions.has("inventory.transfer_dispatch");
}
