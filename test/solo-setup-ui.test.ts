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
    expect(html).toContain('<button id="solo-button" type="button" disabled>Start Solo Race</button>');
  });

  test("keeps both private multiplayer actions available", () => {
    expect(html).toContain('<button id="create-button" type="button" disabled>Create Room</button>');
    expect(html).toContain('<button id="join-button" type="button" disabled>Join Room</button>');
  });
});
