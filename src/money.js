/**
 * Money helpers.
 *
 * We store all balances and amounts internally as an integer number of
 * paise (1 rupee = 100 paise). Using an integer smallest-unit avoids the
 * floating-point rounding bugs that plague money math (e.g. 0.1 + 0.2).
 * The API accepts and returns human-friendly rupees; conversion happens at
 * the edges.
 */

/** Convert a rupee amount (number or numeric string) to integer paise. */
export function rupeesToPaise(rupees) {
  const n = Number(rupees);
  if (!Number.isFinite(n)) return NaN;
  return Math.round(n * 100);
}

/** Convert integer paise to a rupee number (2 decimal places). */
export function paiseToRupees(paise) {
  return paise / 100;
}
