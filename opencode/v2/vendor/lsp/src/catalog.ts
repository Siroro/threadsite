/**
 * Built-in extension defaults for language server IDs. A config entry
 * like `{ "rust": { "command": ["rust-analyzer"] } }` needs extensions inferred
 * from its server ID. Custom (non-builtin) IDs must declare
 * `extensions` themselves.
 */
export const BUILTIN_EXTENSIONS: Record<string, string[]> = {
  deno: [".ts", ".tsx", ".js", ".jsx", ".mjs"],
  typescript: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"],
  vue: [".vue"],
  eslint: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts", ".vue"],
  oxlint: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts", ".vue", ".astro", ".svelte"],
  biome: [
    ".ts",
    ".tsx",
    ".js",
    ".jsx",
    ".mjs",
    ".cjs",
    ".mts",
    ".cts",
    ".json",
    ".jsonc",
    ".vue",
    ".astro",
    ".svelte",
    ".css",
    ".graphql",
    ".gql",
    ".html",
  ],
  gopls: [".go"],
  "ruby-lsp": [".rb", ".rake", ".gemspec", ".ru"],
  ty: [".py", ".pyi"],
  pyright: [".py", ".pyi"],
  "elixir-ls": [".ex", ".exs"],
  zls: [".zig", ".zon"],
  csharp: [".cs", ".csx"],
  razor: [".razor", ".cshtml"],
  fsharp: [".fs", ".fsi", ".fsx", ".fsscript"],
  "sourcekit-lsp": [".swift", ".objc", ".objcpp"],
  rust: [".rs"],
  clangd: [".c", ".cpp", ".cc", ".cxx", ".c++", ".h", ".hpp", ".hh", ".hxx", ".h++"],
  svelte: [".svelte"],
  astro: [".astro"],
  jdtls: [".java"],
  "kotlin-ls": [".kt", ".kts"],
  "yaml-ls": [".yaml", ".yml"],
  "lua-ls": [".lua"],
  "php intelephense": [".php"],
  prisma: [".prisma"],
  dart: [".dart"],
  "ocaml-lsp": [".ml", ".mli"],
  bash: [".sh", ".bash", ".zsh", ".ksh"],
  terraform: [".tf", ".tfvars"],
  texlab: [".tex", ".bib"],
  dockerfile: [".dockerfile", "Dockerfile"],
  gleam: [".gleam"],
  "clojure-lsp": [".clj", ".cljs", ".cljc", ".edn"],
  nixd: [".nix"],
  tinymist: [".typ", ".typc"],
  "haskell-language-server": [".hs", ".lhs"],
  julials: [".jl"],
}

const LOCKFILES = ["package-lock.json", "bun.lockb", "bun.lock", "pnpm-lock.yaml", "yarn.lock"]
const PYTHON = ["pyproject.toml", "setup.py", "setup.cfg", "requirements.txt", "Pipfile", "pyrightconfig.json"]

export interface RootRule {
  /** The nearest directory holding one of these is the root; without one it is the project directory. */
  readonly markers: string[]
  /** A file below one of these skips the server. */
  readonly exclude?: string[]
  /** Without a marker the server does not apply, instead of running at the project directory. */
  readonly required?: boolean
}

/**
 * Per-server roots, searched from the file's directory up to the
 * project directory. IDs not listed here, including custom IDs, run at the
 * project directory. Markers use exact file names rather than glob patterns.
 */
