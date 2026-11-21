import { describe, expect, it } from "vitest";
import { maskEmail, maskName, maskPhone, maskText } from "../src/lib/mask";

describe("maskEmail", () => {
  it("keeps only first characters and the TLD", () => {
    expect(maskEmail("john.doe@example.com")).toBe("j*****@e*****.com");
  });

  it("never leaks the local part or host", () => {
    const masked = maskEmail("jane.smith@acme-corp.io");
    expect(masked).not.toContain("jane");
    expect(masked).not.toContain("smith");
    expect(masked).not.toContain("acme");
    expect(masked.endsWith(".io")).toBe(true);
  });

  it("handles one-character parts and missing TLD", () => {
    expect(maskEmail("a@b.co")).toBe("*@*.co");
    expect(maskEmail("user@localhost")).toBe("u***@l*****");
  });

  it("masks input that is not an email", () => {
    expect(maskEmail("nonsense")).toBe("n*****");
    expect(maskEmail("@example.com")).toBe("@*****");
  });
});

describe("maskName", () => {
  it("masks every word", () => {
    expect(maskName("Jan Kowalski")).toBe("J** K*****");
  });

  it("collapses extra whitespace and handles empty input", () => {
    expect(maskName("  Anna   Maria  ")).toBe("A*** M****");
    expect(maskName("")).toBe("");
  });

  it("masks single-letter words", () => {
    expect(maskName("X")).toBe("*");
  });
});

describe("maskPhone", () => {
  it("keeps only the last two digits", () => {
    expect(maskPhone("+48 600 123 456")).toBe("*********56");
    expect(maskPhone("(555) 123-4567")).toBe("********67");
  });

  it("fully masks very short input", () => {
    expect(maskPhone("1")).toBe("**");
    expect(maskPhone("")).toBe("**");
  });
});

describe("maskText", () => {
  it("leaves no original email or phone substring behind", () => {
    const text =
      "Hi, I am Jan. Reach me at jan.kowalski@firma.pl or +48 600 123 456, or sales@big-co.example.com / (555) 123-4567.";
    const masked = maskText(text);
    for (const secret of [
      "jan.kowalski",
      "firma",
      "sales@",
      "big-co",
      "600 123 456",
      "600",
      "123 456",
      "555",
      "123-4567",
      "4567",
    ]) {
      expect(masked).not.toContain(secret);
    }
    expect(masked).toContain("Hi, I am Jan. Reach me at");
  });

  it("keeps surrounding text intact", () => {
    expect(maskText("write to a.b@c.de now")).toBe("write to a**@*.de now");
  });

  it("leaves text without PII unchanged", () => {
    const text = "We need a demo next week for 12 people.";
    expect(maskText(text)).toBe(text);
  });
});
