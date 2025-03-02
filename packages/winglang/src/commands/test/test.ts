import { existsSync, readFileSync, realpathSync, rmSync, statSync } from "fs";
import { basename, join, relative, resolve } from "path";
import { PromisePool } from "@supercharge/promise-pool";
import { std, simulator } from "@winglang/sdk";
import { IPlatform, ITestHarness, PlatformManager } from "@winglang/sdk/lib/platform";
import { LogLevel } from "@winglang/sdk/lib/std";
import { prettyPrintError } from "@winglang/sdk/lib/util/enhanced-error";
import chalk from "chalk";
import { glob } from "glob";
import { nanoid } from "nanoid";
import { printResults, validateOutputFilePath, writeResultsToFile } from "./results";
import { SnapshotMode, SnapshotResult, captureSnapshot, determineSnapshotMode } from "./snapshots";
import { SNAPSHOT_ERROR_PREFIX } from "./snapshots-help";
import { TraceProcessor } from "./trace-processor";
import { renderTestName } from "./util";
import { withSpinner } from "../../util";
import { compile, CompileOptions } from "../compile";
import { SpinnerStream } from "../spinner-stream";

/**
 * Options for the `test` command.
 */
export interface TestOptions extends CompileOptions {
  /**
   * Whether the output artifacts should be kept or cleaned up after the test run.
   */
  readonly clean: boolean;
  /**
   * The name of the output file.
   */
  readonly outputFile?: string;
  /**
   * String representing a regex pattern used to selectively filter which tests to run.
   */
  readonly testFilter?: string;
  /**
   * How many times failed tests should be retried. default is one
   */
  readonly retry?: number;
  /**
   * Whether to stream the logs of the test run.
   */
  readonly stream?: boolean;

  /**
   * Determine snapshot behavior.
   */
  readonly snapshots?: SnapshotMode;

  /**
   * Number of tests to be run in parallel. 0 or undefined will run all at once.
   */
  readonly parallel?: number;
}

const TEST_FILE_PATTERNS = ["**/*.test.w", "**/{main,*.main}.{w,ts}"];
const TEST_FILE_IGNORE = ["**/node_modules/**", "**/target/**"];

/**
 * Collects all the test files that should be run.
 * If no entrypoints are specified, all the entrypoint files in the current directory (recursive) are collected.
 * This excludes node_modules and target directories.
 *
 * If entrypoints are specified, only the files that contain the entrypoint string are collected.
 */
export async function collectTestFiles(entrypoints: string[] = []): Promise<string[]> {
  const expandedEntrypoints = await glob(TEST_FILE_PATTERNS, {
    ignore: TEST_FILE_IGNORE,
    absolute: false,
    posix: true,
  });

  // check if any of the entrypoints are exact files
  const exactEntrypoints = entrypoints.filter(
    (e) => statSync(e, { throwIfNoEntry: false })?.isFile() === true,
  );
  const fuzzyEntrypoints = entrypoints.filter((e) => !exactEntrypoints.includes(e));

  let finalEntrypoints: string[] = exactEntrypoints;
  if (fuzzyEntrypoints.length > 0) {
    // if entrypoints are specified, filter the expanded entrypoints to ones that contain them
    finalEntrypoints = finalEntrypoints.concat(
      expandedEntrypoints.filter((e) => fuzzyEntrypoints.some((f) => e.includes(f))),
    );
  } else if (exactEntrypoints.length === 0) {
    finalEntrypoints = finalEntrypoints.concat(expandedEntrypoints);
  }

  // dedupe based on real path, then get all paths as relative to cwd
  const cwd = process.cwd();
  return [...new Set(finalEntrypoints.map((e) => realpathSync(e)))].map((e) => relative(cwd, e));
}

