export async function seedQuadstore(sparqlEndpoint: string, data: string): Promise<void> {
  await dropQuadstore(sparqlEndpoint)
  const response = await fetch(sparqlEndpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/trig',
    },
    body: data,
  })
  if (!response.ok) throw new Error('seeding quadstore failed')
}

export async function fetchQuadstore(sparqlEndpoint: string): Promise<string> {
  const response = await fetch(sparqlEndpoint, {
    headers: {
      Accept: 'application/trig',
    },
  })
  return response.text()
}

export async function dropQuadstore(sparqlEndpoint: string): Promise<void> {
  const response = await fetch(sparqlEndpoint, {
    method: 'DELETE',
  })
  if (!response.ok) throw new Error('dropping quadstore failed')
}
