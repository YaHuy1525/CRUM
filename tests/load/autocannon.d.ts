// Minimal ambient types for autocannon, which ships no bundled or @types package.
// Only the fields the load tests read are declared, so the import resolves to a
// real type instead of an unresolvable `any`.
declare module 'autocannon' {
  interface AutocannonOptions {
    url: string
    method?: string
    connections?: number
    duration?: number
    headers?: Record<string, string>
    body?: string
  }

  interface AutocannonResult {
    p95: number
    non2xx: number
  }

  function autocannon(opts: AutocannonOptions): Promise<AutocannonResult>

  export default autocannon
}
