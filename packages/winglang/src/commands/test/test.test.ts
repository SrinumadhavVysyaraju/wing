import fs from "fs";
import fsPromises from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { BuiltinPlatform } from "@winglang/compiler";
import { LogLevel, TestResult, TraceType } from "@winglang/sdk/lib/std";
import chalk from "chalk";
import { describe, test, expect, beforeEach, afterEach, vi, MockInstance } from "vitest";
import { filterTests, renderTestReport, collectTestFiles, test as wingTest } from ".";
import * as resultsFn from "./results";
import { SnapshotMode } from "./snapshots";

const defaultChalkLevel = chalk.level;
const cwd = process.cwd();

describe("printing test reports", () => {
  beforeEach(() => {
    chalk.level = 0;
  });

  afterEach(() => {
    chalk.level = defaultChalkLevel;
    process.chdir(cwd);
  });

  test("verbose traces are not shown if debug mode is disabled", async () => {
    const testReport = await renderTestReport("hello.w", EXAMPLE_TEST_RESULTS);

    expect(testReport).toMatchSnapshot();
    expect(testReport).not.toContain("Push (message=cool)");
  });

  test("verbose traces are shown if debug mode is enabled", async () => {
    const oldDebug = process.env.DEBUG;
    process.env.DEBUG = "1";

    const testReport = await renderTestReport("hello.w", EXAMPLE_TEST_RESULTS);

    if (oldDebug) {
      process.env.DEBUG = oldDebug;
    } else {
      delete process.env.DEBUG;
    }

    expect(testReport).toMatchSnapshot();
    expect(testReport).toContain("Push (message=cool)");
  });

  test("results for files with no tests", async () => {
    let inputResults: TestResult[] = [];
    const testReport = await renderTestReport("hello.w", inputResults);

    expect(testReport).toMatchSnapshot();
    expect(testReport).toContain("(no tests)");

    // verify that the the no dummy test results were added
    expect(inputResults).toHaveLength(0);
  });
});

describe("wing test (custom platform)", () => {
  let logSpy: MockInstance;

  beforeEach(() => {
    chalk.level = 0;
    logSpy = vi.spyOn(console, "log");
  });

  afterEach(() => {
    chalk.level = defaultChalkLevel;
    process.chdir(cwd);
    logSpy.mockRestore();
  });

  test("test runner is loaded properly for customized tf-aws platform", async () => {
    const outDir = await fsPromises.mkdtemp(join(tmpdir(), "-wing-compile-test"));

    // can't be resolved within tmp directory
    const targetTfAws = require.resolve("@winglang/sdk/lib/target-tf-aws/platform");

    process.chdir(outDir);
    fs.writeFileSync("foo.test.w", `bring cloud;`);
    fs.writeFileSync(
      "custom-platform.js",
      `
      const tfaws = require("${targetTfAws}");
      class Platform extends tfaws.Platform {

        newApp(appProps) {
          return super.newApp(appProps);
        }

        async createTestHarness() {
          return super.createTestHarness();
        }
      }
      module.exports = { Platform }`,
    );

    // entrypoint array is empty because foo.test.w is inferred as the only entrypoint
    await wingTest([], {
      clean: true,
      platform: ["./custom-platform.js"],
      snapshots: SnapshotMode.NEVER,
    });

    expect(logSpy).toHaveBeenCalledWith(
      expect.stringMatching(/^pass ─ foo\.test\.tfaws\.\d+ \(no tests\)$/),
    );
  });
});

