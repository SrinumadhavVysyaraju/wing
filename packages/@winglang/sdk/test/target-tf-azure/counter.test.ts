import * as cdktf from "cdktf";
import { test, expect } from "vitest";
import { AzureApp } from "./azure-util";
import * as cloud from "../../src/cloud";
import { lift } from "../../src/core";
import * as tfAzure from "../../src/target-tf-azure";
import { StorageAccountPermissions } from "../../src/target-tf-azure/counter";
import { mkdtemp, tfResourcesOf, tfSanitize, treeJsonOf } from "../util";

test("default counter behavior", () => {
  const app = new AzureApp();
  new cloud.Counter(app, "Counter");
  const output = app.synth();

  expect(tfResourcesOf(output)).toEqual([
    "azurerm_resource_group",
    "azurerm_storage_account",
    "azurerm_storage_table",
  ]);
  expect(tfSanitize(output)).toMatchSnapshot();
});

test("counter with initial value", () => {
  const app = new AzureApp();
  new cloud.Counter(app, "Counter", {
    initial: 9991,
  });
  const output = app.synth();

  expect(tfResourcesOf(output)).toEqual([
    "azurerm_resource_group",
    "azurerm_storage_account",
    "azurerm_storage_table",
  ]);
  expect(tfSanitize(output)).toMatchSnapshot();
  expect(treeJsonOf(app.outdir)).toMatchSnapshot();
});

test("function with a counter binding", () => {
  const app = new AzureApp();
  const counter = new cloud.Counter(app, "Counter");
  new cloud.Function(
    app,
    "Function",
    lift({ my_counter: counter })
      .grant({ my_counter: ["inc"] })
      .inflight(async (ctx) => {
        const val = await ctx.my_counter.inc(2);
        console.log(val);
      }),
  );
  const output = app.synth();

  expect(tfResourcesOf(output)).toEqual([
    "azurerm_application_insights",
    "azurerm_linux_function_app",
    "azurerm_log_analytics_workspace",
    "azurerm_resource_group",
    "azurerm_role_assignment",
    "azurerm_service_plan",
    "azurerm_storage_account",
    "azurerm_storage_blob",
    "azurerm_storage_container",
    "azurerm_storage_table",
  ]);
  expect(tfSanitize(output)).toMatchSnapshot();
  expect(treeJsonOf(app.outdir)).toMatchSnapshot();
});

test("inc() policy statement", () => {
  const app = new AzureApp();
  const counter = new cloud.Counter(app, "Counter");
  new cloud.Function(
    app,
    "Function",
    lift({ my_counter: counter })
      .grant({ my_counter: ["inc"] })
      .inflight(async (ctx) => {
        const val = await ctx.my_counter.inc(2);
        console.log(val);
      }),
  );
  const output = app.synth();

  expect(output).toContain(StorageAccountPermissions.READ_WRITE);
  expect(tfSanitize(output)).toMatchSnapshot();
  expect(treeJsonOf(app.outdir)).toMatchSnapshot();
});

test("dec() policy statement", () => {
  const app = new AzureApp();
  const counter = new cloud.Counter(app, "Counter");
  new cloud.Function(
    app,
    "Function",
    lift({ my_counter: counter })
      .grant({ my_counter: ["dec"] })
      .inflight(async (ctx) => {
        const val = await ctx.my_counter.dec(2);
        console.log(val);
      }),
  );
  const output = app.synth();

  expect(output).toContain(StorageAccountPermissions.READ_WRITE);
  expect(tfSanitize(output)).toMatchSnapshot();
  expect(treeJsonOf(app.outdir)).toMatchSnapshot();
});

test("peek() policy statement", () => {
  const app = new AzureApp();
  const counter = new cloud.Counter(app, "Counter");
  new cloud.Function(
    app,
    "Function",
    lift({ my_counter: counter })
      .grant({ my_counter: ["peek"] })
      .inflight(async (ctx) => {
        const val = await ctx.my_counter.peek();
        console.log(val);
      }),
  );
  const output = app.synth();

  expect(output).toContain(StorageAccountPermissions.READ);
  expect(tfSanitize(output)).toMatchSnapshot();
  expect(treeJsonOf(app.outdir)).toMatchSnapshot();
});

test("set() policy statement", () => {
  const app = new AzureApp();
  const counter = new cloud.Counter(app, "Counter");
  new cloud.Function(
    app,
    "Function",
    lift({ my_counter: counter })
      .grant({ my_counter: ["set"] })
      .inflight(async (ctx) => {
        const val = await ctx.my_counter.set(12);
        console.log(val);
      }),
  );
  const output = app.synth();
  expect(output).toContain(StorageAccountPermissions.READ_WRITE);
  expect(tfSanitize(output)).toMatchSnapshot();
  expect(treeJsonOf(app.outdir)).toMatchSnapshot();
});

test("counter name valid", () => {
  // GIVEN
  const app = new AzureApp();
  const counter = new cloud.Counter(app, "wingcounter");
  const output = app.synth();
  // THEN
  expect(
    cdktf.Testing.toHaveResourceWithProperties(
      output,
      "azurerm_storage_table",
      {
        name: `wingcounterx${counter.node.addr.substring(0, 8)}`,
      },
    ),
  ).toEqual(true);
  expect(tfSanitize(output)).toMatchSnapshot();
  expect(treeJsonOf(app.outdir)).toMatchSnapshot();
});

test("replace invalid character from counter name", () => {
  // GIVEN
  const app = new AzureApp();
  const counter = new cloud.Counter(app, "The*Amazing%Counter@01");
  const output = app.synth();

  // THEN
  expect(
    cdktf.Testing.toHaveResourceWithProperties(
      output,
      "azurerm_storage_table",
      {
        name: `thexamazingxcounterx01x${counter.node.addr.substring(0, 8)}`,
      },
    ),
  ).toEqual(true);
  expect(tfSanitize(output)).toMatchSnapshot();
  expect(treeJsonOf(app.outdir)).toMatchSnapshot();
});
