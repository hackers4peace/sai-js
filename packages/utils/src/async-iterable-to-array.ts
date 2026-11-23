export async function asyncIterableToArray<T>(asyncIterable: AsyncIterable<T>): Promise<Array<T>> {
  const arr: Array<T> = []
  for await (const item of asyncIterable) {
    arr.push(item)
  }
  return arr
}
