/** CSS Modules typing for the UI (Vite and esbuild both emit a default class map). */
declare module '*.module.css' {
  const classes: Readonly<Record<string, string>>;
  export default classes;
}
