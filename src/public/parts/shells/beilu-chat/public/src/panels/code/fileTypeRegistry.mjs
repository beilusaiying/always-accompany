/**
 * File type registry shared by the explorer, picker, tabs, status bar and
 * preview router. Extension/name classification must stay here so the same
 * file cannot acquire different icons or capabilities in adjacent views.
 */

const TYPE_DEFINITIONS = [
  { kind: "javascript", extensions: ["js", "mjs", "cjs", "jsx"], iconKey: "script", languageLabel: "JavaScript", previewKind: "code", readMode: "text", editable: true },
  { kind: "typescript", extensions: ["ts", "mts", "cts", "tsx"], iconKey: "script", languageLabel: "TypeScript", previewKind: "code", readMode: "text", editable: true },
  { kind: "python", extensions: ["py", "pyw", "pyi"], iconKey: "python", languageLabel: "Python", previewKind: "code", readMode: "text", editable: true },
  { kind: "java", extensions: ["java"], iconKey: "code", languageLabel: "Java", previewKind: "code", readMode: "text", editable: true },
  { kind: "kotlin", extensions: ["kt", "kts"], iconKey: "code", languageLabel: "Kotlin", previewKind: "code", readMode: "text", editable: true },
  { kind: "go", extensions: ["go"], iconKey: "code", languageLabel: "Go", previewKind: "code", readMode: "text", editable: true },
  { kind: "rust", extensions: ["rs"], iconKey: "code", languageLabel: "Rust", previewKind: "code", readMode: "text", editable: true },
  { kind: "c", extensions: ["c", "h"], iconKey: "code", languageLabel: "C", previewKind: "code", readMode: "text", editable: true },
  { kind: "cpp", extensions: ["cc", "cpp", "cxx", "hh", "hpp", "hxx"], iconKey: "code", languageLabel: "C++", previewKind: "code", readMode: "text", editable: true },
  { kind: "csharp", extensions: ["cs", "csx"], iconKey: "code", languageLabel: "C#", previewKind: "code", readMode: "text", editable: true },
  { kind: "shell", extensions: ["sh", "bash", "zsh", "fish", "ps1", "psm1", "bat", "cmd"], iconKey: "zap", languageLabel: "Shell", previewKind: "code", readMode: "text", editable: true },
  { kind: "html", extensions: ["html", "htm"], iconKey: "earth", languageLabel: "HTML", previewKind: "html", readMode: "text", editable: true },
  { kind: "css", extensions: ["css", "scss", "sass", "less"], iconKey: "palette", languageLabel: "Stylesheet", previewKind: "code", readMode: "text", editable: true },
  { kind: "vue", extensions: ["vue"], iconKey: "web", languageLabel: "Vue", previewKind: "code", readMode: "text", editable: true },
  { kind: "svelte", extensions: ["svelte"], iconKey: "web", languageLabel: "Svelte", previewKind: "code", readMode: "text", editable: true },
  { kind: "json", extensions: ["json", "jsonc", "json5", "jsonl", "ndjson", "jsonlines"], iconKey: "clipboard", languageLabel: "JSON", previewKind: "code", readMode: "text", editable: true },
  { kind: "yaml", extensions: ["yaml", "yml"], iconKey: "clipboard", languageLabel: "YAML", previewKind: "code", readMode: "text", editable: true },
  { kind: "toml", extensions: ["toml"], iconKey: "settings", languageLabel: "TOML", previewKind: "code", readMode: "text", editable: true },
  { kind: "xml", extensions: ["xml", "xsl", "xslt", "plist"], iconKey: "code", languageLabel: "XML", previewKind: "code", readMode: "text", editable: true },
  { kind: "csv", extensions: ["csv", "tsv"], iconKey: "chart", languageLabel: "Delimited text", previewKind: "code", readMode: "text", editable: true },
  { kind: "sql", extensions: ["sql"], iconKey: "layers", languageLabel: "SQL", previewKind: "code", readMode: "text", editable: true },
  { kind: "markdown", extensions: ["md", "mdx", "markdown"], iconKey: "book", languageLabel: "Markdown", previewKind: "md", readMode: "text", editable: true },
  { kind: "text", extensions: ["txt", "text"], iconKey: "file", languageLabel: "Plain text", previewKind: "code", readMode: "text", editable: true },
  { kind: "log", extensions: ["log", "out"], iconKey: "file", languageLabel: "Log", previewKind: "code", readMode: "text", editable: true },
  { kind: "config", extensions: ["ini", "cfg", "conf", "config", "properties", "editorconfig"], iconKey: "settings", languageLabel: "Configuration", previewKind: "code", readMode: "text", editable: true },
  { kind: "environment", extensions: ["env"], iconKey: "key", languageLabel: "Environment", previewKind: "code", readMode: "text", editable: true },
  { kind: "git", extensions: ["git"], iconKey: "branch", languageLabel: "Git data", previewKind: "code", readMode: "text", editable: true },
  { kind: "svg", extensions: ["svg"], iconKey: "image", languageLabel: "SVG", previewKind: "svg", readMode: "text", editable: true },
  { kind: "image", extensions: ["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "avif"], iconKey: "image", languageLabel: "Image", previewKind: "image", readMode: "base64", editable: false, binary: true },
  { kind: "audio", extensions: ["mp3", "wav", "ogg", "oga", "flac", "m4a", "aac"], iconKey: "waves", languageLabel: "Audio", previewKind: "audio", readMode: "base64", editable: false, binary: true },
  { kind: "video", extensions: ["mp4", "webm", "mov", "mkv", "avi", "m4v"], iconKey: "camera", languageLabel: "Video", previewKind: "video", readMode: "base64", editable: false, binary: true },
  { kind: "pdf", extensions: ["pdf"], iconKey: "book", languageLabel: "PDF", previewKind: "pdf", readMode: "base64", editable: false, binary: true },
  { kind: "word", extensions: ["docx"], iconKey: "book", languageLabel: "Word document", previewKind: "doc", readMode: "extract", editable: false, binary: true },
  { kind: "spreadsheet", extensions: ["xlsx"], iconKey: "chart", languageLabel: "Spreadsheet", previewKind: "doc", readMode: "extract", editable: false, binary: true },
  { kind: "presentation", extensions: ["pptx"], iconKey: "cards", languageLabel: "Presentation", previewKind: "doc", readMode: "extract", editable: false, binary: true },
  { kind: "word", extensions: ["doc", "odt", "rtf"], iconKey: "book", languageLabel: "Word document", previewKind: "binary", readMode: "base64", editable: false, binary: true },
  { kind: "spreadsheet", extensions: ["xls", "ods"], iconKey: "chart", languageLabel: "Spreadsheet", previewKind: "binary", readMode: "base64", editable: false, binary: true },
  { kind: "presentation", extensions: ["ppt", "odp"], iconKey: "cards", languageLabel: "Presentation", previewKind: "binary", readMode: "base64", editable: false, binary: true },
  { kind: "archive", extensions: ["zip", "7z", "rar", "tar", "gz", "bz2", "xz", "tgz", "tbz2", "txz"], iconKey: "package", languageLabel: "Archive", previewKind: "binary", readMode: "base64", editable: false, binary: true },
  { kind: "font", extensions: ["ttf", "otf", "woff", "woff2", "eot"], iconKey: "abc", languageLabel: "Font", previewKind: "binary", readMode: "base64", editable: false, binary: true },
  { kind: "binary", extensions: ["bin", "dat", "exe", "dll", "so", "dylib", "class", "jar", "wasm"], iconKey: "lock", languageLabel: "Binary", previewKind: "binary", readMode: "base64", editable: false, binary: true },
];

const FILE_NAME_TYPES = new Map([
  ["dockerfile", { kind: "config", iconKey: "settings", languageLabel: "Dockerfile", previewKind: "code", readMode: "text", editable: true }],
  ["makefile", { kind: "config", iconKey: "settings", languageLabel: "Makefile", previewKind: "code", readMode: "text", editable: true }],
  ["license", { kind: "text", iconKey: "file", languageLabel: "License", previewKind: "code", readMode: "text", editable: true }],
  ["readme", { kind: "markdown", iconKey: "book", languageLabel: "Markdown", previewKind: "md", readMode: "text", editable: true }],
  [".gitignore", { kind: "git", iconKey: "branch", languageLabel: "Git ignore", previewKind: "code", readMode: "text", editable: true }],
  [".gitattributes", { kind: "git", iconKey: "branch", languageLabel: "Git attributes", previewKind: "code", readMode: "text", editable: true }],
  [".gitmodules", { kind: "git", iconKey: "branch", languageLabel: "Git modules", previewKind: "code", readMode: "text", editable: true }],
  [".dockerignore", { kind: "config", iconKey: "branch", languageLabel: "Docker ignore", previewKind: "code", readMode: "text", editable: true }],
  [".prettierignore", { kind: "config", iconKey: "branch", languageLabel: "Prettier ignore", previewKind: "code", readMode: "text", editable: true }],
  [".eslintignore", { kind: "config", iconKey: "branch", languageLabel: "ESLint ignore", previewKind: "code", readMode: "text", editable: true }],
  [".npmignore", { kind: "config", iconKey: "branch", languageLabel: "npm ignore", previewKind: "code", readMode: "text", editable: true }],
  [".editorconfig", { kind: "config", iconKey: "settings", languageLabel: "EditorConfig", previewKind: "code", readMode: "text", editable: true }],
  [".npmrc", { kind: "config", iconKey: "settings", languageLabel: "npm configuration", previewKind: "code", readMode: "text", editable: true }],
  [".yarnrc", { kind: "config", iconKey: "settings", languageLabel: "Yarn configuration", previewKind: "code", readMode: "text", editable: true }],
  [".prettierrc", { kind: "config", iconKey: "settings", languageLabel: "Prettier configuration", previewKind: "code", readMode: "text", editable: true }],
  [".eslintrc", { kind: "config", iconKey: "settings", languageLabel: "ESLint configuration", previewKind: "code", readMode: "text", editable: true }],
  [".babelrc", { kind: "config", iconKey: "settings", languageLabel: "Babel configuration", previewKind: "code", readMode: "text", editable: true }],
  [".browserslistrc", { kind: "config", iconKey: "settings", languageLabel: "Browserslist configuration", previewKind: "code", readMode: "text", editable: true }],
  [".stylelintrc", { kind: "config", iconKey: "settings", languageLabel: "Stylelint configuration", previewKind: "code", readMode: "text", editable: true }],
  [".nvmrc", { kind: "config", iconKey: "settings", languageLabel: "Node version", previewKind: "code", readMode: "text", editable: true }],
  [".node-version", { kind: "config", iconKey: "settings", languageLabel: "Node version", previewKind: "code", readMode: "text", editable: true }],
  [".tool-versions", { kind: "config", iconKey: "settings", languageLabel: "Tool versions", previewKind: "code", readMode: "text", editable: true }],
  [".env", { kind: "environment", iconKey: "key", languageLabel: "Environment", previewKind: "code", readMode: "text", editable: true }],
  ["cmakelists.txt", { kind: "config", iconKey: "code", languageLabel: "CMake", previewKind: "code", readMode: "text", editable: true }],
  ["gemfile", { kind: "config", iconKey: "code", languageLabel: "Gemfile", previewKind: "code", readMode: "text", editable: true }],
  ["rakefile", { kind: "config", iconKey: "code", languageLabel: "Rakefile", previewKind: "code", readMode: "text", editable: true }],
  ["procfile", { kind: "config", iconKey: "code", languageLabel: "Procfile", previewKind: "code", readMode: "text", editable: true }],
  ["vagrantfile", { kind: "config", iconKey: "code", languageLabel: "Vagrantfile", previewKind: "code", readMode: "text", editable: true }],
  ["pipfile", { kind: "config", iconKey: "code", languageLabel: "Pipfile", previewKind: "code", readMode: "text", editable: true }],
  ["go.mod", { kind: "config", iconKey: "code", languageLabel: "Go module", previewKind: "code", readMode: "text", editable: true }],
  ["go.sum", { kind: "config", iconKey: "code", languageLabel: "Go checksums", previewKind: "code", readMode: "text", editable: true }],
  ["cargo.lock", { kind: "config", iconKey: "code", languageLabel: "Cargo lockfile", previewKind: "code", readMode: "text", editable: true }],
]);

const EXTENSION_TYPES = new Map();
for (const definition of TYPE_DEFINITIONS) {
  const normalized = Object.freeze({ binary: false, ...definition, extensions: Object.freeze([...definition.extensions]) });
  for (const extension of normalized.extensions) {
    if (EXTENSION_TYPES.has(extension)) {
      throw new Error(`Duplicate file type extension registered: ${extension}`);
    }
    EXTENSION_TYPES.set(extension, normalized);
  }
}

const FOLDER_TYPE = Object.freeze({
  kind: "folder",
  iconKey: "folder",
  openIconKey: "folder-open",
  languageLabel: "Folder",
  previewKind: "folder",
  readMode: "none",
  editable: false,
  binary: false,
  readonly: false,
});

const UNKNOWN_TYPE = Object.freeze({
  kind: "unknown",
  iconKey: "file",
  languageLabel: "Auto / 待检测",
  previewKind: "unknown",
  readMode: "auto",
  editable: false,
  binary: false,
  readonly: false,
  detectionPending: true,
  extensions: Object.freeze([]),
});

const DETECTED_TEXT_TYPE = Object.freeze({
  kind: "text",
  iconKey: "file",
  languageLabel: "Plain text (detected)",
  previewKind: "code",
  readMode: "auto",
  editable: true,
  binary: false,
  readonly: false,
  extensions: Object.freeze([]),
});

const DETECTED_BINARY_TYPE = Object.freeze({
  kind: "binary",
  iconKey: "lock",
  languageLabel: "Binary (detected)",
  previewKind: "binary",
  readMode: "auto",
  editable: false,
  binary: true,
  readonly: true,
  extensions: Object.freeze([]),
});

function getExtension(fileName) {
  const normalized = String(fileName || "").replace(/\\/g, "/").split("/").pop()?.toLowerCase() || "";
  const parts = normalized.split(".");
  if (parts.length < 2 || (parts.length === 2 && parts[0] === "")) return "";
  return parts.pop() || "";
}

/** Resolve a filename to the immutable UI/preview contract used by every file view. */
export function getFileType(fileName, { isDirectory = false, isOpen = false } = {}) {
  if (isDirectory) {
    return Object.freeze({ ...FOLDER_TYPE, iconKey: isOpen ? FOLDER_TYPE.openIconKey : FOLDER_TYPE.iconKey });
  }

  const normalizedName = String(fileName || "").replace(/\\/g, "/").split("/").pop()?.toLowerCase() || "";
  let definition = FILE_NAME_TYPES.get(normalizedName);
  if (!definition && normalizedName.startsWith(".env.")) definition = FILE_NAME_TYPES.get(".env");
  if (!definition && normalizedName.startsWith("readme.")) definition = TYPE_DEFINITIONS.find((type) => type.kind === "markdown");
  if (!definition) definition = EXTENSION_TYPES.get(getExtension(normalizedName));
  if (!definition) return UNKNOWN_TYPE;

  return Object.freeze({
    binary: false,
    ...definition,
    readonly: definition.editable !== true,
  });
}

/**
 * Resolve an extension-less/custom file after the backend has inspected its
 * bytes.  Detection is deliberately not duplicated in the browser: the
 * backend owns the UTF-8/NUL/size contract and the UI only projects its result.
 */
export function getDetectedFileType(detectedKind) {
  if (detectedKind === "text") return DETECTED_TEXT_TYPE;
  if (detectedKind === "binary") return DETECTED_BINARY_TYPE;
  throw new TypeError(`Unsupported detected file kind: ${String(detectedKind)}`);
}

/**
 * Render only a registered local icon key; toolbar/action icons stay outside
 * this registry.  A detected tab type may be supplied so adjacent consumers
 * do not throw away byte detection and reclassify the same path by extension.
 */
export function getFileTypeIconMarkup(fileName, options = {}) {
  const type = options.fileType || getFileType(fileName, options);
  return `<i data-ic="${type.iconKey}" aria-hidden="true"></i>`;
}

/** Exposed for static audits and future tab/status consumers; callers must not mutate it. */
export const FILE_TYPE_DEFINITIONS = Object.freeze(TYPE_DEFINITIONS.map((definition) => Object.freeze({
  ...definition,
  extensions: Object.freeze([...definition.extensions]),
})));
