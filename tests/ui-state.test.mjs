import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";

const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const scripts = [...html.matchAll(/<script(?: id="[^"]+")?>([\s\S]*?)<\/script>/g)].map(match => match[1]);

// These small DOM doubles check state transitions, not browser rendering or downloads.
function setup() {
  const downloads = [];
  const urls = new Map();
  const timers = [];
  class Element {
    constructor(tag = "div") {
      this.tag = tag;
      this.children = [];
      this.handlers = new Map();
      this.disabled = false;
      this.hidden = false;
      this.value = "";
      this.files = [];
      this.classList = { toggle() {} };
    }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) {
      this.children = children;
      if (this.tag === "select") this.value = children[0]?.value || "";
    }
    addEventListener(name, handler) { this.handlers.set(name, handler); }
    async dispatch(name) { return this.handlers.get(name)?.(); }
    click() { if (this.tag === "a") downloads.push({ url: this.href, name: this.download, blob: urls.get(this.href) }); }
    remove() {}
  }
  const elements = new Map();
  for (const match of html.matchAll(/<(\w+)\b[^>]*\bid="([^"]+)"[^>]*>/g)) {
    const node = new Element(match[1]);
    node.disabled = /\bdisabled\b/.test(match[0]);
    node.hidden = /\bhidden\b/.test(match[0]);
    elements.set(match[2], node);
  }
  const document = { getElementById: id => elements.get(id) || null, createElement: tag => new Element(tag), body: new Element("body") };
  function Option(text, value) { this.textContent = text; this.value = value; }
  const context = vm.createContext({ document, Option, TextDecoder, TextEncoder, Blob,
    URL: { createObjectURL(blob) { const url = "blob:fixture/" + urls.size; urls.set(url, blob); return url; }, revokeObjectURL(url) { urls.delete(url); } },
    setTimeout(callback) { timers.push(callback); } });
  vm.runInContext(scripts.join("\n"), context);
  function file(name, content) { const bytes = new TextEncoder().encode(content); return { name, size: bytes.length, arrayBuffer: async () => bytes.buffer }; }
  return { get: id => elements.get(id), downloads, timers, urls, file };
}

test("sample downloads the current report and key changes invalidate it", async () => {
  const ui = setup();
  assert.equal(ui.get("save-report").disabled, true);
  await ui.get("try-sample").dispatch("click");
  assert.equal(ui.get("save-report").disabled, false);
  await ui.get("save-report").dispatch("click");
  assert.equal(ui.downloads.length, 1);
  assert.match(ui.downloads[0].name, /^csv-diff-report-.*\.html$/);
  const body = await ui.downloads[0].blob.text();
  assert.match(body, /架空の商品一覧を使ったサンプル/);
  assert.match(body, /<td>P101<\/td><td>価格<\/td><td>500<\/td><td>550<\/td>/);
  ui.get("key-column").value = "商品名";
  await ui.get("key-column").dispatch("change");
  assert.equal(ui.get("save-report").disabled, true);
  assert.equal(ui.get("results").hidden, true);
  await ui.get("save-report").dispatch("click");
  assert.equal(ui.downloads.length, 1, "stale handler cannot export an old snapshot");
  for (const timer of ui.timers) timer();
  assert.equal(ui.urls.size, 0);
});

test("new files and invalid input clear old reports; valid files produce fresh metadata", async () => {
  const ui = setup();
  await ui.get("try-sample").dispatch("click");
  ui.get("old-file").files = [ui.file("元の一覧.csv", "ID,番号\nA,00123\n")];
  ui.get("new-file").files = [ui.file("変更した一覧.csv", "ID,番号\nA,123\n")];
  await ui.get("old-file").dispatch("change");
  assert.equal(ui.get("save-report").disabled, true);
  await ui.get("save-report").dispatch("click");
  assert.equal(ui.downloads.length, 0);
  ui.get("key-column").value = "ID";
  await ui.get("key-column").dispatch("change");
  await ui.get("compare").dispatch("click");
  await ui.get("save-report").dispatch("click");
  const body = await ui.downloads[0].blob.text();
  assert.match(body, /元の一覧\.csv/);
  assert.match(body, /変更した一覧\.csv/);
  assert.doesNotMatch(body, /架空の商品一覧を使ったサンプル/);
  assert.match(body, /<td>A<\/td><td>番号<\/td><td>00123<\/td><td>123<\/td>/);
  ui.get("new-file").files = [ui.file("壊れた一覧.csv", "ID,番号\nA,123,extra\n")];
  await ui.get("new-file").dispatch("change");
  assert.equal(ui.get("save-report").disabled, true);
  assert.equal(ui.get("results").hidden, true);
  assert.match(ui.get("file-status").textContent, /列の数/);
  await ui.get("save-report").dispatch("click");
  assert.equal(ui.downloads.length, 1);
});
