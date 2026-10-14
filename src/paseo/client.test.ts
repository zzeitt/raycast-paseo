import { describe, expect, it } from "vitest";
import { describeConnectionError } from "./client";

const endpoint = { host: "127.0.0.1:6767", home: "C:/home/.paseo" };

describe("describeConnectionError", () => {
  it("explains a refused connection with a next step", () => {
    const message = describeConnectionError(new Error("connect ECONNREFUSED 127.0.0.1:6767"), endpoint);
    expect(message).toContain("Paseo desktop app");
    expect(message).toContain("127.0.0.1:6767");
  });

  it("mentions the unreadable credential when auth fails", () => {
    const message = describeConnectionError(new Error("Unauthorized"), endpoint);
    expect(message).toContain("local-credential");
  });

  it("names the credential path with a real separator", () => {
    const message = describeConnectionError(new Error("Unauthorized"), endpoint);
    expect(message).toContain("C:/home/.paseo\\local-credential");
  });

  it("passes unknown errors through without inventing advice", () => {
    const message = describeConnectionError(new Error("boom"), endpoint);
    expect(message).toContain("boom");
  });
});
