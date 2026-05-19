declare module '*.css';
declare module '*?url' {
  const url: string;
  export default url;
}

interface ImportMetaEnv {
  readonly MODE: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
