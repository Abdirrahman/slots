import { describe, expect, test } from "bun:test";

const html = await Bun.file(new URL("../index.html", import.meta.url)).text();

describe("Solo Quick Race setup markup", () => {
  test("uses labeled native Bot controls and one keyboard-accessible Solo action", () => {
    expect(html).toContain('<label for="solo-bot-count">Bot count</label>');
    expect(html).toContain('<select id="solo-bot-count"');
    for (const count of [1, 2, 3]) expect(html).toContain(`<option value="${count}"`);

    expect(html).toContain('<label for="solo-bot-difficulty">Difficulty</label>');
    expect(html).toContain('<select id="solo-bot-difficulty"');
    for (const difficulty of ["easy", "normal", "hard"]) expect(html).toContain(`<option value="${difficulty}"`);
    expect(html.match(/<button\b[^>]*id="solo-button"[^>]*>Play single player<\/button>/gu)).toHaveLength(1);
    expect(html.indexOf('id="solo-button"')).toBeLessThan(html.indexOf('<summary>Race options</summary>'));
    expect(html.indexOf('id="solo-button"')).toBeLessThan(html.indexOf('id="garage-panel"'));
    expect(html).toMatch(/<input\b[^>]*id="driving-assist"[^>]*\bchecked\b/u);
    expect(html.match(/<input\b[^>]*id="guest-name"[^>]*>/u)?.[0]).not.toContain("required");
  });

  test("keeps both private multiplayer actions available", () => {
    expect(html).toContain('<button id="create-button" type="button" disabled>Create Room</button>');
    expect(html).toContain('<button id="join-button" type="button" disabled>Join Room</button>');
  });
});
