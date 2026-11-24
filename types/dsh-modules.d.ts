/**
 * Ambient declarations for the two DSH packages the Host half imports.
 *
 * They only exist inside the application, so a standalone `tsc` run needs a shape
 * to check against. Keep these minimal: they describe what this plugin uses, not
 * the whole packages.
 */
declare module '@deepseek-ai/schemastery' {
  const z: {
    object(schema: Record<string, unknown>): any
    number(): any
    string(): any
    boolean(): any
  }
  export default z
}

declare module '@deepseek-ai/dsh-llm' {
  export function createUserMessage(input: {
    content: unknown
    source?: unknown
  }): { readonly id: string; readonly role: 'user'; readonly content: unknown }
}
