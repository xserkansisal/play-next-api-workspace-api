export async function first<T>(query: PromiseLike<T[]>): Promise<T | undefined> {
  const rows = await query;
  return rows[0];
}
