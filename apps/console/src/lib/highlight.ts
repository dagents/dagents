/**
 * The console's ONE syntax highlighter: a synchronous fine-grained shiki core
 * (JavaScript regex engine — no oniguruma WASM, bundle-friendly) with an
 * explicit grammar allowlist and a CSS-variables theme. Token colors live in
 * tokens.css as `--shiki-*` custom properties (light + dark), never here, so
 * highlighted and plain code blocks agree across themes.
 *
 * Ported from deepseek-harness `ui-primitives/markdown/highlight.ts`:
 *   - Boot grammars (typescript / shellscript / json) load synchronously at
 *     first use — the set every chat session renders.
 *   - The wider extension set loads lazily behind dynamic imports; the first
 *     render of a lazy language falls back to plain text while its grammar
 *     loads, then `subscribeGrammarLoaded` notifies subscribers to re-render.
 *   - Unknown or absent languages fall back to plain text — never an error.
 */

import { createHighlighterCoreSync, createCssVariablesTheme } from 'shiki/core'
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript'
import langTs from '@shikijs/langs/typescript'
import langBash from '@shikijs/langs/shellscript'
import langJson from '@shikijs/langs/json'
import type { HighlighterCore } from 'shiki/core'

/** A shiki grammar module's default export (a `LanguageRegistration[]`). */
type LangModule = { default: typeof langTs }

/** Grammars loaded at boot; the JS family aliases onto the TS grammar (JSX
 *  tokenizes approximately — accepted to keep the boot set to one grammar). */
const LANGS = [langTs, langBash, langJson]

/** Extension grammars behind dynamic imports so they stay out of the boot
 *  chunk until a fence of that language renders. Keyed by grammar id. */
const LAZY_GRAMMARS = new Map<string, () => Promise<LangModule>>([
  ['python', () => import('@shikijs/langs/python')],
  ['ruby', () => import('@shikijs/langs/ruby')],
  ['go', () => import('@shikijs/langs/go')],
  ['rust', () => import('@shikijs/langs/rust')],
  ['java', () => import('@shikijs/langs/java')],
  ['c', () => import('@shikijs/langs/c')],
  ['cpp', () => import('@shikijs/langs/cpp')],
  ['csharp', () => import('@shikijs/langs/csharp')],
  ['yaml', () => import('@shikijs/langs/yaml')],
  ['toml', () => import('@shikijs/langs/toml')],
  ['ini', () => import('@shikijs/langs/ini')],
  ['markdown', () => import('@shikijs/langs/markdown')],
  ['html', () => import('@shikijs/langs/html')],
  ['css', () => import('@shikijs/langs/css')],
  ['scss', () => import('@shikijs/langs/scss')],
  ['sql', () => import('@shikijs/langs/sql')],
  ['xml', () => import('@shikijs/langs/xml')],
  ['lua', () => import('@shikijs/langs/lua')],
])

/** Language ids (and aliases) the highlighter accepts; everything else
 *  renders plain. A Map so an assistant-authored fence label like
 *  `constructor` or `__proto__` must miss instead of resolving an inherited
 *  property and crashing the renderer inside shiki. */
const LANG_ALIASES = new Map<string, string>([
  ['typescript', 'typescript'],
  ['ts', 'typescript'],
  ['tsx', 'typescript'],
  ['typescriptreact', 'typescript'],
  ['javascript', 'typescript'],
  ['js', 'typescript'],
  ['jsx', 'typescript'],
  ['mjs', 'typescript'],
  ['cjs', 'typescript'],
  ['shellscript', 'shellscript'],
  ['bash', 'shellscript'],
  ['sh', 'shellscript'],
  ['shell', 'shellscript'],
  ['zsh', 'shellscript'],
  ['console', 'shellscript'],
  ['json', 'json'],
  ['jsonc', 'json'],
  ['py', 'python'],
  ['python', 'python'],
  ['rb', 'ruby'],
  ['ruby', 'ruby'],
  ['go', 'go'],
  ['golang', 'go'],
  ['rs', 'rust'],
  ['rust', 'rust'],
  ['java', 'java'],
  ['c', 'c'],
  ['cpp', 'cpp'],
  ['c++', 'cpp'],
  ['cs', 'csharp'],
  ['csharp', 'csharp'],
  ['yaml', 'yaml'],
  ['yml', 'yaml'],
  ['toml', 'toml'],
  ['ini', 'ini'],
  ['md', 'markdown'],
  ['markdown', 'markdown'],
  ['html', 'html'],
  ['css', 'css'],
  ['scss', 'scss'],
  ['sql', 'sql'],
  ['xml', 'xml'],
  ['lua', 'lua'],
])

/** All token colors resolve through `--shiki-*` custom properties (tokens.css). */
const cssVariablesTheme = createCssVariablesTheme({
  name: 'css-variables',
  variablePrefix: '--shiki-',
  fontStyle: true,
})

let singleton: HighlighterCore | undefined

function highlighter(): HighlighterCore {
  singleton ??= createHighlighterCoreSync({
    themes: [cssVariablesTheme],
    langs: LANGS,
    engine: createJavaScriptRegexEngine({ forgiving: true }),
  })
  return singleton
}

/** Grammar ids whose lazy import is in flight or done, so it is requested once. */
const requested = new Set<string>()
/** Subscribers re-rendered after a lazy grammar registers (React callers). */
const listeners = new Set<() => void>()
/** Bumped on each lazy-grammar load; the `useSyncExternalStore` snapshot. */
let loadCount = 0

/**
 * Subscribe to lazy-grammar load completions; `listener` fires after a lazy
 * grammar finishes registering, so a caller that rendered its plain fallback
 * can re-highlight. `useSyncExternalStore` subscribe signature.
 */
export function subscribeGrammarLoaded(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** The lazy-grammar load counter — `useSyncExternalStore` snapshot. Opaque. */
export function grammarLoadCount(): number {
  return loadCount
}

/**
 * Ensure the grammar `resolved` names is registered. Boot grammars and
 * already-loaded lazy grammars report ready synchronously; a lazy grammar
 * not yet loaded starts its import (once) and reports not-ready so the
 * caller renders plain until a listener fires.
 */
function ensureGrammar(resolved: string): boolean {
  const load = LAZY_GRAMMARS.get(resolved)
  if (load === undefined) return true
  if (highlighter().getLoadedLanguages().includes(resolved)) return true
  if (!requested.has(resolved)) {
    requested.add(resolved)
    void load().then((mod) => {
      highlighter().loadLanguageSync(mod.default)
      loadCount += 1
      for (const listener of listeners) listener()
    })
  }
  return false
}

// Engine + grammar construction is a long task (~100ms+); building it during
// the first code block's render would jank exactly when a stream completes.
// Warm the singleton in a deferred task at module load instead. `unref`
// (Node-only, e.g. during SSR) keeps a non-browser import from pinning the
// event loop.
const warmupTimer = setTimeout(() => { highlighter() }, 0)
;(warmupTimer as { unref?: () => void }).unref?.()

/**
 * Highlight `code` into shiki's HTML (a single `<pre class="shiki">` tree)
 * when `lang` maps to a registered grammar; `undefined` means the caller
 * renders its plain fallback.
 */
export function highlightToHtml(code: string, lang: string | undefined): string | undefined {
  const resolved = lang === undefined ? undefined : LANG_ALIASES.get(lang.toLowerCase())
  if (resolved === undefined) return undefined
  if (!ensureGrammar(resolved)) return undefined
  return highlighter().codeToHtml(code, { lang: resolved, theme: 'css-variables' })
}
