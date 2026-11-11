import { File, FileImage } from 'lucide-react';

/** Maps a file extension (or full filename for extensionless files) to a devicon class name. */
const EXTENSION_MAP: Record<string, string> = {
  // TypeScript / JavaScript
  ts: 'devicon-typescript-plain',
  tsx: 'devicon-react-original',
  js: 'devicon-javascript-plain',
  jsx: 'devicon-react-original',
  mjs: 'devicon-javascript-plain',
  cjs: 'devicon-javascript-plain',
  coffee: 'devicon-coffeescript-original',

  // Web
  html: 'devicon-html5-plain',
  htm: 'devicon-html5-plain',
  css: 'devicon-css3-plain',
  scss: 'devicon-sass-original',
  sass: 'devicon-sass-original',
  less: 'devicon-less-plain-wordmark',
  styl: 'devicon-stylus-original',
  pug: 'devicon-pug-plain',
  jade: 'devicon-pug-plain',

  // Data / config
  json: 'devicon-json-plain',
  yaml: 'devicon-yaml-plain',
  yml: 'devicon-yaml-plain',
  xml: 'devicon-xml-plain',
  graphql: 'devicon-graphql-plain',
  gql: 'devicon-graphql-plain',
  tf: 'devicon-terraform-plain',
  tfvars: 'devicon-terraform-plain',
  prisma: 'devicon-prisma-original',

  // Markup
  md: 'devicon-markdown-original',
  mdx: 'devicon-markdown-original',
  tex: 'devicon-latex-original',

  // Python
  py: 'devicon-python-plain',
  ipynb: 'devicon-jupyter-plain',

  // Go
  go: 'devicon-go-original',

  // Rust
  rs: 'devicon-rust-original',

  // PHP
  php: 'devicon-php-plain',

  // Ruby
  rb: 'devicon-ruby-plain',

  // Java / JVM
  java: 'devicon-java-plain',
  kt: 'devicon-kotlin-plain',
  kts: 'devicon-kotlin-plain',
  scala: 'devicon-scala-plain',
  sc: 'devicon-scala-plain',
  groovy: 'devicon-groovy-plain',
  clj: 'devicon-clojure-line',
  cljs: 'devicon-clojure-line',
  cljc: 'devicon-clojure-line',

  // C family
  c: 'devicon-c-plain',
  h: 'devicon-cplusplus-plain',
  cpp: 'devicon-cplusplus-plain',
  cc: 'devicon-cplusplus-plain',
  cxx: 'devicon-cplusplus-plain',
  hpp: 'devicon-cplusplus-plain',
  hh: 'devicon-cplusplus-plain',
  hxx: 'devicon-cplusplus-plain',
  cs: 'devicon-csharp-plain',

  // Apple ecosystem
  swift: 'devicon-swift-plain',
  mm: 'devicon-objectivec-plain',

  // Other languages
  dart: 'devicon-dart-plain',
  lua: 'devicon-lua-plain',
  r: 'devicon-r-plain',
  pl: 'devicon-perl-plain',
  pm: 'devicon-perl-plain',
  ex: 'devicon-elixir-plain',
  exs: 'devicon-elixir-plain',
  erl: 'devicon-erlang-plain',
  hrl: 'devicon-erlang-plain',
  hs: 'devicon-haskell-plain',
  lhs: 'devicon-haskell-plain',
  ml: 'devicon-ocaml-plain',
  mli: 'devicon-ocaml-plain',
  fs: 'devicon-fsharp-plain',
  fsx: 'devicon-fsharp-plain',
  fsi: 'devicon-fsharp-plain',
  elm: 'devicon-elm-plain',
  jl: 'devicon-julia-plain',
  nim: 'devicon-nim-plain',
  nims: 'devicon-nim-plain',
  zig: 'devicon-zig-original',
  cr: 'devicon-crystal-original',
  vala: 'devicon-vala-plain',
  sol: 'devicon-solidity-plain',
  wasm: 'devicon-wasm-original',
  wat: 'devicon-wasm-original',
  vim: 'devicon-vim-plain',

  // Database
  sqlite: 'devicon-sqlite-plain',
  db: 'devicon-sqlite-plain',

  // Shell
  sh: 'devicon-bash-plain',
  bash: 'devicon-bash-plain',
  zsh: 'devicon-bash-plain',
  fish: 'devicon-bash-plain',
  ps1: 'devicon-powershell-plain',

  // Frontend frameworks
  vue: 'devicon-vuejs-plain',
  svelte: 'devicon-svelte-plain',
  astro: 'devicon-astro-plain',
};

