import type { Assertion, AsymmetricMatchersContaining } from 'vitest';
import type * as RDF from '@rdfjs/types';

interface CustomMatchers<R = unknown> {
  toBeRdfDatasetContaining: <Q extends RDF.BaseQuad = RDF.Quad>(dataset: RDF.DatasetCore<Q>, ...quads) => Q[];
  toBeRdfIsomorphic: <Q extends RDF.BaseQuad = RDF.Quad>(graph: Iterable<Q>) => R;
  toEqualRdfTerm: (received: RDF.Term, actual: RDF.Term) => R;
}

declare module 'vitest' {
  interface Assertion<T = any> extends CustomMatchers<T> {}
}
