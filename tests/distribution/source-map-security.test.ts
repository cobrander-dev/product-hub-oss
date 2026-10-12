import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const next = createRequire(require.resolve("next/package.json"));
const postcss = createRequire(next.resolve("postcss/package.json"));
const tailwind = createRequire(require.resolve("@tailwindcss/postcss"));
const contexts = [
  postcss,
  createRequire(tailwind.resolve("postcss/package.json")),
  createRequire(tailwind.resolve("@tailwindcss/node")),
];
const basic = {
  version: 3,
  sources: ["input.css"],
  sourcesContent: ["a { color: red }"],
  names: [],
  mappings: "AAAA",
  file: "output.css",
};
function indexed(line: unknown, column: unknown = 0, map: object = basic) {
  return { version: 3, sections: [{ offset: { line, column }, map }] };
}

test("every Next/PostCSS/Tailwind resolution uses the patched source-map-js", () => {
  for (const context of contexts)
    assert.equal(context("source-map-js/package.json").version, "1.2.2");
});

test("indexed source maps reject oversized, invalid and cumulative offsets at construction", () => {
  for (const context of contexts) {
    const { SourceMapConsumer } = context("source-map-js");
    // Construction is bounded even on the old version: do not flatten a hostile
    // map in this regression test and risk hanging the test runner.
    for (const line of [10_000_001, Infinity, NaN, -1, 0.5, "1"])
      assert.throws(() => new SourceMapConsumer(indexed(line)), /offset/i);
    for (const column of [Infinity, NaN, -1, 0.5, "1"])
      assert.throws(() => new SourceMapConsumer(indexed(0, column)), /offset/i);
    assert.throws(
      () => new SourceMapConsumer(indexed(6_000_000, 0, indexed(6_000_000))),
      /offset/i,
    );
  }
});

test("ordinary basic/indexed maps and PostCSS previous maps remain usable", async () => {
  const { SourceMapConsumer, SourceMapGenerator, SourceNode } =
    postcss("source-map-js");
  const generator = new SourceMapGenerator({ file: "output.css" });
  generator.addMapping({
    generated: { line: 1, column: 0 },
    original: { line: 1, column: 0 },
    source: "input.css",
    name: "selector",
  });
  generator.setSourceContent("input.css", basic.sourcesContent[0]);
  const consumer = new SourceMapConsumer(generator.toJSON());
  assert.equal(
    consumer.originalPositionFor({ line: 1, column: 0 }).source,
    "input.css",
  );
  assert.equal(
    SourceNode.fromStringWithSourceMap(
      basic.sourcesContent[0],
      consumer,
    ).toString(),
    basic.sourcesContent[0],
  );
  const sections = new SourceMapConsumer(indexed(2));
  const positions: { generatedLine: number; source: string }[] = [];
  sections.eachMapping((position: { generatedLine: number; source: string }) =>
    positions.push(position),
  );
  assert.equal(positions[0]?.generatedLine, 3);
  assert.equal(positions[0]?.source, "input.css");
  assert.equal(sections.sourceContentFor("input.css"), basic.sourcesContent[0]);
  const result = await postcss("postcss")([]).process(basic.sourcesContent[0], {
    from: "input.css",
    to: "output.css",
    map: { prev: basic, inline: false, annotation: false },
  });
  assert.equal(result.css, basic.sourcesContent[0]);
  assert.ok(result.map?.toJSON().sources.includes("input.css"));
});

test("PostCSS rejects hostile indexed previous maps through its real consumer", () => {
  const PreviousMap = postcss("./lib/previous-map.js");
  const previous = new PreviousMap(basic.sourcesContent[0], {
    map: { prev: indexed(10_000_001) },
  });
  assert.throws(() => previous.consumer(), /offset/i);
});
