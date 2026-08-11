import { describe, it, expect } from 'vitest'
import {
  parseMessageContent,
  classifyTool,
  extractSummary,
  shortenPath,
  isFileChangeTool,
  type MessageSegment,
} from './tool-call-parser'

describe('tool-call-parser', () => {
  describe('classifyTool', () => {
    it('classifies read/view/glob/grep as search', () => {
      expect(classifyTool('Read')).toBe('search')
      expect(classifyTool('View')).toBe('search')
      expect(classifyTool('Glob')).toBe('search')
      expect(classifyTool('Grep')).toBe('search')
      expect(classifyTool('SearchFiles')).toBe('search')
    })

    it('classifies write/edit/create as edit', () => {
      expect(classifyTool('Write')).toBe('edit')
      expect(classifyTool('Edit')).toBe('edit')
      expect(classifyTool('Create')).toBe('edit')
      expect(classifyTool('MultiEdit')).toBe('edit')
      expect(classifyTool('Replace')).toBe('edit')
    })

    it('classifies bash/execute/command as terminal', () => {
      expect(classifyTool('Bash')).toBe('terminal')
      expect(classifyTool('Execute')).toBe('terminal')
      expect(classifyTool('Command')).toBe('terminal')
      expect(classifyTool('RunScript')).toBe('terminal')
    })

    it('falls back to tool for unknown names', () => {
      expect(classifyTool('Task')).toBe('tool')
      expect(classifyTool('WebFetch')).toBe('tool')
      expect(classifyTool('MCP')).toBe('tool')
    })

    it('matches case-insensitively', () => {
      expect(classifyTool('read')).toBe('search')
      expect(classifyTool('BASH')).toBe('terminal')
      expect(classifyTool('eDiT')).toBe('edit')
    })
  })

  describe('shortenPath', () => {
    it('returns short paths verbatim', () => {
      expect(shortenPath('foo.ts')).toBe('foo.ts')
      expect(shortenPath('a/b.ts')).toBe('a/b.ts')
      expect(shortenPath('a/b/c.ts')).toBe('a/b/c.ts')
    })

    it('shortens long paths to .../last-two-segments', () => {
      expect(shortenPath('/Users/x/projects/foo/src/index.ts')).toBe('.../src/index.ts')
    })
  })

  describe('extractSummary', () => {
    it('extracts query', () => {
      expect(extractSummary({ query: 'how to parse json' })).toBe('how to parse json')
    })

    it('extracts and shortens file_path', () => {
      expect(extractSummary({ file_path: '/a/b/c/d.txt' })).toBe('.../c/d.txt')
    })

    it('extracts path when file_path absent', () => {
      expect(extractSummary({ path: 'a/b/c.txt' })).toBe('a/b/c.txt')
    })

    it('extracts pattern', () => {
      expect(extractSummary({ pattern: '*.ts' })).toBe('*.ts')
    })

    it('extracts url', () => {
      expect(extractSummary({ url: 'https://example.com' })).toBe('https://example.com')
    })

    it('extracts and truncates long commands', () => {
      const long = 'git '.repeat(50)
      const summary = extractSummary({ command: long })
      expect(summary.endsWith('…')).toBe(true)
      expect(summary.length).toBeLessThanOrEqual(121)
    })

    it('extracts description', () => {
      expect(extractSummary({ description: 'a search step' })).toBe('a search step')
    })

    it('extracts skill', () => {
      expect(extractSummary({ skill: 'dagents-patterns' })).toBe('dagents-patterns')
    })

    it('returns empty for undefined input', () => {
      expect(extractSummary(undefined)).toBe('')
    })

    it('returns empty for object with no recognized fields', () => {
      expect(extractSummary({ count: 5, flag: true })).toBe('')
    })

    it('falls back to first short string value', () => {
      expect(extractSummary({ custom: 'hello' })).toBe('hello')
    })
  })

  describe('parseMessageContent', () => {
    it('returns empty array for empty input', () => {
      expect(parseMessageContent('')).toEqual([])
    })

    it('parses plain text as a single text segment', () => {
      const segs = parseMessageContent('hello world')
      expect(segs).toHaveLength(1)
      expect(segs[0].type).toBe('text')
      if (segs[0].type === 'text') expect(segs[0].content).toBe('hello world')
    })

    it('parses a [thinking] tag', () => {
      const segs = parseMessageContent('[thinking]deep thoughts[/thinking]')
      expect(segs).toHaveLength(1)
      expect(segs[0].type).toBe('thinking')
      if (segs[0].type === 'thinking') {
        expect(segs[0].content).toBe('deep thoughts')
        expect(segs[0].inProgress).toBeUndefined()
      }
    })

    it('parses a [tool:Name]{json}[/tool] tag', () => {
      const segs = parseMessageContent('[tool:Bash]{"command":"ls -la"}[/tool]')
      expect(segs).toHaveLength(1)
      expect(segs[0].type).toBe('tool-call')
      if (segs[0].type === 'tool-call') {
        expect(segs[0].toolName).toBe('Bash')
        expect(segs[0].toolInput).toEqual({ command: 'ls -la' })
        expect(segs[0].summary).toBe('ls -la')
        expect(segs[0].category).toBe('terminal')
        expect(segs[0].inProgress).toBeUndefined()
      }
    })

    it('parses a [tool:Read] tag as search category', () => {
      const segs = parseMessageContent('[tool:Read]{"file_path":"/a/b/c.ts"}[/tool]')
      expect(segs).toHaveLength(1)
      if (segs[0].type === 'tool-call') {
        expect(segs[0].category).toBe('search')
        expect(segs[0].summary).toBe('.../b/c.ts')
      }
    })

    it('parses a [tool:Write] tag as edit category', () => {
      const segs = parseMessageContent('[tool:Write]{"file_path":"/x.ts","content":"abc"}[/tool]')
      expect(segs).toHaveLength(1)
      if (segs[0].type === 'tool-call') {
        expect(segs[0].category).toBe('edit')
      }
    })

    it('parses a tool with no input', () => {
      const segs = parseMessageContent('[tool:SomeTool][/tool]')
      expect(segs).toHaveLength(1)
      if (segs[0].type === 'tool-call') {
        expect(segs[0].toolName).toBe('SomeTool')
        expect(segs[0].toolInput).toBeUndefined()
        expect(segs[0].summary).toBe('')
      }
    })

    it('parses a [tool-result] tag', () => {
      const segs = parseMessageContent('[tool-result]the output text[/tool-result]')
      expect(segs).toHaveLength(1)
      expect(segs[0].type).toBe('tool-result')
      if (segs[0].type === 'tool-result') {
        expect(segs[0].content).toBe('the output text')
      }
    })

    it('parses an [error] tag', () => {
      const segs = parseMessageContent('[error]something broke[/error]')
      expect(segs).toHaveLength(1)
      expect(segs[0].type).toBe('error')
      if (segs[0].type === 'error') expect(segs[0].content).toBe('something broke')
    })

    it('drops [status] and [log] tags as noise', () => {
      const segs = parseMessageContent(
        '[status]started[/status]\n[log]a line[/log]\nreal text',
      )
      // only the trailing "real text" survives
      expect(segs).toHaveLength(1)
      expect(segs[0].type).toBe('text')
      if (segs[0].type === 'text') expect(segs[0].content).toBe('real text')
    })

    it('parses mixed content into ordered segments', () => {
      const input =
        'Starting now.\n[thinking]planning[/thinking]\n[tool:Bash]{"command":"pwd"}[/tool]\n[tool-result]/home[/tool-result]\nDone.'
      const segs = parseMessageContent(input)
      expect(segs.map((s) => s.type)).toEqual([
        'text',
        'thinking',
        'tool-call',
        'tool-result',
        'text',
      ])
    })

    it('trims whitespace-only text runs between tags', () => {
      const segs = parseMessageContent('[thinking]a[/thinking]\n\n   \n[thinking]b[/thinking]')
      expect(segs).toHaveLength(2)
      expect(segs[0].type).toBe('thinking')
      expect(segs[1].type).toBe('thinking')
    })

    it('handles a streaming-partial tool call (no closing tag)', () => {
      const segs = parseMessageContent('text before [tool:Bash]{"command":"git st')
      expect(segs).toHaveLength(2)
      expect(segs[0].type).toBe('text')
      expect(segs[1].type).toBe('tool-call')
      if (segs[1].type === 'tool-call') {
        expect(segs[1].toolName).toBe('Bash')
        expect(segs[1].inProgress).toBe(true)
      }
    })

    it('handles a streaming-partial thinking tag', () => {
      const segs = parseMessageContent('[thinking]half a thought')
      expect(segs).toHaveLength(1)
      if (segs[0].type === 'thinking') {
        expect(segs[0].inProgress).toBe(true)
        expect(segs[0].content).toBe('half a thought')
      }
    })

    it('handles a streaming-partial tool-result tag', () => {
      const segs = parseMessageContent('[tool-result]partial output')
      expect(segs).toHaveLength(1)
      if (segs[0].type === 'tool-result') {
        expect(segs[0].inProgress).toBe(true)
      }
    })

    it('handles a partial tool with malformed (incomplete) JSON', () => {
      // The body is not yet complete JSON — parser must not throw.
      const segs = parseMessageContent('[tool:Read]{"file_path":"/a')
      expect(segs).toHaveLength(1)
      if (segs[0].type === 'tool-call') {
        expect(segs[0].inProgress).toBe(true)
        expect(segs[0].toolInput).toBeUndefined()
      }
    })
  })

  describe('isFileChangeTool', () => {
    const editSeg = (input: Record<string, unknown>): Extract<MessageSegment, { type: 'tool-call' }> => ({
      type: 'tool-call',
      content: '',
      toolName: 'Edit',
      toolInput: input,
      summary: extractSummary(input),
      category: 'edit',
    })

    it('returns true for edit tools with old_string/new_string', () => {
      expect(isFileChangeTool(editSeg({ old_string: 'a', new_string: 'b', file_path: '/x' }))).toBe(true)
    })

    it('returns true for edit tools with only content + file_path', () => {
      expect(isFileChangeTool(editSeg({ content: 'abc', file_path: '/x' }))).toBe(true)
    })

    it('returns false for non-edit category tools', () => {
      const bashSeg = {
        ...editSeg({ command: 'ls' }),
        category: 'terminal' as const,
        toolName: 'Bash',
      }
      expect(isFileChangeTool(bashSeg)).toBe(false)
    })

    it('returns false for edit tools with no diff-relevant fields', () => {
      expect(isFileChangeTool(editSeg({ description: 'something' }))).toBe(false)
    })
  })
})
