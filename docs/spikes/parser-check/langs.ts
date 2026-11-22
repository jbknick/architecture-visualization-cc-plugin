// Fixed inputs of the parser check: the five languages, the measured repos and the pinned packages.

export interface Repo {
  name: string;
  url: string;
  sha: string;
}

export interface Lang {
  id: "java" | "python" | "csharp" | "rust" | "ruby";
  label: string;
  /** File extension, with the dot. */
  ext: string;
  repo: Repo;
  /** npm package of the tree-sitter grammar, with its WASM build and `queries/tags.scm`. */
  grammarPkg: string;
  wasm: string;
  /** `@ast-grep/lang-*` package and the name it is registered under. */
  astPkg: string;
}

export const LANGS: Lang[] = [
  {
    id: "java",
    label: "Java",
    ext: ".java",
    repo: {
      name: "google/gson",
      url: "https://github.com/google/gson.git",
      sha: "d9b5079eaa4567219771bba6d04289cf45c7589b",
    },
    grammarPkg: "tree-sitter-java",
    wasm: "tree-sitter-java.wasm",
    astPkg: "@ast-grep/lang-java",
  },
  {
    id: "python",
    label: "Python",
    ext: ".py",
    repo: {
      name: "scrapy/scrapy",
      url: "https://github.com/scrapy/scrapy.git",
      sha: "00acf3f31a322871a47aead5fec610d900263103",
    },
    grammarPkg: "tree-sitter-python",
    wasm: "tree-sitter-python.wasm",
    astPkg: "@ast-grep/lang-python",
  },
  {
    id: "csharp",
    label: "C#",
    ext: ".cs",
    repo: {
      name: "AutoMapper/AutoMapper",
      url: "https://github.com/AutoMapper/AutoMapper.git",
      sha: "79d10deec5881a617c38e7373f354694044bf83d",
    },
    grammarPkg: "tree-sitter-c-sharp",
    wasm: "tree-sitter-c_sharp.wasm",
    astPkg: "@ast-grep/lang-csharp",
  },
  {
    id: "rust",
    label: "Rust",
    ext: ".rs",
    repo: {
      name: "clap-rs/clap",
      url: "https://github.com/clap-rs/clap.git",
      sha: "487474f013d3e0cbffc911934575f7ebcc72a6d4",
    },
    grammarPkg: "tree-sitter-rust",
    wasm: "tree-sitter-rust.wasm",
    astPkg: "@ast-grep/lang-rust",
  },
  {
    id: "ruby",
    label: "Ruby",
    ext: ".rb",
    repo: {
      name: "rspec/rspec-core",
      url: "https://github.com/rspec/rspec-core.git",
      sha: "aec5f49485d97908183dbe790a7fefb8baaa8091",
    },
    grammarPkg: "tree-sitter-ruby",
    wasm: "tree-sitter-ruby.wasm",
    astPkg: "@ast-grep/lang-ruby",
  },
];

/** Exact versions installed into the temp directory. Nothing here is added to a repository manifest. */
export const PACKAGES: Record<string, string> = {
  "web-tree-sitter": "0.27.2",
  "tree-sitter-java": "0.23.5",
  "tree-sitter-python": "0.25.0",
  "tree-sitter-c-sharp": "0.24.0",
  "tree-sitter-rust": "0.24.0",
  "tree-sitter-ruby": "0.23.1",
  "@ast-grep/napi": "0.51.3",
  "@ast-grep/lang-java": "0.0.7",
  "@ast-grep/lang-python": "0.0.6",
  "@ast-grep/lang-csharp": "0.0.6",
  "@ast-grep/lang-rust": "0.0.7",
  "@ast-grep/lang-ruby": "0.0.7",
};

/** The seed of the file sample (a date, chosen before any file was listed). */
export const SEED = 20240607;
/** Sample size per language. */
export const SAMPLE_SIZE = 15;
/** Files are eligible for the sample when they have between these many lines (so a person can read them all). */
export const MIN_LINES = 30;
export const MAX_LINES = 250;
