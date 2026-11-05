export declare function isObjectPropertyOf<P extends PropertyKey>(x: object, property: P): x is {
    [K in P]: unknown;
};
