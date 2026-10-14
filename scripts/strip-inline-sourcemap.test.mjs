import { describe, expect, it } from "vitest";
import { isPublishableAsIs, stripInlineSourcemap } from "./strip-inline-sourcemap.mjs";

const b64 = (text) => Buffer.from(text, "utf8").toString("base64");

describe("stripInlineSourcemap", () => {
  it("extracts the trailing inline map and points the comment at a same-named .map", () => {
    const source = `var a=1;\n//# sourceMappingURL=data:application/json;base64,${b64('{"version":3,"sources":["a.ts"]}')}\n`;

    expect(stripInlineSourcemap(source, "ask.js.map")).toEqual({
      code: "var a=1;\n//# sourceMappingURL=ask.js.map\n",
      map: '{"version":3,"sources":["a.ts"]}',
    });
  });

  it("extracts the map whether the end has no newline or a few extra newlines", () => {
    const uri = `data:application/json;base64,${b64('{"version":3}')}`;

    expect(stripInlineSourcemap(`var a=1;\n//# sourceMappingURL=${uri}`, "ask.js.map")?.code).toBe(
      "var a=1;\n//# sourceMappingURL=ask.js.map\n",
    );
    expect(stripInlineSourcemap(`var a=1;\n//# sourceMappingURL=${uri}\n\n`, "ask.js.map")?.code).toBe(
      "var a=1;\n//# sourceMappingURL=ask.js.map\n",
    );
  });

  it("leaves a file that already uses an external map untouched", () => {
    expect(stripInlineSourcemap("var a=1;\n//# sourceMappingURL=ask.js.map\n", "ask.js.map")).toBeNull();
  });

  it("leaves a file with no map untouched", () => {
    expect(stripInlineSourcemap("var a=1;\n", "ask.js.map")).toBeNull();
  });

  it("a base64 string appearing in the middle of the source is not mistaken for a map", () => {
    const source = `var a="data:application/json;base64,${b64('{"version":3}')}";\nvar b=2;\n`;

    expect(stripInlineSourcemap(source, "ask.js.map")).toBeNull();
  });
});

describe("isPublishableAsIs", () => {
  it("refuses a bundle caught mid-write, whose unflushed tail reads back as NULs", () => {
    // What the app directory actually held once: 9.6 MB of real code + inline map, then 3.9 MB of
    // zero bytes where the build had not flushed yet. Raycast parses that as a 21 MB base64 string
    // literal and reports "Command terminated after reaching the extension memory limit".
    const source = `var a=1;\n//# sourceMappingURL=data:application/json;base64,${b64('{"version":3}')}\n${"\0".repeat(64)}`;

    expect(isPublishableAsIs(source)).toBe(false);
  });

  it("refuses a bundle still carrying an inline map we failed to strip", () => {
    const source = `var a=1;\n//# sourceMappingURL=data:application/json;base64,${b64('{"version":3}')}\n`;

    expect(isPublishableAsIs(source)).toBe(false);
  });

  it("accepts a bundle with no map at all", () => {
    expect(isPublishableAsIs("var a=1;\n")).toBe(true);
  });

  it("accepts a bundle already pointing at an external map", () => {
    expect(isPublishableAsIs("var a=1;\n//# sourceMappingURL=ask.js.map\n")).toBe(true);
  });

  it("accepts a bundle carrying base64 data that is not a map", () => {
    const source = `var a="data:application/json;base64,${b64('{"version":3}')}";\nvar b=2;\n`;

    expect(isPublishableAsIs(source)).toBe(true);
  });
});
