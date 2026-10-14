import { describe, expect, it } from "vitest";
import { decodeSnappyBlock } from "./snappy";
import { snappyCopyShort, snappyLiteral, varint } from "./test-utils/binary-fixtures";

describe("decodeSnappyBlock", () => {
  it("decodes a stream that is one literal", () => {
    const block = snappyLiteral("daemon-registry");
    expect(decodeSnappyBlock(block, 0)?.toString("utf8")).toBe("daemon-registry");
  });

  it("decodes a literal longer than the single-byte tag can hold", () => {
    const text = "x".repeat(200);
    const block = snappyLiteral(text);
    expect(decodeSnappyBlock(block, 0)?.toString("utf8")).toBe(text);
  });

  it("starts at the offset it is given", () => {
    const block = Buffer.concat([Buffer.from([0xde, 0xad]), snappyLiteral("paseo")]);
    expect(decodeSnappyBlock(block, 2)?.toString("utf8")).toBe("paseo");
  });

  it("expands a copy element against what it already decoded", () => {
    // "a" followed by a five-byte copy from one byte back is "aaaaaa".
    const block = Buffer.concat([
      varint(6),
      snappyLiteral("a").subarray(1),
      snappyCopyShort(1, 5),
    ]);
    expect(decodeSnappyBlock(block, 0)?.toString("utf8")).toBe("aaaaaa");
  });

  it("returns null rather than guessing when the bytes are not a snappy stream", () => {
    expect(decodeSnappyBlock(Buffer.from([0xff, 0xff, 0xff, 0xff]), 0)).toBeNull();
  });

  it("returns null when the stream is cut short", () => {
    const block = snappyLiteral("truncated");
    expect(decodeSnappyBlock(block.subarray(0, block.length - 3), 0)).toBeNull();
  });
});
