import { Construct } from "constructs";
import { AwsInflightHost } from "./inflight-host";
import { calculateSecretPermissions } from "./permissions";
import { isValidArn } from "./util";
import { cloud } from "..";
import { ISecretClient } from "../cloud";
import { InflightClient, LiftMap } from "../core";
import { INFLIGHT_SYMBOL } from "../core/types";
import { IInflightHost, Resource } from "../std";

/**
 * A reference to an existing secret.
 *
 * @inflight `@winglang/sdk.cloud.ISecretClient`
 */
export class SecretRef extends Resource {
  /** @internal */
  public static _toInflightType(): string {
    return InflightClient.forType(
      __filename.replace("secret", "secret.inflight"),
      "SecretClient",
    );
  }

  /** @internal */
  public [INFLIGHT_SYMBOL]?: ISecretClient;
  /** The ARN of the secret */
  public readonly secretArn: string;

  constructor(scope: Construct, id: string, secretArn: string) {
    super(scope, id);

    if (!isValidArn(secretArn, "secretsmanager")) {
      throw new Error(`"${secretArn}" is not a valid secretsmanager arn`);
    }

    this.secretArn = secretArn;
  }

  public onLift(host: IInflightHost, ops: string[]): void {
    if (AwsInflightHost.isAwsInflightHost(host)) {
      host.addPolicyStatements(
        ...calculateSecretPermissions(this.secretArn, ops),
      );
    }

    host.addEnvironment(this.envName(), this.secretArn);
    super.onLift(host, ops);
  }

  /** @internal */
  public _liftedState(): Record<string, string> {
    return {
      $secretArn: `process.env["${this.envName()}"]`,
    };
  }

  private envName(): string {
    return `SECRET_ARN_${this.node.addr.slice(-8)}`;
  }

  /** @internal */
  public get _liftMap(): LiftMap {
    return {
      [cloud.SecretInflightMethods.VALUE]: [],
      [cloud.SecretInflightMethods.VALUE_JSON]: [],
    };
  }
}

/**
 * Shared interface for AWS Secrets
 */
export interface IAwsSecret {
  /**
   * AWS Secret ARN
   */
  readonly secretArn: string;
}

/**
 * Base class for AWS Secrets
 */
export abstract class Secret extends cloud.Secret implements IAwsSecret {
  /** @internal */
  public static _toInflightType(): string {
    return InflightClient.forType(
      __filename.replace("secret", "secret.inflight"),
      "SecretClient",
    );
  }

  private readonly isImportedSecret: boolean;

  constructor(scope: Construct, id: string, props: cloud.SecretProps = {}) {
    super(scope, id, props);

    this.isImportedSecret = !!props.name;
  }

  /**
   * AWS Secret ARN
   */
  public abstract get secretArn(): string;

  /** @internal */
  public get _liftMap(): LiftMap {
    return {
      [cloud.SecretInflightMethods.VALUE]: [],
      [cloud.SecretInflightMethods.VALUE_JSON]: [],
    };
  }

  public onLift(host: IInflightHost, ops: string[]): void {
    if (!AwsInflightHost.isAwsInflightHost(host)) {
      throw new Error("Host is expected to implement `IAwsInfightHost`");
    }

    const arnForPolicy = this.isImportedSecret
      ? this.secretArn
      : `${this.secretArn}-??????`;

    host.addPolicyStatements(...calculateSecretPermissions(arnForPolicy, ops));

    host.addEnvironment(this.envName(), this.secretArn);

    super.onLift(host, ops);
  }

  /** @internal */
  public _liftedState(): Record<string, string> {
    return {
      $secretArn: `process.env["${this.envName()}"]`,
    };
  }

  private envName(): string {
    return `SECRET_ARN_${this.node.addr.slice(-8)}`;
  }
}
