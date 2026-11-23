import type { GrantData } from './index.ts'

export type DataOwnerData = {
  id: string
  issuedGrants: Array<GrantData>
}