describe("collectTestFiles", () => {
  test("default entrypoints", async () => {
    const outDir = await fsPromises.mkdtemp(join(tmpdir(), "-wing-compile-test"));

    process.chdir(outDir);
    fs.writeFileSync("foo.test.w", "");
    fs.writeFileSync("bar.test.w", "");
    fs.writeFileSync("baz.test.w", "");
    fs.writeFileSync("main.ts", "");

    const files = await collectTestFiles([]);

    expect(files).toMatchInlineSnapshot(`
      [
        "main.ts",
        "foo.test.w",
        "baz.test.w",
        "bar.test.w",
      ]
    `);
  });

  test("specific entrypoint", async () => {
    const outDir = await fsPromises.mkdtemp(join(tmpdir(), "-wing-compile-test"));

    process.chdir(outDir);
    fs.writeFileSync("foo.test.w", "");
    fs.writeFileSync("bar.test.w", "");
    fs.writeFileSync("baz.test.w", "");

    const files = await collectTestFiles(["foo.test.w"]);

    expect(files).toMatchInlineSnapshot(`
      [
        "foo.test.w",
      ]
    `);
  });

  test("fuzzy match dir", async () => {
    const outDir = await fsPromises.mkdtemp(join(tmpdir(), "-wing-compile-test"));

    process.chdir(outDir);
    fs.mkdirSync("foo");
    fs.writeFileSync("foo/a.test.w", "");
    fs.writeFileSync("foo/b.test.w", "");
    fs.writeFileSync("foo.test.w", "");
    fs.writeFileSync("baz.test.w", "");

    const files = await collectTestFiles(["foo"]);

    expect(files).toMatchInlineSnapshot(`
      [
        "foo.test.w",
        "foo/b.test.w",
        "foo/a.test.w",
      ]
    `);
  });

  test("absolute path dedupe", async () => {
    const outDir = await fsPromises.mkdtemp(join(tmpdir(), "-wing-compile-test"));

    process.chdir(outDir);
    fs.mkdirSync("foo");
    fs.writeFileSync("foo/a.test.w", "");
    fs.writeFileSync("foo/b.test.w", "");
    fs.writeFileSync("foo.test.w", "");
    fs.writeFileSync("baz.test.w", "");

    const files = await collectTestFiles(["foo"]);

    expect(files).toMatchInlineSnapshot(`
    [
      "foo.test.w",
      "foo/b.test.w",
      "foo/a.test.w",
    ]
  `);
  });

  test("testing file outside current dir", async () => {
    const outDir = await fsPromises.mkdtemp(join(tmpdir(), "-wing-compile-test"));
    const subDir = join(outDir, "subdir");

    process.chdir(outDir);

    fs.writeFileSync("foo.test.w", "");

    fs.mkdirSync(subDir);

    process.chdir(subDir);

    fs.writeFileSync("main.w", "");

    const files = await collectTestFiles(["../foo.test.w"]);

    expect(files).toMatchInlineSnapshot(`
      [
        "../foo.test.w",
      ]
    `);
  });
});

describe("output-file option", () => {
  let writeResultsSpy: MockInstance;

  beforeEach(() => {
    chalk.level = 0;
    writeResultsSpy = vi.spyOn(resultsFn, "writeResultsToFile");
  });

  afterEach(() => {
    chalk.level = defaultChalkLevel;
    process.chdir(cwd);
    writeResultsSpy.mockRestore();
  });

  test("wing test with output file calls writeResultsToFile", async () => {
    const outDir = await fsPromises.mkdtemp(join(tmpdir(), "-wing-compile-test"));

    process.chdir(outDir);
    fs.writeFileSync("test.test.w", EXAMPLE_TEST);
    console.log(outDir);

    const outputFile = "out.json";

    await wingTest(["test.test.w"], {
      clean: true,
      platform: [BuiltinPlatform.SIM],
      outputFile,
      rootId: "root",
    });

    expect(writeResultsSpy).toBeCalledTimes(1);
    const { testName, results } = writeResultsSpy.mock.calls[0][0][0];
    expect(results).toMatchObject(BUCKET_TEST_RESULT);
    expect(testName).toBe("test.test.w");
    expect(writeResultsSpy.mock.calls[0][2]).toBe(outputFile);

    const outputFileExists = fs.existsSync(outputFile);
    expect(outputFileExists).toBe(true);
    const outputContents = fs.readFileSync(outputFile, "utf-8");
    expect(JSON.parse(outputContents)).toMatchObject(OUTPUT_FILE);
  });

  test("wing test without output file calls writeResultsToFile", async () => {
    const outDir = await fsPromises.mkdtemp(join(tmpdir(), "-wing-compile-test"));

    process.chdir(outDir);
    fs.writeFileSync("test.test.w", EXAMPLE_TEST);

    await wingTest(["test.test.w"], {
      clean: true,
      platform: [BuiltinPlatform.SIM],
    });
    expect(writeResultsSpy).toBeCalledTimes(0);
  });

  test("validate output file", () => {
    expect(resultsFn.validateOutputFilePath("/path/out.json")).toBeUndefined();
    expect(resultsFn.validateOutputFilePath("out.json")).toBeUndefined();

    expect(() => resultsFn.validateOutputFilePath("/path/out.csv")).toThrow(
      'only .json output files are supported. (found ".csv")',
    );

    expect(() => resultsFn.validateOutputFilePath("/path/json")).toThrow(
      'only .json output files are supported. (found "")',
    );
  });
});

