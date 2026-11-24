/**
 * Stand-in for @deepseek-ai/dsh-llm used only by the end-to-end test.
 *
 * The real `createUserMessage` deep-freezes the message and gives it a branded id.
 * The plugin relies on exactly two things: a frozen `{ role: 'user', content }`
 * with a stable `id` (the anti-self-loop guard keys on it) and nothing else.
 */
let counter = 0

export function createUserMessage({ content, source } = {}) {
  counter += 1
  return Object.freeze({
    id: `msg-e2e-${counter}`,
    role: 'user',
    content: Object.freeze(content ?? []),
    source,
  })
}
