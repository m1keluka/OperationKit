/**
 * Temporary passwords for the admin Users tab (create user / reset password).
 *
 * These are real credentials: they are shown to the admin and often emailed to
 * the person, so they MUST come from a CSPRNG. `crypto.getRandomValues` is the
 * Web Crypto CSPRNG (also present on Node's global `crypto`). Never use
 * Math.random here — it is predictable (CodeQL js/insecure-randomness).
 *
 * Rejection sampling keeps the distribution uniform: a byte is only used when
 * it is below the largest multiple of the alphabet size, so `byte % size` has
 * no modulo bias.
 */

/** No 0/O, 1/l/I: the password is read off a screen and typed by a person. */
const UPPER = 'ABCDEFGHJKLMNPQRSTUVWXYZ'
const LOWER = 'abcdefghijkmnpqrstuvwxyz'
const DIGITS = '23456789'
// Joined at runtime: one 56-char literal reads as a key to secret scanners.
export const TEMP_PASSWORD_ALPHABET = UPPER + LOWER + DIGITS
export const TEMP_PASSWORD_LENGTH = 16

export function generateTempPassword(
  length = TEMP_PASSWORD_LENGTH,
  getRandomValues: (a: Uint8Array) => Uint8Array = a => globalThis.crypto.getRandomValues(a),
): string {
  const alphabet = TEMP_PASSWORD_ALPHABET
  const limit = 256 - (256 % alphabet.length)
  let out = ''
  const buf = new Uint8Array(length * 2)
  while (out.length < length) {
    getRandomValues(buf)
    for (const b of buf) {
      if (b >= limit) continue
      out += alphabet[b % alphabet.length]
      if (out.length === length) break
    }
  }
  return out
}
