/**
 * Resolve the two DSH packages the Host plugin imports to their test stubs.
 *
 * Used by `test/e2e.mjs` through `--experimental-loader`. Product code stays
 * untouched: only the module resolution changes, and only for this process.
 */
const STUBS = new Map([
  ['@deepseek-ai/schemastery', new URL('./stubs/schemastery.mjs', import.meta.url).href],
  ['@deepseek-ai/dsh-llm', new URL('./stubs/dsh-llm.mjs', import.meta.url).href],
])

export async function resolve(specifier, context, next) {
  const stub = STUBS.get(specifier)
  if (stub !== undefined) return { url: stub, shortCircuit: true }
  return next(specifier, context)
}