export async function test(entrypoints: string[], options: TestOptions): Promise<number> {
  if (options.outputFile) {
    validateOutputFilePath(options.outputFile);
  }

  const selectedEntrypoints = await collectTestFiles(entrypoints);
  if (selectedEntrypoints.length === 0) {
    throw new Error(`No matching test or entrypoint files found: [${entrypoints.join(", ")}]`);
  }

  const platform = new PlatformManager({ platformPaths: options.platform }).primary;

  const startTime = Date.now();
  const results: SingleTestResult[] = [];
  process.env.WING_TARGET = platform.target;
  const testFile = async (
    entrypoint: string,
    retries: number = options.retry || 1,
  ): Promise<void> => {
    const testName = renderTestName(entrypoint);
    try {
      const singleTestResults = await testOne(platform, testName, entrypoint, options);
      if (singleTestResults.results.some((t) => !t.pass) && retries > 1) {
        console.log(`Retrying failed tests. ${retries - 1} retries left.`);
        return await testFile(entrypoint, retries - 1);
      }
      results.push(singleTestResults);
    } catch (error: any) {
      console.log(error.message);
      if (retries > 1) {
        console.log(`Retrying failed tests. ${retries - 1} retries left.`);
        return await testFile(entrypoint, retries - 1);
      }
      const snapshot = error.message?.startsWith(SNAPSHOT_ERROR_PREFIX)
        ? SnapshotResult.MISMATCH
        : SnapshotResult.SKIPPED;
      results.push({
        testName,
        snapshot,
        results: [
          {
            pass: false,
            unsupported: error.name === "NotImplementedError",
            unsupportedResource: (error as any).resource,
            unsupportedOperation: (error as any).operation,
            path: "*",
            error: error.message,
            traces: [],
          },
        ],
      });
    }
  };

  await PromisePool.withConcurrency(options.parallel || selectedEntrypoints.length)
    .for(selectedEntrypoints)
    .process((entrypointFile) => testFile(entrypointFile));

  const testDuration = Date.now() - startTime;
  printResults(results, testDuration);
  if (options.outputFile) {
    await writeResultsToFile(results, testDuration, options.outputFile, options.platform);
  }

  // if we have any failures, exit with 1
  for (const testSuite of results) {
    for (const r of testSuite.results) {
      if (!r.pass && !r.unsupported) {
        return 1;
      }
    }
  }

  return 0;
}

export type SingleTestResult = {
  readonly testName: string;
  readonly results: std.TestResult[];
  readonly snapshot: SnapshotResult;
};

async function testOne(
  platform: IPlatform,
  testName: string,
  entrypoint: string,
  options: TestOptions,
): Promise<SingleTestResult> {
  const target = platform.target;

  // determine snapshot behavior
  const snapshotMode = determineSnapshotMode(target, options);
  const shouldExecute = snapshotMode === SnapshotMode.NEVER || snapshotMode === SnapshotMode.DEPLOY;
  const testOptions = {
    ...options,
    rootId: (options.rootId ?? target === "sim") ? "root" : `Test.${nanoid(10)}`,
  };

  let results: std.TestResult[] = [];
  if (shouldExecute) {
    const synthDir = await withSpinner(
      `Compiling ${renderTestName(entrypoint)} to ${target}...`,
      async () =>
        compile(entrypoint, {
          ...testOptions,
          testing: true,
        }),
    );

    results = await executeTest(synthDir, platform, testOptions);
  }

  // if one of the tests failed, return the results without updating any snapshots.
  const success = !results.some((r) => !r.pass);
  let snapshot = SnapshotResult.SKIPPED;

  // if all tests pass, capture snapshots
  if (success) {
    snapshot = await captureSnapshot(entrypoint, target, options);
  }

  return {
    testName,
    results: results,
    snapshot,
  };
}

async function executeTest(
  synthDir: string,
  platform: IPlatform,
  options: TestOptions,
): Promise<std.TestResult[]> {
  const target = platform.target;

  if (!target) {
    throw new Error("Unable to execute test without a target");
  }

  // special case for simulator
  if (target === "sim") {
    return testSimulator(synthDir, options);
  }

  const harness = await platform.createTestHarness?.();
  if (!harness) {
    throw new Error(`Cannot run "wing test" against "${target}" platform`);
  }

  return executeTestInHarness(harness, synthDir, options);
}

/**
 * Render a test report for printing out to the console.
 */
export async function renderTestReport(
  entrypoint: string,
  results: std.TestResult[],
  includeLogs: boolean = true,
): Promise<string> {
  const out = new Array<string>();

  // find the longest `path` of all the tests
  const longestPath = results.reduce(
    (longest, result) => (result.path.length > longest ? result.path.length : longest),
    0,
  );

  // return early if there are no tests, return a pass output
  // to indicate that compilation and preflight checks passed
  if (results.length === 0) {
    return `${chalk.green("pass")} ─ ${basename(entrypoint)} ${chalk.gray("(no tests)")}`;
  }

  for (const result of results.sort(sortTests)) {
    const status = result.pass ? chalk.green("pass") : chalk.red("fail");

    const details = new Array<string>();

    if (includeLogs) {
      for (const trace of result.traces) {
        if (shouldSkipTrace(trace)) {
          continue;
        }

        details.push(chalk.gray(trace.data.message));
      }
    }

    // if the test failed, add the error message and trace
    if (result.error) {
      const err = await prettyPrintError(result.error, { chalk });
      details.push(...err.split("\n"));
    }

    // construct the first row of the test result by collecting the various components and joining
    // them with spaces.

    const firstRow = new Array<string>();
    firstRow.push(status);

    // if we have details, surround the rows with a box, otherwise, just print a line
    if (details.length > 0) {
      firstRow.push(chalk.gray("┌"));
    } else {
      firstRow.push(chalk.gray("─"));
    }

    firstRow.push(basename(entrypoint));
    firstRow.push(chalk.gray("»"));
    firstRow.push(chalk.whiteBright(result.path.padEnd(longestPath)));

    // okay we are ready to print the test result

    // print the primary description of the test
    out.push(firstRow.join(" "));

    // print additional rows that are related to this test
    for (let i = 0; i < details.length; i++) {
      const left = i === details.length - 1 ? "└" : "│";
      out.push(`    ${chalk.gray(` ${left} `)}${details[i]}`);
    }
  }

  return out.join("\n");
}

