/**
 * Minimal stand-in for @deepseek-ai/schemastery used only by the end-to-end test.
 * The real package validates the loader entry; the test only needs the Config
 * export to exist and be chainable.
 */
function chain() {
  const node = {
    default: () => node,
    description: () => node,
    optional: () => node,
    step: () => node,
    min: () => node,
    max: () => node,
    required: () => node,
    hidden: () => node,
    toString: () => 'schema',
  }
  return node
}

const z = {
  object: () => chain(),
  number: () => chain(),
  string: () => chain(),
  boolean: () => chain(),
  array: () => chain(),
  dict: () => chain(),
  union: () => chain(),
  any: () => chain(),
}

export default z
export { z }
