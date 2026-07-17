import QRCode from 'qrcode';

/**
 * UPI helpers: building the standard `upi://pay` deep-link that gets encoded
 * into a QR, and parsing such a link back out after a scan.
 *
 * The `upi://pay` scheme mirrors the real UPI spec so the QR codes we produce
 * are the same shape real apps use:
 *   pa = payee address (VPA)   pn = payee name
 *   am = amount (rupees)       cu = currency        tn = transaction note
 */

/** Build a `upi://pay?...` deep-link string. */
export function buildUpiUri({ pa, pn, am, tn, cu = 'INR' }) {
  if (!pa) throw new Error('buildUpiUri: payee address (pa) is required');
  const params = new URLSearchParams();
  params.set('pa', pa);
  if (pn) params.set('pn', pn);
  if (am != null && am !== '') params.set('am', String(am));
  params.set('cu', cu);
  if (tn) params.set('tn', tn);
  return `upi://pay?${params.toString()}`;
}

/** Parse a `upi://pay?...` link into its fields. Returns null if not a UPI link. */
export function parseUpiUri(uri) {
  if (typeof uri !== 'string') return null;
  const match = uri.match(/^upi:\/\/pay\?(.*)$/i);
  if (!match) return null;
  const params = new URLSearchParams(match[1]);
  return {
    pa: params.get('pa'),
    pn: params.get('pn'),
    am: params.get('am'),
    cu: params.get('cu'),
    tn: params.get('tn'),
  };
}

/** Render text (typically a upi:// link) to a PNG data-URL QR code. */
export async function generateQrDataUrl(text) {
  return QRCode.toDataURL(text, {
    errorCorrectionLevel: 'M',
    margin: 1,
    width: 256,
  });
}
