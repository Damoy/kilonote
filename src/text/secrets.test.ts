import { describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret, findSecrets, maskSecrets, SECRET_BEGIN, SECRET_END, WRONG_PASSWORD } from "./secrets";

// Fewer rounds than the 600 000 of real secrets, to keep the tests fast (still accepted).
const ROUNDS = 100_000;

describe("secrets in notes", () => {
  it("come back only with their password", async () => {
    const text = "ssh admin@10.0.0.1\npassword: hunter2 — é ✓";
    const block = await encryptSecret(text, "correct horse", ROUNDS);
    expect(block.startsWith(SECRET_BEGIN + "\n")).toBe(true);
    expect(block.endsWith("\n" + SECRET_END)).toBe(true);
    expect(block).not.toContain("hunter2");
    expect(block.split("\n").every((l) => l.length <= 64 || l === SECRET_BEGIN || l === SECRET_END)).toBe(true);
    expect(await decryptSecret(block, "correct horse")).toBe(text);
    await expect(decryptSecret(block, "wrong horse")).rejects.toThrow(WRONG_PASSWORD);
  });

  it("are never twice the same, and any change is detected", async () => {
    const a = await encryptSecret("same", "password1", ROUNDS);
    const b = await encryptSecret("same", "password1", ROUNDS);
    expect(a).not.toBe(b); // a new salt and nonce each time
    const lines = a.split("\n");
    // A byte of the ciphertext changed.
    const body = lines[1];
    const flipped = body.slice(0, 40) + (body[40] === "A" ? "B" : "A") + body.slice(41);
    await expect(decryptSecret([lines[0], flipped, ...lines.slice(2)].join("\n"), "password1")).rejects.toThrow();
    // The number of rounds lowered (it is authenticated too).
    const bytes = Uint8Array.from(atob(lines.slice(1, -1).join("")), (c) => c.charCodeAt(0));
    new DataView(bytes.buffer).setUint32(1, ROUNDS + 1);
    const forged = [SECRET_BEGIN, btoa(String.fromCharCode(...bytes)), SECRET_END].join("\n");
    await expect(decryptSecret(forged, "password1")).rejects.toThrow(WRONG_PASSWORD);
    // Too few rounds, or damaged text: refused before any work.
    new DataView(bytes.buffer).setUint32(1, 1000);
    await expect(decryptSecret([SECRET_BEGIN, btoa(String.fromCharCode(...bytes)), SECRET_END].join("\n"), "password1")).rejects.toThrow("damaged");
    await expect(decryptSecret(`${SECRET_BEGIN}\n!!!\n${SECRET_END}`, "password1")).rejects.toThrow("damaged");
  });

  it("are found in a note, and hidden from the preview at the same length", () => {
    const note = `intro\n${SECRET_BEGIN}\nAAAA\nBBBB\n${SECRET_END}\nafter\n  ${SECRET_BEGIN}\nunfinished`;
    expect(findSecrets(note.split("\n"))).toEqual([{ from: 6, to: 6 + SECRET_BEGIN.length + 11 + SECRET_END.length }]);
    const masked = maskSecrets(note);
    expect(masked.length).toBe(note.length);
    expect(masked.split("\n").slice(0, 6).map((l) => l.trim())).toEqual(["intro", "🔒 Encrypted secret", "", "", "", "after"]);
    expect(masked).not.toContain("AAAA");
  });
});
