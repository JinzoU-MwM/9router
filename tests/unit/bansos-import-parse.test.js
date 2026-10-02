import { describe, it, expect } from "vitest";
import { parseBansosText, normalizeBaseUrl } from "@/lib/bansosImport.js";

// The input is hand-arranged text scraped off the internet, so the parser has
// to take the shapes that actually appear and reject the rest with a line
// number instead of guessing.
describe("bansos paste parser", () => {
  it("accepts the shapes that show up in the wild", () => {
    const block = [
      "# free relays, collected 2026-09",
      "https://api-a.example/v1|sk-aaaaaaaaaaaaaaaa",
      "https://api-b.example/v1  sk-bbbbbbbbbbbbbbbb",
      "https://api-c.example/v1\tsk-cccccccccccccccc",
      "https://api-d.example/v1,sk-dddddddddddddddd",
      "sk-eeeeeeeeeeeeeeee@api-e.example/v1",
      '{"base_url":"https://api-f.example/v1","api_key":"sk-ffffffffffffffff"}',
      "https://api-g.example/v1|sk-gggggggggggggggg|note: works",
      "",
      "   ",
      "// another comment",
    ].join("\n");

    const { entries, invalid } = parseBansosText(block);
    expect(invalid).toEqual([]);
    expect(entries.map((e) => e.baseUrl)).toEqual([
      "https://api-a.example/v1",
      "https://api-b.example/v1",
      "https://api-c.example/v1",
      "https://api-d.example/v1",
      "https://api-e.example/v1",
      "https://api-f.example/v1",
      "https://api-g.example/v1",
    ]);
    expect(entries[4].apiKey).toBe("sk-eeeeeeeeeeeeeeee");
    expect(entries[0].line).toBe(2);
    expect(entries[6].line).toBe(8);
  });

  it("reports junk with the line number instead of dropping it silently", () => {
    const { entries, invalid } = parseBansosText(["garbage-line", "https://x.example/v1", "not-a-url|sk-zzzzzzzzzzzz"].join("\n"));
    expect(entries).toEqual([]);
    expect(invalid.map((i) => i.line)).toEqual([1, 2, 3]);
    expect(invalid[2].reason).toMatch(/scheme/);
  });

  it("normalises the base url to something the executor can append to", () => {
    expect(normalizeBaseUrl("https://api.example/v1/")).toBe("https://api.example/v1");
    expect(normalizeBaseUrl("https://api.example/v1/chat/completions")).toBe("https://api.example/v1");
    expect(normalizeBaseUrl("https://api.example/v1/messages")).toBe("https://api.example/v1");
    expect(normalizeBaseUrl('"https://api.example/v1"')).toBe("https://api.example/v1");
    expect(normalizeBaseUrl("https://api.example/v1/embeddings")).toBe("https://api.example/v1");
  });

  it("parses a structured entry list path", () => {
    const { entries } = parseBansosText("https://api-h.example/v1|sk-hhhhhhhhhhhhhhhh");
    expect(entries).toHaveLength(1);
    expect(entries[0].apiKey.startsWith("sk-")).toBe(true);
  });
});
