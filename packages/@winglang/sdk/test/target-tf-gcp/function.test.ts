import { readdirSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import * as cdktf from "cdktf";
import { test, expect } from "vitest";
import { GcpApp } from "./gcp-util";
import { Function } from "../../src/cloud";
import { inflight } from "../../src/core";
import { Duration } from "../../src/std";
import { tfResourcesOf, tfSanitize, treeJsonOf } from "../util";

const INFLIGHT_CODE = inflight(async (_, name) => {
  console.log("Hello, " + name);
});

test("basic function", () => {
  // GIVEN
  const app = new GcpApp();

  // WHEN
  new Function(app, "Function", INFLIGHT_CODE);
  const output = app.synth();

  const functionOutDir = readdirSync(app.workdir, {
    recursive: true,
    withFileTypes: true,
  }).find((d) => d.isDirectory())!;
  const packageJson = JSON.parse(
    readFileSync(
      join(app.workdir, functionOutDir.name, "package.json"),
      "utf-8",
    ),
  );
  const indexFilename = "index.cjs";
  expect(packageJson.main).toBe(indexFilename);
  expect(
    existsSync(join(app.workdir, functionOutDir.name, indexFilename)),
  ).toBeTruthy();

  // THEN
  expect(tfResourcesOf(output)).toEqual([
    "google_cloudfunctions_function",
    "google_project_service",
    "google_service_account",
    "google_storage_bucket",
    "google_storage_bucket_object",
    "random_id",
  ]);
  expect(tfSanitize(output)).toMatchSnapshot();
  expect(treeJsonOf(app.outdir)).toMatchSnapshot();
});

test("basic function with environment variables", () => {
  // GIVEN
  const app = new GcpApp();

  // WHEN
  new Function(app, "Function", INFLIGHT_CODE, {
    env: {
      FOO: "BAR",
      BOOM: "BAM",
    },
  });
  const output = app.synth();

  // THEN
  expect(
    cdktf.Testing.toHaveResourceWithProperties(
      output,
      "google_cloudfunctions_function",
      {
        environment_variables: {
          BOOM: "BAM",
          FOO: "BAR",
        },
      },
    ),
  ).toEqual(true);
  expect(tfSanitize(output)).toMatchSnapshot();
  expect(treeJsonOf(app.outdir)).toMatchSnapshot();
});

test("basic function with timeout explicitly set", () => {
  // GIVEN
  const app = new GcpApp();

  // WHEN
  new Function(app, "Function", INFLIGHT_CODE, {
    timeout: Duration.fromSeconds(30),
  });
  const output = app.synth();

  // THEN
  expect(
    cdktf.Testing.toHaveResourceWithProperties(
      output,
      "google_cloudfunctions_function",
      {
        timeout: 30,
      },
    ),
  ).toEqual(true);
  expect(tfSanitize(output)).toMatchSnapshot();
  expect(treeJsonOf(app.outdir)).toMatchSnapshot();
});

test("basic function with timeout beyond the allowed range", () => {
  // GIVEN
  const app = new GcpApp();

  // WHEN
  expect(() => {
    new Function(app, "Function", INFLIGHT_CODE, {
      timeout: Duration.fromSeconds(0),
    });
  }).toThrowErrorMatchingSnapshot();
});

test("basic function with memory size specified", () => {
  // GIVEN
  const app = new GcpApp();

  // WHEN
  new Function(app, "Function", INFLIGHT_CODE, {
    memory: 256,
  });
  const output = app.synth();

  // THEN
  expect(
    cdktf.Testing.toHaveResourceWithProperties(
      output,
      "google_cloudfunctions_function",
      {
        available_memory_mb: 256,
      },
    ),
  ).toEqual(true);
  expect(tfSanitize(output)).toMatchSnapshot();
  expect(treeJsonOf(app.outdir)).toMatchSnapshot();
});

test("basic function with memory beyond the allowed range", () => {
  // GIVEN
  const app = new GcpApp();

  // WHEN
  expect(() => {
    new Function(app, "Function", INFLIGHT_CODE, {
      memory: 64,
    });
  }).toThrowErrorMatchingSnapshot();
});
