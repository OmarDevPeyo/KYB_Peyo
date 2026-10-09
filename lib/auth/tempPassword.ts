/**
 * Contraseña temporal para el acceso que se manda por correo (alta de la
 * cuenta o reenvío). Tres grupos de 4 separados por guiones (`Kp7m-Qx3r-Tz9w`):
 * fácil de copiar o tipear, sin caracteres que se confunden (0/O, 1/l/I).
 * Cumple la política (lib/auth/passwordPolicy.ts): 14 caracteres, letras y
 * dígitos. Sirve hasta el primer ingreso, cuando la persona elige la suya.
 *
 * Puro (sin `@/`) para probarlo con `node --test`; usa la Web Crypto global.
 */

const LETTERS = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ";
const DIGITS = "23456789";
const ALPHABET = LETTERS + DIGITS;

/** Índice uniforme en [0, n) sin sesgo de módulo. */
function randomIndex(n: number): number {
  const limit = Math.floor(0x1_0000_0000 / n) * n;
  const buf = new Uint32Array(1);
  for (;;) {
    crypto.getRandomValues(buf);
    if (buf[0]! < limit) return buf[0]! % n;
  }
}

export function generateTempPassword(): string {
  for (;;) {
    const chars = Array.from({ length: 12 }, () => ALPHABET[randomIndex(ALPHABET.length)]!);
    const hasLetter = chars.some((c) => LETTERS.includes(c));
    const hasDigit = chars.some((c) => DIGITS.includes(c));
    if (hasLetter && hasDigit) {
      return [chars.slice(0, 4), chars.slice(4, 8), chars.slice(8)].map((g) => g.join("")).join("-");
    }
  }
}