function testResultsContainsFailure(results: std.TestResult[]): boolean {
  return results.some((r) => !r.pass);
}

function noCleanUp(synthDir: string) {
  console.log(
    chalk.yellowBright.bold(`Cleanup is disabled!\nOutput files available at ${resolve(synthDir)}`),
  );
}

export function filterTests(tests: Array<string>, regexString?: string): Array<string> {
  if (regexString) {
    const regex = new RegExp(regexString);
    return tests.filter((t) => {
      // Extract test name from the string
      // root/env0/test:<testName>
      const firstColonIndex = t.indexOf(":");
      const testName = t.substring(firstColonIndex + 1);
      return testName ? regex.test(testName) : false;
    });
  } else {
    return tests;
  }
}

async function runTests(
  testRunner: std.ITestRunnerClient,
  tests: string[],
): Promise<std.TestResult[]> {
  const results: std.TestResult[] = [];

  for (const testPath of tests) {
    const result = await testRunner.runTest(testPath);
    results.push(result);
  }

  return results;
}

const SEVERITY_STRING = {
  [LogLevel.ERROR]: "[ERROR]",
  [LogLevel.WARNING]: "[WARNING]",
  [LogLevel.INFO]: "[INFO]",
  [LogLevel.VERBOSE]: "[VERBOSE]",
};

const LOG_STREAM_COLORS = {
  [LogLevel.ERROR]: chalk.red,
  [LogLevel.WARNING]: chalk.yellow,
  [LogLevel.INFO]: chalk.green,
  [LogLevel.VERBOSE]: chalk.gray,
};

async function formatTrace(
  trace: std.Trace,
  testName: string,
  mode: "short" | "full",
): Promise<string> {
  const level = trace.level;
  const date = new Date(trace.timestamp);
  const hours = date.getHours().toString().padStart(2, "0");
  const minutes = date.getMinutes().toString().padStart(2, "0");
  const seconds = date.getSeconds().toString().padStart(2, "0");
  const milliseconds = date.getMilliseconds().toString().padStart(3, "0");
  const timestamp = `${hours}:${minutes}:${seconds}.${milliseconds}`;

  let msg = "";
  if (mode === "full") {
    msg += chalk.dim(`[${timestamp}]`);
    msg += LOG_STREAM_COLORS[level](` ${SEVERITY_STRING[level]}`);
    msg += chalk.dim(` ${testName} » ${trace.sourcePath}`);
    msg += "\n";
    if (level === LogLevel.ERROR) {
      msg += await prettyPrintError(trace.data.error ?? trace.data.message ?? trace.data, {
        chalk,
      });
    } else {
      msg += trace.data.message;
    }
    msg += "\n\n";
    return msg;
  } else if (mode === "short") {
    msg += LOG_STREAM_COLORS[level](`${SEVERITY_STRING[level]}`);
    msg += chalk.dim(` ${testName} | `);
    if (level === LogLevel.ERROR) {
      msg += await prettyPrintError(trace.data.error ?? trace.data.message ?? trace.data, {
        chalk,
      });
    } else {
      msg += trace.data.message;
    }
    msg += "\n";
    return msg;
  } else {
    throw new Error(`Unknown mode: ${mode}`);
  }
}

function shouldSkipTrace(trace: std.Trace): boolean {
  switch (trace.level) {
    // show VERBOSE only in debug mode
    case LogLevel.VERBOSE:
      return !process.env.DEBUG;

    // show INFO, WARNING, ERROR in all cases
    case LogLevel.INFO:
    case LogLevel.WARNING:
    case LogLevel.ERROR:
      return false;
  }
}

