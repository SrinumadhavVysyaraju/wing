import { CfnOutput, Lazy } from "aws-cdk-lib";
import { Construct } from "constructs";
import { core, std } from "@winglang/sdk";
import { isAwsCdkFunction } from "./function";
import { WING_TEST_RUNNER_FUNCTION_IDENTIFIERS_AWSCDK } from "./harness";

/**
 * AWS implementation of `cloud.TestRunner`.
 *
 * @inflight `@winglang/sdk.cloud.ITestRunnerClient`
 */
export class TestRunner extends std.TestRunner {
  /** @internal */
  public static _toInflightType(): string {
    return core.InflightClient.forType(
      __filename.replace("test-runner", "test-runner.inflight"),
      "TestRunnerClient"
    );
  }

  constructor(scope: Construct, id: string, props: std.TestRunnerProps) {
    super(scope, id, props);

    // This output is created so the CLI's `wing test` command can obtain a list
    // of all ARNs of test functions
    const output = new CfnOutput(this, "TestFunctionArns", {
      value: Lazy.string({
        produce: () => {
          return JSON.stringify([...this.getTestFunctionArns().entries()]);
        },
      }),
    });

    output.overrideLogicalId(WING_TEST_RUNNER_FUNCTION_IDENTIFIERS_AWSCDK);
  }

  public onLift(host: std.IInflightHost, ops: string[]): void {
    // Collect all of the test functions and their ARNs, and pass them to the
    // test engine so they can be invoked inflight.
    // TODO: are we going to run into AWS's 4KB environment variable limit here?
    // some solutions:
    // - base64 encode the string value
    // - move the logic for picking one test from each isolated environment to
    //   here so that if there are N tests in the original app and N
    //   environments, we only need to output N test function ARNs instead of
    //   N * N
    const testFunctions = this.getTestFunctionArns();
    host.addEnvironment(
      this.envTestFunctionArns(),
      JSON.stringify([...testFunctions.entries()])
    );

    super.onLift(host, ops);
  }

  /** @internal */
  public _preSynthesize(): void {
    // add a dependency on each test function
    for (const test of this.findTests()) {
      if (test._fn) {
        this.node.addDependency(test._fn);
      }
    }

    super._preSynthesize();
  }

  private getTestFunctionArns(): Map<string, string> {
    const arns = new Map<string, string>();
    for (const test of this.findTests()) {
      if (test._fn) {
        if (!isAwsCdkFunction(test._fn)) {
          throw new Error(
            `Unsupported test function type, ${test._fn.node.path} was not a tfaws.Function`
          );
        }
        arns.set(test.node.path, test._fn.awscdkFunction.functionArn);
      }
    }
    return arns;
  }

  /** @internal */
  public _liftedState(): Record<string, string> {
    return {
      $tests: `process.env["${this.envTestFunctionArns()}"]`,
    };
  }

  private envTestFunctionArns(): string {
    return `TEST_RUNNER_FUNCTIONS_${this.node.addr.slice(-8)}`;
  }
}
