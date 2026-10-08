/** SQL text helpers shared by the Monaco completion provider and its tests. */

/** Return closed single-quoted SQL literals, ignoring comments and escaped quotes. */
export function extractSqlStringLiterals(sql: string): string[] {
  const values: string[] = []
  let inBlockComment = false
  for (const line of sql.split(/\r?\n/)) {
    const result = scanSqlStringLine(line, inBlockComment)
    values.push(...result.values)
    inBlockComment = result.inBlockComment
  }
  return values
}

/** Parse one line, carrying only the block-comment state from the prior line. */
export function scanSqlStringLine(
  line: string,
  initialBlockComment = false
): { values: string[]; inBlockComment: boolean } {
  const values: string[] = []
  let value = ''
  let inString = false
  let inLineComment = false
  let inBlockComment = initialBlockComment

  for (let i = 0; i < line.length; i++) {
    const char = line[i]
    const next = line[i + 1]
    if (inLineComment) break
    if (inBlockComment) {
      if (char === '*' && next === '/') {
        inBlockComment = false
        i++
      }
      continue
    }
    if (inString) {
      if (char === '\\' && next === "'") {
        value += "'"
        i++
      } else if (char === "'" && next === "'") {
        value += "'"
        i++
      } else if (char === "'") {
        if (value) values.push(value)
        value = ''
        inString = false
      } else {
        value += char
      }
      continue
    }

    if (char === '-' && next === '-') {
      inLineComment = true
    } else if (char === '#') {
      inLineComment = true
    } else if (char === '/' && next === '*') {
      inBlockComment = true
      i++
    } else if (char === "'") {
      inString = true
    }
  }

  return { values, inBlockComment }
}

/** Detect an open single-quoted value at a 1-based Monaco cursor column. */
export function getSingleQuotedPrefix(
  line: string,
  cursorColumn: number,
  initialBlockComment = false
): { prefix: string; startColumn: number } | null {
  const limit = Math.max(0, Math.min(line.length, cursorColumn - 1))
  let quoteStart = -1
  let inBlockComment = initialBlockComment

  for (let i = 0; i < limit; i++) {
    const char = line[i]
    const next = line[i + 1]

    if (inBlockComment) {
      if (char === '*' && next === '/') {
        inBlockComment = false
        i++
      }
      continue
    }
    if (quoteStart >= 0) {
      if (char === '\\' && next === "'") {
        i++
      } else if (char === "'" && next === "'") {
        i++
      } else if (char === "'") {
        quoteStart = -1
      }
      continue
    }
    if (char === '-' && next === '-') return null
    if (char === '#') return null
    if (char === '/' && next === '*') {
      inBlockComment = true
      i++
    } else if (char === "'") {
      quoteStart = i
    }
  }

  if (quoteStart < 0) return null
  const rawPrefix = line.slice(quoteStart + 1, limit)
  return { prefix: rawPrefix.replace(/\\'/g, "'").replace(/''/g, "'"), startColumn: quoteStart + 2 }
}

/** True when the cursor is in a SQL line/block comment (block state may cross lines). */
export function isSqlCommentPosition(line: string, cursorColumn: number, initialBlockComment = false): boolean {
  const limit = Math.max(0, Math.min(line.length, cursorColumn - 1))
  let inBlockComment = initialBlockComment
  let inString = false
  for (let i = 0; i < limit; i++) {
    const char = line[i]
    const next = line[i + 1]
    if (inBlockComment) {
      if (char === '*' && next === '/') {
        inBlockComment = false
        i++
      }
    } else if (inString) {
      if (char === '\\' && next === "'") i++
      else if (char === "'" && next === "'") i++
      else if (char === "'") inString = false
    } else if (char === '-' && next === '-') {
      return true
    } else if (char === '#') {
      return true
    } else if (char === '/' && next === '*') {
      inBlockComment = true
      i++
    } else if (char === "'") {
      inString = true
    }
  }
  return inBlockComment
}

/** Whether the current SQL cursor context should auto-open completion after typing. */
export function shouldAutoTriggerSqlCompletion(line: string, cursorColumn: number, initialBlockComment = false): boolean {
  if (isSqlCommentPosition(line, cursorColumn, initialBlockComment)) return false
  const literal = getSingleQuotedPrefix(line, cursorColumn, initialBlockComment)
  if (literal) return literal.prefix.length > 0
  const before = line.slice(0, cursorColumn - 1)
  return /[A-Za-z0-9_$]+(?:\.[A-Za-z0-9_$]*)?$/.test(before)
}

/** Prefix-match string values without changing their case; preserve first-seen order. */
export function filterSqlStringValues(values: Iterable<string>, prefix: string, limit = 30): string[] {
  if (!prefix) return []
  const matches: string[] = []
  const seen = new Set<string>()
  for (const value of values) {
    if (!value.startsWith(prefix) || seen.has(value)) continue
    seen.add(value)
    matches.push(value)
    if (matches.length >= limit) break
  }
  return matches
}