async function testSimulator(synthDir: string, options: TestOptions) {
  const s = new simulator.Simulator({ simfile: synthDir });
  const { clean, testFilter } = options;

  let outputStream: SpinnerStream | undefined;
  let traceProcessor: TraceProcessor | undefined;

  let currentTestName: string | undefined;
  if (options.stream) {
    const printEvent = async (event: std.Trace) => {
      const testName = currentTestName ?? "(no test)";
      if (testFilter && !testName.includes(testFilter) && testName !== "(no test)") {
        // This test does not match the filter, so skip it.
        return;
      }

      if (shouldSkipTrace(event)) {
        return;
      }

      const formatStyle = process.env.DEBUG ? "full" : "short";
      const formatted = await formatTrace(event, testName, formatStyle);
      outputStream!.write(formatted);
    };

    // The simulator emits events synchronously, but formatting them needs to
    // happen asynchronously since e.g. files have to be read to format stack
    // traces. If we performed this async work inside of the `onTrace` callback,
    // we might end up with out-of-order traces, or traces getting printed (or
    // dropped) after the test has finished. TraceProcessor allows events to be
    // added to a queue and processed serially, and provides a way to safely
    // "await" the completion of the processing.
    traceProcessor = new TraceProcessor((event) => printEvent(event));

    // SpinnerStream is responsible for taking in lines of text and streaming
    // them to a TTY with a spinner, making sure to clear and re-print the
    // spinner when new lines are added.
    outputStream = new SpinnerStream(process.stdout, "Running tests...");

    s.onTrace({
      callback: (event) => {
        traceProcessor!.addEvent(event);
      },
    });
  }

  const results = [];

  try {
    const tests = s.tree().listTests();
    const filteredTests = filterTests(tests, testFilter);
    for (const t of filteredTests) {
      // Set the currentTestName so all logs emitted during this test run are
      // associated with the current test.
      currentTestName = extractTestNameFromPath(t);

      await s.start();
      const testRunner = s.getResource(
        `${options.rootId}/cloud.TestRunner`,
      ) as std.ITestRunnerClient;
      const result = await testRunner.runTest(t);
      results.push(result);
      await s.stop();
      await s.resetState();
    }
  } catch (e) {
    outputStream?.stopSpinner();
    throw e;
  }

  if (options.stream) {
    await traceProcessor!.finish();
    outputStream!.stopSpinner();
  }

  const testReport = await renderTestReport(synthDir, results, !options.stream);
  if (testReport.length > 0) {
    console.log(testReport);
  }

  let args: { methods: Record<string, Record<string, string>> };
  if (existsSync(join(synthDir, "usage_context.json"))) {
    args = { methods: JSON.parse(readFileSync(join(synthDir, "usage_context.json")).toString()) };
  }

  if (clean) {
    try {
      rmSync(synthDir, { recursive: true, force: true });
    } catch (err) {
      console.warn(`Warning: unable to clean up test directory: ${err}`);
    }
  } else {
    noCleanUp(synthDir);
  }

  return results.map((r) => ({ ...r, args }));
}

async function executeTestInHarness(harness: ITestHarness, synthDir: string, options: TestOptions) {
  try {
    const runner = await harness.deploy(synthDir);

    const [testRunner, tests] = await withSpinner("Setting up test runner...", async () => {
      const allTests = await runner.listTests();
      const filteredTests = filterTests(allTests, options.testFilter);
      return [runner, filteredTests];
    });

    const results = await withSpinner("Running tests...", async () => {
      return runTests(testRunner, tests);
    });

    const testReport = await renderTestReport(synthDir, results);
    if (testReport.length > 0) {
      console.log(testReport);
    }

    if (testResultsContainsFailure(results)) {
      console.log("One or more tests failed. Cleaning up resources...");
    }

    let args: { methods: Record<string, Record<string, string>> };
    if (existsSync(join(synthDir, "usage_context.json"))) {
      args = { methods: JSON.parse(readFileSync(join(synthDir, "usage_context.json")).toString()) };
    }

    return results.map((r) => ({ ...r, args }));
  } catch (err) {
    console.warn((err as Error).message);
    return [{ pass: false, path: "", error: (err as Error).message, traces: [] }];
  } finally {
    if (options.clean) {
      await harness.cleanup(synthDir);
    } else {
      noCleanUp(synthDir);
    }
  }
}

function sortTests(a: std.TestResult, b: std.TestResult) {
  if (a.pass && !b.pass) {
    return -1;
  }
  if (!a.pass && b.pass) {
    return 1;
  }
  return a.path.localeCompare(b.path);
}

/*
 * Take a path like "root/foo/bar/test:first test/baz" and return "first test".
 */
function extractTestNameFromPath(path: string): string | undefined {
  const parts = path.split("/");
  for (const part of parts) {
    if (part.startsWith("test:")) {
      return part.substring(5);
    }
  }
  return undefined;
}
