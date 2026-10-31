// Types for validate.mjs (plain JS so the shim and daemon run without type stripping).
export declare const brokerDir: (env?: NodeJS.ProcessEnv) => string;
export declare const NAME: RegExp;
export declare const ACCOUNT: RegExp;
export declare const SEG: string;
export declare const REF: RegExp;
export declare const REF_PARTS: RegExp;
export declare const validFields: (fields: unknown) => fields is string[];
export declare function validRequest(req: unknown): boolean;
