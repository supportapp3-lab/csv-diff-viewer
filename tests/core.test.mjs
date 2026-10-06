import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";

const root = new URL("../", import.meta.url);
const html = readFileSync(new URL("index.html", root), "utf8");
const coreScript = html.match(/<script id="csv-diff-core">([\s\S]*?)<\/script>/)?.[1];
assert.ok(coreScript, "single-file HTML must contain its testable core");
const core = vm.runInNewContext(`${coreScript}\nCsvDiff`, { TextDecoder });
const plain = value => JSON.parse(JSON.stringify(value));
const table = value => core.parseCsv(value);

test("both inline scripts parse without a build step", () => {
  const scripts = [...html.matchAll(/<script(?: id="[^"]+")?>([\s\S]*?)<\/script>/g)];
  assert.equal(scripts.length, 2);
  for (const script of scripts) assert.doesNotThrow(() => new vm.Script(script[1]));
});

test("fictional sample files produce one of each outcome", () => {
  const oldCsv = readFileSync(new URL("samples/old.csv", root), "utf8");
  const newCsv = readFileSync(new URL("samples/new.csv", root), "utf8");
  const result = plain(core.compareCsv(table(oldCsv), table(newCsv), "id"));
  assert.deepEqual(result.added.map(row => row.key), ["D"]);
  assert.deepEqual(result.removed.map(row => row.key), ["B"]);
  assert.deepEqual(result.changed, [{ key: "A", cells: [{ column: "status", oldValue: "open", newValue: "closed" }] }]);
  assert.equal(result.unchanged, 1);
});

test("header order may differ while values match by column name", () => {
  const before = table("id,name,state\n1,A,open\n");
  const after = table("state,id,name\nclosed,1,A\n");
  const result = plain(core.compareCsv(before, after, "id"));
  assert.deepEqual(result.changed[0].cells, [{ column: "state", oldValue: "open", newValue: "closed" }]);
});

test("quoted commas, newlines and doubled quotes are parsed literally", () => {
  const parsed = table('id,description\r\n1,"A,B"\r\n2,"line1\r\nline2"\r\n3,"say ""yes"""\r\n');
  assert.deepEqual(plain(parsed.rows), [["1", "A,B"], ["2", "line1\r\nline2"], ["3", 'say "yes"']]);
});

test("empty files, malformed quoting and bare CR fail", () => {
  for (const csv of ["", 'id,name\n1,"open', 'id,name\n1,ab"c', 'id,name\n1,"a"x', "id,name\r1,A"]) {
    assert.throws(() => table(csv));
  }
});

test("UTF-8 is fatal, BOM accepted and oversized files rejected", () => {
  assert.equal(core.decodeUtf8(new Uint8Array([0xef, 0xbb, 0xbf, 0x69, 0x64])), "id");
  assert.throws(() => core.decodeUtf8(new Uint8Array([0xc3, 0x28])), /UTF-8/);
  assert.throws(() => core.decodeUtf8(new Uint8Array(core.MAX_BYTES + 1)), /2 MiB/);
});

test("empty or duplicate headers and inconsistent widths fail", () => {
  for (const csv of ["id,,name\n1,A,B", "id,id\n1,2", "id,name\n1", "id,name\n1,A,B"]) {
    assert.throws(() => table(csv));
  }
});

test("column, row and Unicode character limits fail closed", () => {
  assert.throws(() => table(`${Array.from({ length: 51 }, (_, i) => `h${i}`).join(",")}\n`), /50/);
  assert.throws(() => table(`id\n${"x\n".repeat(10001)}`), /10,000/);
  assert.equal(table(`id\n${"😀".repeat(1000)}`).rows.length, 1);
  assert.throws(() => table(`id\n${"😀".repeat(1001)}`), /1,000/);
});

test("different column sets are rejected before comparison", () => {
  assert.throws(() => core.compareCsv(table("id,a\n1,x"), table("id,b\n1,x"), "id"), /列名/);
});

test("empty and duplicate keys fail in either file", () => {
  const valid = table("id,value\n1,A\n2,B");
  const empty = table("id,value\n,A");
  const duplicate = table("id,value\n1,A\n1,B");
  for (const bad of [empty, duplicate]) {
    assert.throws(() => core.compareCsv(bad, valid, "id"));
    assert.throws(() => core.compareCsv(valid, bad, "id"));
  }
  assert.throws(() => core.compareCsv(valid, valid, "missing"), /キー列/);
});

test("values and keys compare exactly without coercion or trimming", () => {
  const before = table("id,value\n1,01\n 2 ,x\n");
  const after = table("id,value\n1,1\n2,x\n");
  const result = plain(core.compareCsv(before, after, "id"));
  assert.deepEqual(result.changed[0].cells, [{ column: "value", oldValue: "01", newValue: "1" }]);
  assert.deepEqual(result.added.map(row => row.key), ["2"]);
  assert.deepEqual(result.removed.map(row => row.key), [" 2 "]);
});

test("multiple changed cells count as one changed row", () => {
  const result = plain(core.compareCsv(table("id,a,b\n1,x,y"), table("id,a,b\n1,X,Y"), "id"));
  assert.equal(result.changed.length, 1);
  assert.equal(result.changed[0].cells.length, 2);
});

test("data-like script, HTML and prototype keys stay literal", () => {
  const before = table('id,value\n__proto__,"<script>alert(1)</script>"\n');
  const after = table('id,value\n__proto__,"=HYPERLINK(\"\"x\"\")"\n');
  const result = plain(core.compareCsv(before, after, "id"));
  assert.equal(result.changed[0].key, "__proto__");
  assert.equal(result.changed[0].cells[0].oldValue, "<script>alert(1)</script>");
  assert.match(html, /cell\.textContent = value/);
  assert.doesNotMatch(html, /innerHTML|outerHTML|<script\s+src=/i);
  assert.match(html, /connect-src 'none'/);
});
