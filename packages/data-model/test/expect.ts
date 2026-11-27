import toBeRdfDatasetContaining from 'jest-rdf/lib/matchers/toBeRdfDatasetContaining'
import toBeRdfIsomorphic from 'jest-rdf/lib/matchers/toBeRdfIsomorphic'
import toEqualRdfTerm from 'jest-rdf/lib/matchers/toEqualRdfTerm'
import { expect as viexpect } from 'vitest'
viexpect.extend(toBeRdfDatasetContaining)
viexpect.extend(toBeRdfIsomorphic)
viexpect.extend(toEqualRdfTerm)

export const expect = viexpect
