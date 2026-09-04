#!/usr/bin/env node
/**
 * FlowSync 落地页构建脚本
 * - Tailwind v4 编译 src/style.css（扫描 src/page.html）
 * - woff2 字体 base64 内嵌为 @font-face
 * - CSS + 字体注入 src/page.html → index.html（单文件产物）
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(fileURLToPath(import.meta.url));
const tw = path.join(root, 'node_modules/.bin/tailwindcss');
const src = p => path.join(root, 'src', p);

// 1. Tailwind 编译（minify）
const css = execFileSync(tw, ['-i', src('style.css'), '--content', src('page.html'), '--minify'], {
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024,
});

// 2. 字体内嵌
const fonts = [
  { file: 'space-grotesk-latin-500-normal.woff2', family: 'Space Grotesk', weight: 500 },
  { file: 'space-grotesk-latin-700-normal.woff2', family: 'Space Grotesk', weight: 700 },
  { file: 'jetbrains-mono-latin-400-normal.woff2', family: 'JetBrains Mono', weight: 400 },
  { file: 'jetbrains-mono-latin-500-normal.woff2', family: 'JetBrains Mono', weight: 500 },
];
const fontFace = fonts
  .map(f => {
    const b64 = readFileSync(path.join(root, 'assets', f.file)).toString('base64');
    return `@font-face{font-family:'${f.family}';font-style:normal;font-weight:${f.weight};font-display:swap;src:url(data:font/woff2;base64,${b64}) format('woff2');unicode-range:U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD;}`;
  })
  .join('\n');

// 3. 注入模板（@font-face 直接前置——Tailwind minify 会剥掉 CSS 内的注释占位符）
const finalCss = fontFace + '\n' + css;
let html = readFileSync(src('page.html'), 'utf8');
html = html.replace('/*__CSS__*/', () => finalCss);

writeFileSync(path.join(root, 'index.html'), html);
const kb = (Buffer.byteLength(html) / 1024).toFixed(1);
console.log(`index.html written (${kb} KB)`);
