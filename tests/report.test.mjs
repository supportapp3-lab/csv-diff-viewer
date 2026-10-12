import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";

const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const scripts = [...html.matchAll(/<script(?: id="[^"]+")?>([\s\S]*?)<\/script>/g)].map(match => match[1]);
const context = vm.createContext({ TextDecoder, TextEncoder });
vm.runInContext(scripts.slice(0, 2).join("\n"), context);
const core = vm.runInContext("CsvDiff", context);
const report = vm.runInContext("CsvDiffReport", context);
const comparedAt = new Date("2026-10-12T04:00:00.000Z");
function snapshot(before, after, key = "ID", metadata = {}) {
  return { diff: core.compareCsv(core.parseCsv(before), core.parseCsv(after), key), key,
    beforeName: "編集前.csv", afterName: "編集後.csv", comparedAt, isSample: false, ...metadata };
}
const before = "ID,商品番号,商品名,価格,サイズ\nA101,00101,コーヒー,500,小\nA102,00102,釣り針,300,1/0\nA103,00123,収納箱,800,中\n";
const after = "ID,商品番号,商品名,価格,サイズ\nA103,123,収納箱,800,中\nA101,00101,コーヒー,550,小\nA102,00102,釣り針,300,Jan-00\n";

test("article example preserves Japanese, leading zeros, dates and three changed rows", () => {
  const output = report.create(snapshot(before, after));
  assert.match(output, /編集前\.csv/);
  assert.match(output, /編集後\.csv/);
  assert.match(output, /行を照合した列：ID/);
  assert.match(output, /datetime="2026-10-12T04:00:00\.000Z"/);
  assert.match(output, /変更：3行/);
  assert.match(output, /<td>A101<\/td><td>価格<\/td><td>500<\/td><td>550<\/td>/);
  assert.match(output, /<td>A102<\/td><td>サイズ<\/td><td>1\/0<\/td><td>Jan-00<\/td>/);
  assert.match(output, /<td>A103<\/td><td>商品番号<\/td><td>00123<\/td><td>123<\/td>/);
});

test("all 251 changed cells are exported regardless of screen pagination", () => {
  const rows = Array.from({ length: 251 }, (_, i) => `ID${i},${i}`);
  const updated = rows.map(row => `${row}x`);
  const output = report.create(snapshot(`ID,値\n${rows.join("\n")}\n`, `ID,値\n${updated.join("\n")}\n`));
  assert.equal((output.match(/<tr>/g) || []).length, 252);
  assert.match(output, /変更：251行/);
  assert.match(output, /<td>ID250<\/td><td>値<\/td><td>250<\/td><td>250x<\/td>/);
});

test("added and removed rows are complete, unchanged values are omitted", () => {
  const output = report.create(snapshot("ID,値\n001,削除前\n002,残す値\n", "ID,値\n003,追加後\n002,残す値\n"));
  assert.match(output, /追加：1行/);
  assert.match(output, /削除：1行/);
  assert.match(output, /変更なし：1行/);
  assert.match(output, /<td>001<\/td><td>削除前<\/td>/);
  assert.match(output, /<td>003<\/td><td>追加後<\/td>/);
  assert.doesNotMatch(output, /残す値/);
});

test("changed keys are deletion and addition, not inferred corrections", () => {
  const output = report.create(snapshot("ID,値\n00123,A\n", "ID,値\n123,A\n"));
  assert.match(output, /変更：0行/);
  assert.match(output, /追加：1行/);
  assert.match(output, /削除：1行/);
  assert.match(output, /<td>00123<\/td>/);
  assert.match(output, /<td>123<\/td>/);
});

test("all untrusted fields are escaped and exported HTML contains no scripts or remote resources", () => {
  const output = report.create(snapshot('ID,"<列&>"\n"<script>","<img src=x onerror=alert(1)>"\n',
    'ID,"<列&>"\n"<script>","=HYPERLINK(""x"") & \'日本語\'"\n', "ID",
    { beforeName: '<img src="x">.csv', afterName: "A&B's.csv" }));
  assert.match(output, /&lt;img src=&quot;x&quot;&gt;\.csv/);
  assert.match(output, /A&amp;B&#39;s\.csv/);
  assert.match(output, /&lt;列&amp;&gt;/);
  assert.match(output, /&lt;script&gt;/);
  assert.match(output, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(output, /=HYPERLINK\(&quot;x&quot;\) &amp; &#39;日本語&#39;/);
  assert.doesNotMatch(output, /<script\b|<img\b|<iframe\b|<a\s/i);
  assert.match(output, /default-src 'none'/);
});

test("empty cells, whitespace and quoted multiline values are readable", () => {
  const output = report.create(snapshot('ID,値\n1," a\nb "\n', 'ID,値\n1,\n'));
  assert.match(output, /<td> a\nb <\/td>/);
  assert.match(output, /<span class="empty-cell">（空欄）<\/span>/);
});

test("sample notice is explicit and no-change reports remain valid", () => {
  const input = "ID,値\n1,同じ\n";
  const output = report.create(snapshot(input, input, "ID", { isSample: true }));
  assert.match(output, /架空の商品一覧を使ったサンプル/);
  assert.match(output, /変更なし：1行/);
  assert.equal((output.match(/該当する行はありません/g) || []).length, 3);
});

test("HTML size is bounded in UTF-8 bytes with valid input files, and no truncated report is returned", () => {
  function inputs(count) {
    const rows = Array.from({ length: count }, (_, i) => `A${i},${Array(4).fill("x".repeat(1000)).join(",")}`);
    const changed = rows.map(row => row.replaceAll("x", "&"));
    return ["ID,a,b,c,d\n" + rows.join("\n"), "ID,a,b,c,d\n" + changed.join("\n")];
  }
  const small = inputs(200);
  const output = report.create(snapshot(...small));
  assert.ok(Buffer.byteLength(output, "utf8") < 8 * 1024 * 1024);
  const large = inputs(500);
  for (const input of large) assert.ok(Buffer.byteLength(input, "utf8") <= core.MAX_BYTES);
  assert.throws(() => report.create(snapshot(...large)), error => error.message === report.SIZE_ERROR);
  const base = snapshot("ID,値\n1,日本語\n", "ID,値\n1,日本語変更\n");
  assert.throws(() => report.create({ ...base, beforeName: "あ".repeat(3 * 1024 * 1024) }), /8 MiB/);
});
