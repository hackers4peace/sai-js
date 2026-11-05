export interface RetrieveOidcIssuersFunction {
    (identifier: string): Promise<Array<string>>;
}
