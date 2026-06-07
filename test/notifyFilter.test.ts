import { describe, it, expect } from "vitest";
import { parseAllowlist, filterChannels } from "../src/notifyFilter.js";

describe("parseAllowlist", () => {
  it("カンマ区切りをトリム・小文字化して集合にする", () => {
    const set = parseAllowlist("Foo, BAR ,baz");
    expect([...set]).toEqual(["foo", "bar", "baz"]);
  });

  it("未設定・空文字なら空集合", () => {
    expect(parseAllowlist(undefined).size).toBe(0);
    expect(parseAllowlist("").size).toBe(0);
    expect(parseAllowlist("  ").size).toBe(0);
  });

  it("空要素（連続カンマや末尾カンマ）は除去する", () => {
    const set = parseAllowlist("foo,,bar,");
    expect([...set]).toEqual(["foo", "bar"]);
  });

  it("重複は集合なので1つにまとまる", () => {
    const set = parseAllowlist("foo,Foo,FOO");
    expect([...set]).toEqual(["foo"]);
  });
});

describe("filterChannels", () => {
  const logins = ["shroud", "k4sen", "someone"];

  it("allowlist が空なら全件をそのまま返す", () => {
    expect(filterChannels(logins, new Set())).toEqual(logins);
  });

  it("allowlist に含まれる login だけを返す", () => {
    const allow = parseAllowlist("shroud,k4sen");
    expect(filterChannels(logins, allow)).toEqual(["shroud", "k4sen"]);
  });

  it("大文字小文字を無視して照合する", () => {
    const allow = parseAllowlist("SHROUD");
    expect(filterChannels(["Shroud", "k4sen"], allow)).toEqual(["Shroud"]);
  });

  it("allowlist にしか無いチャンネルは結果に出ない（ライブ配信のみが対象）", () => {
    const allow = parseAllowlist("shroud,notlive");
    expect(filterChannels(logins, allow)).toEqual(["shroud"]);
  });
});
