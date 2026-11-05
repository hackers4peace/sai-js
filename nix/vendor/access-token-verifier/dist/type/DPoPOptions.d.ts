import type { JTICheckFunction } from "./JTICheckFunction";
import type { RequestMethod } from "./RequestMethod";
export interface DPoPOptions {
    header: string;
    method: RequestMethod;
    url: string;
    isDuplicateJTI?: JTICheckFunction;
}
