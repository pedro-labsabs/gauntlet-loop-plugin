/**
 * Type shim for CSS Modules used by the client toolview.
 */
declare module '*.module.css' {
  const classes: Record<string, string>
  export default classes
}
