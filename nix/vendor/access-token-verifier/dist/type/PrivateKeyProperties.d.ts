declare const PRIVATE_KEY_PROPERTIES: Set<"d" | "p" | "q" | "dp" | "dq" | "qi">;
export type PrivateKeyProperties = typeof PRIVATE_KEY_PROPERTIES extends Set<infer T> ? T : never;
export {};