/** Full-filename overrides for extensionless files. */
const FILENAME_MAP: Record<string, string> = {
  Dockerfile: 'devicon-docker-plain',
  dockerfile: 'devicon-docker-plain',
  '.dockerignore': 'devicon-docker-plain',
  'docker-compose.yml': 'devicon-docker-plain',
  'docker-compose.yaml': 'devicon-docker-plain',
  '.gitignore': 'devicon-git-plain',
  '.gitattributes': 'devicon-git-plain',
  '.gitmodules': 'devicon-git-plain',
  '.eslintrc': 'devicon-eslint-plain',
  '.eslintrc.js': 'devicon-eslint-plain',
  '.eslintrc.cjs': 'devicon-eslint-plain',
  '.eslintrc.json': 'devicon-eslint-plain',
  '.eslintignore': 'devicon-eslint-plain',
  'eslint.config.js': 'devicon-eslint-plain',
  'eslint.config.mjs': 'devicon-eslint-plain',
  'eslint.config.ts': 'devicon-eslint-plain',
  '.babelrc': 'devicon-babel-plain',
  'babel.config.js': 'devicon-babel-plain',
  'babel.config.json': 'devicon-babel-plain',
  'vite.config.ts': 'devicon-vitejs-plain',
  'vite.config.js': 'devicon-vitejs-plain',
  'vitest.config.ts': 'devicon-vitest-plain',
  'vitest.config.js': 'devicon-vitest-plain',
  'webpack.config.js': 'devicon-webpack-plain',
  'webpack.config.ts': 'devicon-webpack-plain',
  'rollup.config.js': 'devicon-rollup-plain',
  'rollup.config.ts': 'devicon-rollup-plain',
  'jest.config.js': 'devicon-jest-plain',
  'jest.config.ts': 'devicon-jest-plain',
  'tailwind.config.js': 'devicon-tailwindcss-original',
  'tailwind.config.ts': 'devicon-tailwindcss-original',
  'postcss.config.js': 'devicon-postcss-original',
  'postcss.config.cjs': 'devicon-postcss-original',
  'CMakeLists.txt': 'devicon-cmake-plain',
  Gemfile: 'devicon-ruby-plain',
  'Gemfile.lock': 'devicon-ruby-plain',
  'package.json': 'devicon-npm-original-wordmark',
  'package-lock.json': 'devicon-npm-original-wordmark',
  'pnpm-lock.yaml': 'devicon-pnpm-plain',
  'pnpm-workspace.yaml': 'devicon-pnpm-plain',
  'yarn.lock': 'devicon-yarn-original',
  '.nvmrc': 'devicon-nodejs-plain',
  '.node-version': 'devicon-nodejs-plain',
  'go.mod': 'devicon-go-original',
  'go.sum': 'devicon-go-original',
  'Cargo.toml': 'devicon-rust-original',
  'Cargo.lock': 'devicon-rust-original',
};

/** Raster and vector image extensions, drawn with the generic image glyph. */
const IMAGE_LABELS: Record<string, string> = {
  png: 'PNG',
  jpg: 'JPG',
  jpeg: 'JPG',
  gif: 'GIF',
  webp: 'WEBP',
  svg: 'SVG',
  bmp: 'BMP',
  ico: 'ICO',
};

function getExtension(filename: string): string {
  const dot = filename.lastIndexOf('.');
  return dot >= 0 ? filename.slice(dot + 1).toLowerCase() : '';
}

interface FileIconProps {
  filename: string;
  className?: string;
  size?: number;
}

/**
 * File-type glyph. Language marks render in one passive tone (devicon without `colored`), like
 * every other icon in the app; the file name carries the identity, the glyph only hints at it.
 * Pass `className` to change the tone (for example on a selected row).
 */
export function FileIcon({ filename, className, size = 12 }: FileIconProps) {
  const extension = getExtension(filename);
  const deviconClass = FILENAME_MAP[filename] ?? EXTENSION_MAP[extension];
  const tone = className ?? 'shrink-0 text-foreground-passive';

  if (deviconClass) {
    return (
      <i
        className={`${deviconClass} ${tone}`}
        style={{ fontSize: size, lineHeight: 1 }}
        aria-hidden="true"
      />
    );
  }

  const imageLabel = IMAGE_LABELS[extension];
  if (imageLabel) {
    return (
      <span className="inline-flex shrink-0" title={`${imageLabel} image`}>
        <FileImage className={tone} style={{ width: size, height: size }} aria-hidden="true" />
      </span>
    );
  }

  return <File className={tone} style={{ width: size, height: size }} aria-hidden="true" />;
}