export const BUILTIN_ROOTS: Record<string, RootRule> = {
  deno: { markers: ["deno.json", "deno.jsonc"], required: true },
  typescript: { markers: LOCKFILES, exclude: ["deno.json", "deno.jsonc"] },
  vue: { markers: LOCKFILES },
  eslint: { markers: LOCKFILES },
  oxlint: { markers: [".oxlintrc.json", ...LOCKFILES, "package.json"] },
  biome: { markers: ["biome.json", "biome.jsonc", ...LOCKFILES] },
  // gopls discovers modules when go.work is absent.
  gopls: { markers: ["go.work"] },
  "ruby-lsp": { markers: ["Gemfile"] },
  ty: { markers: [...PYTHON, "ty.toml"] },
  pyright: { markers: PYTHON },
  "elixir-ls": { markers: ["mix.exs", "mix.lock"] },
  zls: { markers: ["build.zig"] },
  csharp: { markers: ["global.json"] },
  fsharp: { markers: ["global.json"] },
  "sourcekit-lsp": { markers: ["Package.swift"] },
  // The nearest crate, widened to an enclosing Cargo workspace by the manager.
  rust: { markers: ["Cargo.toml", "Cargo.lock"] },
  clangd: { markers: ["compile_commands.json", "compile_flags.txt", ".clangd"] },
  svelte: { markers: LOCKFILES },
  astro: { markers: LOCKFILES },
  "kotlin-ls": { markers: ["settings.gradle.kts", "settings.gradle"] },
  "yaml-ls": { markers: LOCKFILES },
  "lua-ls": { markers: [".luarc.json", ".luarc.jsonc", ".luacheckrc", ".stylua.toml", "stylua.toml", "selene.toml", "selene.yml"] },
  "php intelephense": { markers: ["composer.json", "composer.lock", ".php-version"] },
  // Prisma runs in npm projects too; package.json is not an exclusion marker.
  prisma: { markers: ["schema.prisma", "prisma"] },
  dart: { markers: ["pubspec.yaml", "analysis_options.yaml"] },
  "ocaml-lsp": { markers: ["dune-project", "dune-workspace", ".merlin", "opam"] },
  terraform: { markers: [".terraform.lock.hcl", "terraform.tfstate"] },
  texlab: { markers: [".latexmkrc", "latexmkrc", ".texlabroot", "texlabroot"] },
  gleam: { markers: ["gleam.toml"] },
  "haskell-language-server": { markers: ["stack.yaml", "cabal.project", "hie.yaml"] },
  julials: { markers: ["Project.toml", "Manifest.toml"] },
}

/** Extension to LSP `languageId`, used for `textDocument/didOpen`. */
export const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  // TypeScript / JavaScript
  ".ts": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".tsx": "typescriptreact",
  ".js": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".jsx": "javascriptreact",
  // Vue / Svelte / Astro
  ".vue": "vue",
  ".svelte": "svelte",
  ".astro": "astro",
  // JSON / CSS / GraphQL / HTML
  ".json": "json",
  ".jsonc": "jsonc",
  ".css": "css",
  ".graphql": "graphql",
  ".gql": "graphql",
  ".html": "html",
  // Rust / Go / Python / Java / Kotlin
  ".rs": "rust",
  ".go": "go",
  ".py": "python",
  ".pyi": "python",
  ".java": "java",
  ".kt": "kotlin",
  ".kts": "kotlin",
  // Ruby / PHP / C# / Razor / F#
  ".rb": "ruby",
  ".rake": "ruby",
  ".gemspec": "ruby",
  ".ru": "ruby",
  ".php": "php",
  ".cs": "csharp",
  ".csx": "csharp",
  ".razor": "razor",
  ".cshtml": "razor",
  ".fs": "fsharp",
  ".fsi": "fsharp",
  ".fsx": "fsharp",
  ".fsscript": "fsharp",
  // C / C++ / Objective-C / Swift
  ".c": "c",
  ".h": "c",
  ".cpp": "cpp",
  ".cc": "cpp",
  ".cxx": "cpp",
  ".c++": "cpp",
  ".hpp": "cpp",
  ".hh": "cpp",
  ".hxx": "cpp",
  ".h++": "cpp",
  ".objc": "objective-c",
  ".objcpp": "objective-cpp",
  ".swift": "swift",
  // Other languages
  ".zig": "zig",
  ".zon": "zig",
  ".lua": "lua",
  ".yaml": "yaml",
  ".yml": "yaml",
  ".sh": "shellscript",
  ".bash": "shellscript",
  ".zsh": "shellscript",
  ".ksh": "shellscript",
  ".tf": "terraform",
  ".tfvars": "terraform-vars",
  ".ex": "elixir",
  ".exs": "elixir",
  ".clj": "clojure",
  ".cljs": "clojure",
  ".cljc": "clojure",
  ".edn": "clojure",
  ".ml": "ocaml",
  ".mli": "ocaml",
  ".nix": "nix",
  ".tex": "latex",
  ".bib": "bibtex",
  ".typ": "typst",
  ".typc": "typst-code",
  ".dart": "dart",
  ".prisma": "prisma",
  ".gleam": "gleam",
  ".hs": "haskell",
  ".lhs": "haskell",
  ".jl": "julia",
  ".dockerfile": "dockerfile",
}

export function languageIdForExtension(extension: string): string {
  return LANGUAGE_BY_EXTENSION[extension.toLowerCase()] ?? extension.replace(/^\./, "")
}
