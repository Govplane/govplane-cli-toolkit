/**
 * Masking of the licence subject for human-readable output.
 *
 * The address is shown in a terminal that is routinely shoulder-surfed, screen-shared,
 * pasted into an issue and captured by CI log collectors. Enough of it is kept to answer
 * "is this the account I think it is?" — which is the only question the output needs to
 * answer — and the rest is dropped.
 *
 * This is presentation only. The licence file holds the real address, and
 * `--format json` still reports it in full: that output is read by scripts, and the
 * address is already on the same machine, so masking it there would cost utility without
 * buying any privacy.
 */

const MASK = '*******';

/**
 * `dev@example.com` → `dev@*******`
 *
 * The local part is what distinguishes one of your own accounts from another, so it
 * survives; the domain is the part that identifies an employer or a client and is
 * dropped entirely. A fixed-width mask is used deliberately — sizing it to the real
 * domain would leak its length.
 */
export const maskEmail = (email: string): string => {
  const trimmed = email.trim();
  const at = trimmed.lastIndexOf('@');

  // Not an address shape we recognise. Masking the whole value is the safe reading:
  // never widen what gets printed on the strength of a guess.
  if (at <= 0 || at === trimmed.length - 1) {
    return MASK;
  }

  return `${trimmed.slice(0, at)}@${MASK}`;
};
