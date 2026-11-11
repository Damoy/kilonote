// Secrets in notes: a piece of a note encrypted with a password, kept in the
// note as an armored block of text:
//
//   -----BEGIN KILONOTE SECRET-----
//   AQAJJ8Bx3m0V…   (base64, 64 characters per line)
//   -----END KILONOTE SECRET-----
//
// The password is stretched with PBKDF2-SHA-256 (600 000 rounds, a random salt
// per secret) into an AES-256-GCM key; GCM also checks that nothing was changed.
// The bytes are: version (1) · rounds (4, big-endian) · salt (16) · nonce (12) ·
// ciphertext and tag; everything before the ciphertext is authenticated too.
// Only the Web Crypto API of the page is used: no key or password is ever stored.

export const SECRET_BEGIN = "-----BEGIN KILONOTE SECRET-----";
export const SECRET_END = "-----END KILONOTE SECRET-----";

const VERSION = 1;
export const KDF_ROUNDS = 600_000;
const SALT_BYTES = 16;
const NONCE_BYTES = 12;
const HEADER_BYTES = 1 + 4 + SALT_BYTES + NONCE_BYTES;
/** Fewer rounds than this would be too weak: such a secret is refused. */
const MIN_ROUNDS = 100_000;
/** More would freeze the window for minutes: such a secret is refused too. */
const MAX_ROUNDS = 10_000_000;

/** The error of a wrong password (or of a secret that was changed). */
export const WRONG_PASSWORD = "Wrong password, or the secret was changed";

async function deriveKey(password: string, salt: Uint8Array, rounds: number): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey("raw", new TextEncoder().encode(password) as BufferSource, "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt: salt as BufferSource, iterations: rounds },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function fromBase64(text: string): Uint8Array {
  const bin = atob(text.replace(/\s+/g, ""));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

/** The armored block (without a final line break) holding `text`, encrypted with `password`. */
export async function encryptSecret(text: string, password: string, rounds = KDF_ROUNDS): Promise<string> {
  if (!password) throw new Error("A password is needed");
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
  const header = new Uint8Array(HEADER_BYTES);
  header[0] = VERSION;
  new DataView(header.buffer).setUint32(1, rounds);
  header.set(salt, 5);
  header.set(nonce, 5 + SALT_BYTES);
  const key = await deriveKey(password, salt, rounds);
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce as BufferSource, additionalData: header as BufferSource }, key, new TextEncoder().encode(text) as BufferSource),
  );
  const all = new Uint8Array(header.length + sealed.length);
  all.set(header);
  all.set(sealed, header.length);
  const lines = toBase64(all).match(/.{1,64}/g) ?? [];
  return [SECRET_BEGIN, ...lines, SECRET_END].join("\n");
}

/** The text of an armored block; throws WRONG_PASSWORD when the password is wrong. */
export async function decryptSecret(block: string, password: string): Promise<string> {
  const begin = block.indexOf(SECRET_BEGIN);
  const end = block.indexOf(SECRET_END);
  if (begin < 0 || end < begin) throw new Error("Not a secret block");
  let bytes: Uint8Array;
  try {
    bytes = fromBase64(block.slice(begin + SECRET_BEGIN.length, end));
  } catch {
    throw new Error("This secret is damaged");
  }
  if (bytes.length < HEADER_BYTES + 16 || bytes[0] !== VERSION) throw new Error("This secret is damaged, or made by a newer version of KiloNote");
  const header = bytes.subarray(0, HEADER_BYTES);
  const rounds = new DataView(bytes.buffer, bytes.byteOffset).getUint32(1);
  if (rounds < MIN_ROUNDS || rounds > MAX_ROUNDS) throw new Error("This secret is damaged");
  const salt = bytes.subarray(5, 5 + SALT_BYTES);
  const nonce = bytes.subarray(5 + SALT_BYTES, HEADER_BYTES);
  const key = await deriveKey(password, salt, rounds);
  try {
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: nonce as BufferSource, additionalData: header as BufferSource },
      key,
      bytes.subarray(HEADER_BYTES) as BufferSource,
    );
    return new TextDecoder().decode(plain);
  } catch {
    throw new Error(WRONG_PASSWORD);
  }
}

/** A secret block of a note: from the start of its BEGIN line to the end of its END line. */
export interface SecretBlock {
  from: number;
  to: number;
}

/** The secret blocks of a text (`lines` from its first line, `offset` its position). */
export function findSecrets(lines: Iterable<string>, offset = 0): SecretBlock[] {
  const out: SecretBlock[] = [];
  let pos = offset;
  let start = -1;
  for (const line of lines) {
    const t = line.trim();
    if (t === SECRET_BEGIN) start = pos;
    else if (t === SECRET_END && start >= 0) {
      out.push({ from: start, to: pos + line.length });
      start = -1;
    }
    pos += line.length + 1;
  }
  return out;
}

const SECRET_LABEL = "🔒 Encrypted secret";

/**
 * The text with each secret block blanked out, at the same length (a parse of
 * the original text still fits it): the first line says "Encrypted secret".
 * For the Markdown preview, which never shows the armored text.
 */
export function maskSecrets(text: string): string {
  if (!text.includes(SECRET_BEGIN)) return text;
  const blocks = findSecrets(text.split("\n"));
  let out = "";
  let last = 0;
  for (const b of blocks) {
    const lines = text.slice(b.from, b.to).split("\n");
    const first = lines[0].length >= SECRET_LABEL.length ? SECRET_LABEL.padEnd(lines[0].length) : " ".repeat(lines[0].length);
    out += text.slice(last, b.from) + [first, ...lines.slice(1).map((l) => " ".repeat(l.length))].join("\n");
    last = b.to;
  }
  return out + text.slice(last);
}