describe("test-filter option", () => {
  beforeEach(() => {
    chalk.level = 0;
  });

  afterEach(() => {
    chalk.level = defaultChalkLevel;
  });

  test("wing test (no test-filter)", () => {
    const filteredTests = filterTests(EXAMPLE_UNFILTERED_TESTS);

    expect(filteredTests.length).toBe(3);
    expect(filteredTests[0]).toBe("root/env0/test:get()");
    expect(filteredTests[1]).toBe("root/env1/test:get:At()");
    expect(filteredTests[2]).toBe("root/env2/test:stringify()");
  });

  test("wing test --test-filter <regex>", () => {
    const filteredTests = filterTests(EXAMPLE_UNFILTERED_TESTS, "get");

    expect(filteredTests.length).toBe(2);
    expect(filteredTests[0]).toBe("root/env0/test:get()");
    expect(filteredTests[1]).toBe("root/env1/test:get:At()");
  });
});

describe("retry and parallel options", () => {
  let logSpy: MockInstance;

  beforeEach(() => {
    chalk.level = 0;
    logSpy = vi.spyOn(console, "log");
  });

  afterEach(() => {
    chalk.level = defaultChalkLevel;
    process.chdir(cwd);
    logSpy.mockRestore();
  });

  test("wing test (no retry)", async () => {
    const outDir = await fsPromises.mkdtemp(join(tmpdir(), "-wing-retry-test"));

    process.chdir(outDir);
    // Create a test that will consistently fail
    fs.writeFileSync(
      "fail.test.w",
      `
        bring cloud;
        test "alwaysFail" {
          assert(false);
        }
      `,
    );

    await wingTest(["fail.test.w"], {
      clean: true,
      platform: [BuiltinPlatform.SIM],
    });

    const retryLogs = logSpy.mock.calls.filter((args) => args[0].includes("Retrying"));
    expect(retryLogs.length).toBe(0);
  });

  test("wing test --retry [retries]", async () => {
    const outDir = await fsPromises.mkdtemp(join(tmpdir(), "-wing-retry-test"));

    process.chdir(outDir);
    // Create a test that will consistently fail
    fs.writeFileSync(
      "fail.test.w",
      `
        bring cloud;
        test "alwaysFail" {
          assert(false);
        }
      `,
    );

    // Equivalent to `wing test --retry` (default 3 retries)
    await wingTest(["fail.test.w"], {
      clean: true,
      platform: [BuiltinPlatform.SIM],
      retry: 3,
    });

    const retryLogs = logSpy.mock.calls.filter((args) => args[0].includes("Retrying"));
    expect(retryLogs.length).toBe(2);
  });

  test("wing test --parallel [batch]", async () => {
    const outDir = await fsPromises.mkdtemp(join(tmpdir(), "-wing-batch-test"));

    process.chdir(outDir);

    fs.writeFileSync(
      "t1.test.w",
      `
bring util;

test "t1" {
  util.sleep(1s);
  log("t1 ends");
  assert(true);
}
  `,
    );
    fs.writeFileSync(
      "t2.test.w",
      `
bring util;

test "t2" {
  log("t2 ends");
  assert(true);
}
  `,
    );

    await wingTest(["t1.test.w", "t2.test.w"], {
      clean: true,
      platform: [BuiltinPlatform.SIM],
      parallel: 1,
    });
    // we are running the tests one by one so first t1 should log and then t2
    const t1Ends = logSpy.mock.calls.findIndex((args) => args[0].includes("t1 ends"));
    const t2Ends = logSpy.mock.calls.findIndex((args) => args[0].includes("t2 ends"));

    expect(t2Ends).toBeGreaterThan(t1Ends);
  });

  test("wing test --parallel 2", async () => {
    const outDir = await fsPromises.mkdtemp(join(tmpdir(), "-wing-batch-test"));

    process.chdir(outDir);

    fs.writeFileSync(
      "t1.test.w",
      `
bring util;

test "t1" {
util.sleep(1s);
log("t1 ends");
assert(true);
}
  `,
    );
    fs.writeFileSync(
      "t2.test.w",
      `
bring util;

test "t2" {
  log("t2 ends");
  assert(true);
}
  `,
    );

    await wingTest(["t1.test.w", "t2.test.w"], {
      clean: true,
      platform: [BuiltinPlatform.SIM],
      parallel: 2,
    });
    // we are running the tests in parallel so first t2 should log and then t1
    const t2Ends = logSpy.mock.calls.findIndex((args) => args[0].includes("t2 ends"));
    const t1Ends = logSpy.mock.calls.findIndex((args) => args[0].includes("t1 ends"));

    expect(t2Ends).toBeLessThan(t1Ends);
  });
});

