import { delimiter } from 'node:path'

/**
 * 环境变量目录列表拆分（`DAGENTS_SKILL_DIRS` / `DAGENTS_AGENT_LIBRARY_DIRS`）。
 *
 * 分隔符跟平台 PATH 约定走：POSIX 是 `:`，Windows 是 `;`。此前硬编码 `:`
 * 会把 Windows 路径 `C:\Users\x` 在盘符冒号处劈成 `C` 和 `\Users\x` ——
 * 目录扫描静默扫不到了（真机 Windows 复现，skills/library 全部漏扫）。
 * Windows 上也容忍 `:` 出现在单字符盘符前缀处（`C:/x` 正斜杠写法拆不开是
 * 无害的，因为整段只有一个路径）；POSIX 上 `;` 只是普通字符，不拆。
 */
export function splitDirList(raw: string | undefined): string[] {
  if (!raw) return []
  return raw
    .split(process.platform === 'win32' ? delimiter : ':')
    .map((d) => d.trim())
    .filter(Boolean)
}
