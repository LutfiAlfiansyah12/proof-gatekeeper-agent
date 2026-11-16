// snarkjs ships without type declarations; its API surface used here:
declare module 'snarkjs' {
  export interface Groth16Proof {
    pi_a: string[];
    pi_b: string[][];
    pi_c: string[];
    protocol: string;
    curve: string;
  }
  export interface ProveResult {
    proof: Groth16Proof;
    publicSignals: string[];
  }
  export const groth16: {
    fullProve(
      input: Record<string, unknown>,
      wasmPath: string,
      zkeyPath: string,
      logger?: unknown,
    ): Promise<ProveResult>;
    verify(
      vk: object,
      publicSignals: string[],
      proof: Groth16Proof,
      logger?: unknown,
    ): Promise<boolean>;
  };
  export const zKey: {
    exportVerificationKey(zkeyPath: string): Promise<object>;
  };
}