const EXAMPLE_TEST_RESULTS: Array<TestResult> = [
  {
    path: "root/env0/test:test",
    pass: false,
    error: "Error: Object does not exist (key=file.txt)",
    traces: [
      {
        data: { message: "Push (message=cool).", status: "success" },
        type: TraceType.RESOURCE,
        level: LogLevel.VERBOSE,
        sourcePath: "root/env0/MyProcessor/cloud.Queue",
        sourceType: "@winglang/sdk.cloud.Queue",
        timestamp: "2023-05-15T16:20:46.886Z",
      },
      {
        data: { message: "sleeping for 500 ms" },
        type: TraceType.LOG,
        level: LogLevel.INFO,
        sourcePath: "root/env0/test:test/Handler",
        sourceType: "@winglang/sdk.cloud.Function",
        timestamp: "2023-05-15T16:20:46.887Z",
      },
      {
        type: TraceType.RESOURCE,
        data: { message: 'Sending messages (messages=["cool"], subscriber=sim-4).' },
        level: LogLevel.VERBOSE,
        sourcePath: "root/env0/MyProcessor/cloud.Queue",
        sourceType: "@winglang/sdk.cloud.Queue",
        timestamp: "2023-05-15T16:20:46.961Z",
      },
      {
        data: {
          message: 'Invoke (payload="{\\"messages\\":[\\"cool\\"]}").',
        },
        type: TraceType.RESOURCE,
        level: LogLevel.VERBOSE,
        sourcePath: "root/env0/MyProcessor/cloud.Queue-AddConsumer-0088483a",
        sourceType: "@winglang/sdk.cloud.Function",
        timestamp: "2023-05-15T16:20:46.966Z",
      },
      {
        data: {
          message:
            "Subscriber error - returning 1 messages to queue: Missing environment variable: QUEUE_HANDLE_7164aec4",
        },
        sourcePath: "root/env0/MyProcessor/cloud.Queue",
        sourceType: "@winglang/sdk.cloud.Queue",
        type: TraceType.RESOURCE,
        level: LogLevel.ERROR,
        timestamp: "2023-05-15T16:20:46.966Z",
      },
      {
        data: { message: "Get (key=file.txt)." },
        type: TraceType.RESOURCE,
        level: LogLevel.VERBOSE,
        sourcePath: "root/env0/MyProcessor/Bucket",
        sourceType: "@winglang/sdk.cloud.Bucket",
        timestamp: "2023-05-15T16:20:47.388Z",
      },
      {
        data: { message: 'Invoke (payload="").' },
        type: TraceType.RESOURCE,
        level: LogLevel.VERBOSE,
        sourcePath: "root/env0/test:test/Handler",
        sourceType: "@winglang/sdk.cloud.Function",
        timestamp: "2023-05-15T16:20:47.388Z",
      },
    ],
  },
];

const EXAMPLE_TEST = `
bring cloud;
let b = new cloud.Bucket();

test "put" {
  b.put("test1.txt", "Foo");
  assert(b.get("test1.txt") == "Foo");
}
`;

const BUCKET_TEST_RESULT = [
  {
    path: "root/Default/test:put",
    pass: true,
    traces: [
      {
        data: { message: "Put (key=test1.txt).", status: "success" },
        type: "resource",
        sourcePath: "root/Default/Bucket",
        sourceType: "@winglang/sdk.cloud.Bucket",
      },
      {
        data: { message: "Get (key=test1.txt).", status: "success", result: '"Foo"' },
        type: "resource",
        sourcePath: "root/Default/Bucket",
        sourceType: "@winglang/sdk.cloud.Bucket",
      },
      {
        data: { message: "Invoke (payload=undefined).", status: "success" },
        type: "resource",
        sourcePath: "root/Default/test:put/Handler",
        sourceType: "@winglang/sdk.cloud.Function",
      },
    ],
  },
];

const OUTPUT_FILE = {
  results: {
    "test.test.w": {
      put: {
        path: "root/Default/test:put",
        pass: true,
        traces: [
          {
            data: {
              message: "Put (key=test1.txt).",
              status: "success",
            },
            type: "resource",
            sourcePath: "root/Default/Bucket",
            sourceType: "@winglang/sdk.cloud.Bucket",
          },
          {
            data: {
              message: "Get (key=test1.txt).",
              status: "success",
              result: '"Foo"',
            },
            type: "resource",
            sourcePath: "root/Default/Bucket",
            sourceType: "@winglang/sdk.cloud.Bucket",
          },
          {
            data: {
              message: "Invoke (payload=undefined).",
              status: "success",
            },
            type: "resource",
            sourcePath: "root/Default/test:put/Handler",
            sourceType: "@winglang/sdk.cloud.Function",
          },
        ],
      },
    },
  },
};

const EXAMPLE_UNFILTERED_TESTS: string[] = [
  "root/env0/test:get()",
  "root/env1/test:get:At()",
  "root/env2/test:stringify()",
];
