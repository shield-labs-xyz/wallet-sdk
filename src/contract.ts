import {
  PublicKeys,
  type AztecAddress,
  type Contract as AztecContract,
  type DeployMethod as AztecDeployMethod,
  type ContractArtifact,
  type ContractInstanceWithAddress,
  type Fr,
  type FunctionCall,
  type Wallet,
} from "@aztec/aztec.js";
import {
  decodeFromAbi,
  encodeArguments,
  FunctionSelector,
  type FunctionAbi,
} from "@aztec/foundation/abi";
import { DeployMethod, type DeployOptions } from "./contract-deploy.js";
import type { TransactionRequest } from "./exports/eip1193.js";
import type { Account } from "./types.js";
import { lazyValue, type ParametersExceptFirst } from "./utils.js";

// TODO: consider changing the API to be more viem-like. I.e., use `contract.write.methodName` and `contract.read.methodName`
export class ContractBase<T extends AztecContract> {
  readonly methods: {
    [K in keyof T["methods"]]: ContractMethod<T, K>;
  };

  protected constructor(
    /** Deployed contract instance. */
    readonly instance: ContractInstanceWithAddress,
    /** The Application Binary Interface for the contract. */
    readonly artifact: ContractArtifact,
    /** The account used for interacting with this contract. */
    readonly account: Account,
  ) {
    this.methods = artifact.functions.reduce(
      (acc, f) => {
        acc[f.name as keyof T["methods"]] = Object.assign(
          (...argsAndOptions: any[]) => {
            const [args, options = {}] =
              argsAndOptions.length === f.parameters.length
                ? [argsAndOptions, {}]
                : [
                    argsAndOptions.slice(0, -1),
                    argsAndOptions[argsAndOptions.length - 1],
                  ];
            return new ContractFunctionInteraction(
              this, // TODO: is this memory leak?
              this.account,
              f,
              args,
              options,
            );
          },
          {
            async selector() {
              return await FunctionSelector.fromNameAndParameters(
                f.name,
                f.parameters,
              );
            },
          },
        );
        return acc;
      },
      {} as typeof this.methods,
    );
  }

  get address() {
    return this.instance.address;
  }

  /** @deprecated use `withAccount` */
  withWallet = this.withAccount.bind(this);
  withAccount(account: Account): Contract<T> {
    return new Contract<T>(this.instance, this.artifact, account);
  }
}

export class Contract<T extends AztecContract> extends ContractBase<T> {
  static async at<T extends AztecContract = AztecContract>(
    address: AztecAddress,
    artifact: ContractArtifact,
    account: Account,
  ) {
    const contractInstance = await account.aztecNode.getContract(address);
    if (contractInstance == null) {
      throw new Error(`Contract at ${address.toString()} not found`);
    }
    return new Contract<T>(contractInstance, artifact, account);
  }

  static fromAztec<
    TClass extends AztecContractClass<any>,
    T extends AztecContractInstance<TClass>,
  >(original: TClass) {
    const ContractClass = class extends ContractBase<T> {
      static async at(address: AztecAddress, account: Account) {
        return await Contract.at<T>(address, original.artifact, account);
      }

      static deploy(
        account: Account,
        ...args: ParametersExceptFirst<TClass["deploy"]>
      ) {
        return this.deployWithOpts({ account }, ...args);
      }

      static deployWithOpts(
        options: DeployOptions & {
          account: Account;
          publicKeys?: PublicKeys;
          method?: keyof T["methods"] & string;
        },
        ...args: ParametersExceptFirst<TClass["deploy"]>
      ) {
        return new DeployMethod(
          options.publicKeys ?? PublicKeys.default(),
          options.account,
          this.artifact,
          this.at,
          args,
          options,
          options.method,
        );
      }

      static artifact: TClass["artifact"] = original.artifact;
      static events: TClass["events"] = original.events ?? {};
      static notes: TClass["notes"] = original.notes ?? {};
      static storage: TClass["storage"] = original.storage ?? {};
    };
    return ContractClass;
  }
}

export class UnsafeContract<T extends AztecContract> extends Contract<T> {
  constructor(
    instance: ContractInstanceWithAddress,
    artifact: ContractArtifact,
    account: Account,
  ) {
    super(instance, artifact, account);
  }
}

export type ContractInfo = Pick<
  Contract<AztecContract>,
  "address" | "instance" | "artifact"
>;

export class ContractFunctionInteraction {
  readonly #account: Account;
  readonly #functionAbi: FunctionAbi;
  readonly #call: () => Promise<FunctionCall>;
  readonly #txRequest: () => Promise<Required<TransactionRequest>>;

  constructor(
    contract: ContractInfo,
    account: Account,
    functionAbi: FunctionAbi,
    args: unknown[],
    options: SendOptions | undefined,
  ) {
    this.#account = account;
    this.#functionAbi = functionAbi;

    this.#call = lazyValue(async () => {
      return {
        name: this.#functionAbi.name,
        args: encodeArguments(this.#functionAbi, args),
        selector: await FunctionSelector.fromNameAndParameters(
          this.#functionAbi.name,
          this.#functionAbi.parameters,
        ),
        type: this.#functionAbi.functionType,
        to: contract.address,
        isStatic: this.#functionAbi.isStatic,
        returnTypes: this.#functionAbi.returnTypes,
      };
    });
    this.#txRequest = lazyValue(async () => {
      return {
        calls: [await this.#call()],
        authWitnesses: options?.authWitnesses ?? [],
        capsules: options?.capsules ?? [],
        registerContracts: [contract, ...(options?.registerContracts ?? [])],
      };
    });
  }

  send() {
    return this.#account.sendTransaction(this.#txRequest());
  }

  async simulate() {
    const results = await this.#account.simulateTransaction(
      await this.#txRequest(),
    );
    if (results.length !== 1) {
      throw new Error(`invalid results length: ${results.length}`);
    }
    const result = results[0]!;
    return decodeFromAbi(this.#functionAbi.returnTypes, result);
  }

  async request(): Promise<FunctionCall> {
    return await this.#call();
  }
}

export class BatchCall
  implements Pick<ReturnType<ContractMethod<any, any>>, "send">
{
  constructor(
    readonly account: Account,
    readonly calls: FunctionCall[],
    readonly options?: SendOptions,
  ) {}

  send() {
    return this.account.sendTransaction({
      ...this.options,
      calls: this.calls,
    });
  }
}

export type IntentAction = {
  caller: AztecAddress;
  action: FunctionCall;
};

export type Capsule = Fr[];

export type SendOptions = Pick<
  TransactionRequest,
  "authWitnesses" | "capsules" | "registerContracts"
>;

type ContractMethod<T extends AztecContract, K extends keyof T["methods"]> = ((
  ...args: [...Parameters<T["methods"][K]>, options?: SendOptions]
) => ContractFunctionInteraction) & {
  selector(): Promise<FunctionSelector>;
};

type AztecContractClass<T extends AztecContract> = {
  deploy: (deployer: Wallet, ...args: any[]) => AztecDeployMethod<T>;
  artifact: ContractArtifact;
  events?: {};
  notes?: {};
  storage?: {};
};

type AztecContractInstance<C extends AztecContractClass<any>> =
  C extends AztecContractClass<infer T> ? T : never;
